import { randomUUID } from "node:crypto";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailWarnDigests, openMailer, teamPageWrite, type CiCaller, type Mailer, type WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { changesOf, CONTRACT_WORKFLOW, PAYMENTS_REPOSITORY, reportOf, runDueUpdates, type ClassifiedChange } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// Potentially breaking changes go to a daily digest (contract-changes:
// Potentially breaking changes go to a daily digest; requester-loop: The web
// inbox; requester-loop: Email for people, only when SMTP is set; design.md,
// Decisions this change rests on: D28 #61, #72, #73; D29 (6); design.md,
// Self-hosting decisions: S10). A report whose WARN-level changes open no
// request, because the API's WARN switch is off, lists them in the daily WARN
// digest of each team that declared it consumes the API: once the UTC day
// ends, the digest is listed in the standing list of the web inbox of each
// member of the team, and, when SMTP is set, emailed to each member who has
// not turned the daily digest off. With the WARN switch on, WARN-level changes
// open and update requests as ERR-level ones do. An admin, or a member of the
// API's provider team, flips the switch; anyone else gets 403. The reports
// come through the real contract.report, and the worker's jobs run on the
// test's clock.

let install: TestInstall;
let sink: SmtpSink;
let mailer: Mailer;
/** How many messages the SMTP server had received when the test began. */
let received = 0;
let clock = new Date("2026-10-12T08:00:00Z");
let acmeId: number;
let pullRequest = 700;
let apiId: string;
let ada: WebSessionCaller;
let deniz: string;
let mehmet: string;
let ayse: string;
const teams: Record<string, string> = {};

const ciRun = (): CiCaller => ({ kind: "ci", repositoryId: String(PAYMENTS_REPOSITORY.id), repositoryOwnerId: String(acmeId), jobWorkflowRef: CONTRACT_WORKFLOW });

/** The one WARN-level change of the warning pair, alone. */
const warnOnly = (): ClassifiedChange[] => changesOf("warning").filter(({ level }) => level === "WARN");

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  deniz = await addUser(install.owner, { login: "deniz" });
  mehmet = await addUser(install.owner, { login: "mehmet" });
  ayse = await addUser(install.owner, { login: "ayse" });
  const erin = await addUser(install.owner, { login: "erin" });
  for (const key of ["PAY", "FE", "MOBILE"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, deniz, teams["PAY"] ?? "");
  await joinTeams(install.owner, mehmet, teams["FE"] ?? "");
  await joinTeams(install.owner, ayse, teams["FE"] ?? "");
  await joinTeams(install.owner, erin, teams["MOBILE"] ?? "");
  for (const [userId, login] of [
    [mehmet, "mehmet"],
    [ayse, "ayse"],
    [erin, "erin"],
  ] as const) {
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [userId, `${login}@example.com`]);
  }
  // Ayşe has turned the daily digest off.
  await install.owner.query("UPDATE users SET digest_enabled = false WHERE id = $1", [ayse]);
  ({ accountId: acmeId } = await addInstallation(install.owner, { account: "acme", repositories: [PAYMENTS_REPOSITORY] }));
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: teams["PAY"], repository: PAYMENTS_REPOSITORY.fullName })).status).toBe(200);
  const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM apis WHERE name = 'payments-api'");
  apiId = rows[0]?.id ?? "";
  for (const team of ["FE", "MOBILE"]) {
    await install.owner.query(
      `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
         SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
      [teams[team], mehmet],
    );
  }
  sink = await startSmtpSink();
  mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });
}, 60_000);

afterAll(async () => {
  mailer?.close();
  await sink?.close();
  await install?.close();
});

beforeEach(async () => {
  install.sentJobs.splice(0);
  pullRequest += 1;
  received = sink.messages.length;
  await install.owner.query("UPDATE apis SET warn_opens_requests = false");
  // Each test starts on a day of its own.
  clock = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate() + 2, 8));
});

/** The CI run reports the pull request with these changes, and the worker applies the update once its burst has ended. */
async function pushReports(changes: readonly ClassifiedChange[]): Promise<void> {
  await install.execute("contract.report", ciRun(), reportOf("payments-api", changes, { pullRequest }));
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
}

/** The keys of the requests the pull request's reports opened, in the order of their teams' keys. */
async function requestsOpened(): Promise<string[]> {
  const { rows } = await install.owner.query<{ key: string }>(
    `SELECT t.key || '-' || r.number AS key FROM contract_change_requests c
       JOIN contract_change_sets s ON s.id = c.change_set_id JOIN requests r ON r.id = c.request_id JOIN teams t ON t.id = r.target_team_id
      WHERE s.pull_request_number = $1 ORDER BY t.key`,
    [pullRequest],
  );
  return rows.map(({ key }) => key);
}

interface WarnDigest {
  team: { key: string };
  day: string;
  text: string;
  changeSets: { api: string; pullRequest: { repository: string; number: number; url: string }; warnChanges: number }[];
}

async function warnDigestsOf(userId: string): Promise<WarnDigest[]> {
  return ((await install.execute("inbox.standing_list", sessionOf(userId), {})) as { warnDigests: WarnDigest[] }).warnDigests;
}

/** The day of the clock, which the reports of a test came on. */
const today = () => clock.toISOString().slice(0, 10);

/** Moves the clock to the next UTC day, at 00:07, when the hourly job sends the digests of the day that ended. */
function nextDay(): void {
  clock = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate() + 1, 0, 7));
}

async function sendWarnDigests(): Promise<void> {
  await emailWarnDigests.handle(
    { id: randomUUID(), queue: emailWarnDigests.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => clock, mailer, installUrl: URL_OF_INSTALL },
  );
}

/** The emails the SMTP server received, by their recipient, with their subject and text. */
function emails(): { to: string; subject: string; text: string }[] {
  return sink.messages.slice(received).map((message) => {
    const unfolded = message.data.replace(/=\r\n/g, "").replace(/=3D/g, "=").replace(/\r\n/g, "\n");
    return { to: message.to.join(","), subject: /^Subject: (.*)$/m.exec(unfolded)?.[1] ?? "", text: unfolded.slice(unfolded.indexOf("\n\n") + 2) };
  });
}

describe("a report with a WARN-level change and no ERR-level change, while the WARN switch is off", () => {
  it("opens no request, and lists the change in each consuming team's next daily digest, in each member's standing list", async () => {
    await pushReports(warnOnly());
    const day = today();

    expect(await requestsOpened()).toEqual([]);
    // The day has not ended: its digest is not produced yet.
    expect((await warnDigestsOf(mehmet)).filter((digest) => digest.day === day)).toEqual([]);

    nextDay();
    for (const userId of [mehmet, ayse]) {
      const digest = (await warnDigestsOf(userId)).find((listed) => listed.day === day && listed.team.key === "FE");
      // Each API's count of WARN-level changes, its name and its pull request's link, and never the changes' own text
      // (decisions-from-groups-15-28, D55 (70)).
      expect(digest?.changeSets).toEqual([
        {
          api: "payments-api",
          pullRequest: { repository: "acme/payments", number: pullRequest, url: `https://github.com/acme/payments/pull/${pullRequest}` },
          warnChanges: 1,
        },
      ]);
      expect(digest?.text).toContain(`FE's WARN digest of ${day}`);
      for (const text of ["request-parameter-removed", "GET /payments"]) expect(JSON.stringify(digest)).not.toContain(text);
    }
    // MOBILE's digest is MOBILE's members', not FE's.
    expect((await warnDigestsOf(mehmet)).filter(({ day: listed, team }) => listed === day && team.key === "MOBILE")).toEqual([]);
  });

  it("emails it, when SMTP is set, to each member of the team who has not turned the daily digest off, once", async () => {
    await pushReports(warnOnly());
    const day = today();
    nextDay();

    await sendWarnDigests();
    await sendWarnDigests();

    const sent = emails().filter(({ subject }) => subject.includes(day));
    expect(sent.map(({ to, subject }) => ({ to, subject })).sort((a, b) => a.to.localeCompare(b.to))).toEqual([
      { to: "erin@example.com", subject: `Tiehall: MOBILE's WARN digest of ${day} (UTC)` },
      { to: "mehmet@example.com", subject: `Tiehall: FE's WARN digest of ${day} (UTC)` },
    ]);
    const mehmetsEmail = sent.find(({ to }) => to === "mehmet@example.com");
    expect(mehmetsEmail?.text).toContain(`payments-api in acme/payments#${pullRequest}: 1 potentially breaking change`);
    expect(mehmetsEmail?.text).toContain(`https://github.com/acme/payments/pull/${pullRequest}`);
    for (const text of ["request-parameter-removed", "GET /payments"]) expect(mehmetsEmail?.text).not.toContain(text);
    expect(mehmetsEmail?.text).toContain(`This digest stays in the standing list of your web inbox until you dismiss it, or for 7 days: ${URL_OF_INSTALL}/inbox`);
    // Ayşe turned the digest off: no email, and the standing list still lists FE's digest.
    expect(sent.some(({ to }) => to === "ayse@example.com")).toBe(false);
    expect((await warnDigestsOf(ayse)).some((digest) => digest.day === day && digest.team.key === "FE")).toBe(true);
  });

  it("sends no email without SMTP, and still lists the digest", async () => {
    await pushReports(warnOnly());
    const day = today();
    nextDay();

    await emailWarnDigests.handle(
      { id: randomUUID(), queue: emailWarnDigests.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => clock, installUrl: URL_OF_INSTALL },
    );

    expect(emails()).toEqual([]);
    expect((await warnDigestsOf(mehmet)).some((digest) => digest.day === day)).toBe(true);
  });
});

// A team's WARN digest stays in a member's standing list until that member dismisses it, or until 7 days after it was
// produced, when its UTC day ended (contract-changes: Potentially breaking changes go to a daily digest, "A WARN digest
// leaves the standing list"; decisions-from-groups-15-28, D55 (69)).
describe("a WARN digest in the standing list", () => {
  /** Dismisses the team's digest of the day from the member's standing list, as the web inbox's form does. */
  const dismiss = (userId: string, team: string, day: string) => {
    const session = sessionOf(userId);
    return install.web(session).write("inbox.dismiss_warn_digest", { team, day }, install.fromThePage(session));
  };

  it("leaves the standing list of the member who dismisses it, and stays in the other members' lists", async () => {
    await pushReports(warnOnly());
    const day = today();
    nextDay();

    expect(await dismiss(mehmet, teams["FE"] ?? "", day)).toMatchObject({ ok: true, output: { team: { key: "FE" }, day } });

    expect((await warnDigestsOf(mehmet)).filter((digest) => digest.day === day)).toEqual([]);
    expect((await warnDigestsOf(ayse)).filter((digest) => digest.day === day).map(({ team }) => team.key)).toEqual(["FE"]);
    // Dismissing it again changes nothing.
    expect(await dismiss(mehmet, teams["FE"] ?? "", day)).toMatchObject({ ok: true });
  });

  it("leaves every member's standing list 7 days after its day ended", async () => {
    await pushReports(warnOnly());
    const day = today();
    const ended = Date.parse(`${day}T00:00:00Z`) + 24 * 3_600_000;

    clock = new Date(ended + 7 * 24 * 3_600_000 - 60_000);
    for (const userId of [mehmet, ayse]) expect((await warnDigestsOf(userId)).filter((digest) => digest.day === day), userId).toHaveLength(1);

    clock = new Date(ended + 7 * 24 * 3_600_000);
    for (const userId of [mehmet, ayse]) expect((await warnDigestsOf(userId)).filter((digest) => digest.day === day), userId).toEqual([]);
  });

  it("refuses to dismiss the digest of a team the member is not in with 403", async () => {
    await pushReports(warnOnly());
    const day = today();
    nextDay();

    expect(await dismiss(mehmet, teams["MOBILE"] ?? "", day)).toMatchObject({ ok: false, problem: { status: 403 } });
    const { rows } = await install.owner.query("SELECT count(*)::int AS count FROM contract_warn_digest_dismissals WHERE user_id = $1 AND team_id = $2", [mehmet, teams["MOBILE"]]);
    expect(rows[0]).toEqual({ count: 0 });
  });
});

describe("changes that go to no digest", () => {
  it("INFO-level changes alone open nothing and reach no digest", async () => {
    await pushReports(changesOf("informational"));
    const day = today();
    nextDay();

    expect(await requestsOpened()).toEqual([]);
    expect((await warnDigestsOf(mehmet)).filter((digest) => digest.day === day)).toEqual([]);
  });

  it("WARN-level changes beside ERR-level ones are listed in the requests they open, not in a digest", async () => {
    await pushReports(changesOf("breaking"));
    const day = today();
    nextDay();

    expect(await requestsOpened()).toHaveLength(2);
    expect((await warnDigestsOf(mehmet)).filter((digest) => digest.day === day)).toEqual([]);
  });
});

describe("the WARN switch of an API", () => {
  it("opens a request to each consuming team for a WARN-level change while it is on, and keeps them when a later report has WARN-level changes alone", async () => {
    expect(await install.execute("apis.set_warn_switch", sessionOf(deniz), { api: apiId, on: true })).toEqual({ api: apiId, warnOpensRequests: true });

    await pushReports(warnOnly());
    expect((await requestsOpened()).map((key) => key.replace(/-\d+$/, ""))).toEqual(["FE", "MOBILE"]);
    await pushReports(warnOnly());
    const { rows } = await install.owner.query<{ state: string }>(
      `SELECT r.state FROM contract_change_requests c JOIN contract_change_sets s ON s.id = c.change_set_id JOIN requests r ON r.id = c.request_id
        WHERE s.pull_request_number = $1`,
      [pullRequest],
    );
    expect(rows.map(({ state }) => state)).toEqual(["open", "open"]);
    nextDay();
    expect((await warnDigestsOf(mehmet)).filter((digest) => digest.day === today())).toEqual([]);
  });

  it("is flipped by a member of the provider team and by an admin who is in no team", async () => {
    await install.execute("apis.set_warn_switch", sessionOf(deniz), { api: apiId, on: true });
    expect((await install.owner.query("SELECT warn_opens_requests FROM apis WHERE id = $1", [apiId])).rows).toEqual([{ warn_opens_requests: true }]);

    expect(await install.execute("apis.set_warn_switch", ada, { api: apiId, on: false })).toEqual({ api: apiId, warnOpensRequests: false });
    expect((await install.owner.query("SELECT warn_opens_requests FROM apis WHERE id = $1", [apiId])).rows).toEqual([{ warn_opens_requests: false }]);
  });

  it("refuses a member of a consuming team who is neither an admin nor in the provider team with 403, and stays off", async () => {
    await expect(install.execute("apis.set_warn_switch", sessionOf(ayse), { api: apiId, on: true })).rejects.toMatchObject({ reason: "forbidden", status: 403 });
    expect((await install.owner.query("SELECT warn_opens_requests FROM apis WHERE id = $1", [apiId])).rows).toEqual([{ warn_opens_requests: false }]);
  });

  it("shows on the provider team's page and the admins' APIs page, whose forms flip it", async () => {
    const forTeam = (await install.execute("apis.list_for_team", sessionOf(deniz), { team: "PAY" })) as { apis: { id: string; warnOpensRequests: boolean; provides: boolean }[] };
    expect(forTeam.apis.find(({ id }) => id === apiId)).toMatchObject({ warnOpensRequests: false, provides: true });
    const forAdmin = (await install.execute("apis.list", ada, {})) as { apis: { id: string; warnOpensRequests: boolean }[] };
    expect(forAdmin.apis.find(({ id }) => id === apiId)).toMatchObject({ warnOpensRequests: false });
    expect(teamPageWrite(new URLSearchParams({ action: "warn_on", api: apiId, team: teams["PAY"] ?? "" }))).toEqual({
      commandId: "apis.set_warn_switch",
      input: { api: apiId, on: true },
    });
    expect(teamPageWrite(new URLSearchParams({ action: "warn_off", api: apiId }))).toEqual({ commandId: "apis.set_warn_switch", input: { api: apiId, on: false } });
  });
});

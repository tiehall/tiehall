import { randomUUID } from "node:crypto";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailAdminAlerts, openMailer, type Banner, type CiCaller, type Mailer, type WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { changesOf, CONTRACT_WORKFLOW, PAYMENTS_REPOSITORY, reportOf, runDueUpdates } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// One PR reaches at most 10 consumer teams without an admin (agent-safety:
// One PR reaches at most 10 consumer teams without an admin; activity-log:
// Which actions are security events; design.md, Decisions this change rests
// on: D28 #52; design.md, Self-hosting decisions: S7, S10; design.md,
// Readings to confirm with the founder: R15). For one provider pull request,
// the updates of its change sets open requests to at most 10 consumer teams
// at once: the 10 whose declarations of the API are the oldest, ties broken by
// team key; the rest wait until an admin confirms the larger fan-out in the
// web UI with the confirmation step. While teams wait, the install's admins
// see a banner, and, when SMTP is set, each gets one email about it. The
// confirmation is an admin action and a security event; the waiting teams'
// requests are then opened by the change set's update, as the system from
// GitHub. Here payments-api has 12 consumer teams: T01 to T09, declared one
// after the other, then APP and MOB at the same time, and WEB last, so APP
// gets in by its key, and MOB and WEB wait.

let install: TestInstall;
let clock = new Date("2026-10-05T08:00:00Z");
let ada: WebSessionCaller;
let pia: WebSessionCaller;
let dana: WebSessionCaller;
let acmeId: number;
let pullRequest = 500;
const teams: Record<string, string> = {};

const FIRST_TEN = ["APP", "T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09"];
const CI = (): CiCaller => ({ kind: "ci", repositoryId: String(PAYMENTS_REPOSITORY.id), repositoryOwnerId: String(acmeId), jobWorkflowRef: CONTRACT_WORKFLOW });

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  pia = sessionOf(await addUser(install.owner, { role: "admin", login: "pia" }));
  dana = sessionOf(await addUser(install.owner, { login: "dana" }));
  for (const [session, email] of [[ada, "ada@acme.example"], [pia, "pia@acme.example"], [dana, "dana@acme.example"]] as const) {
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [session.userId, email]);
  }
  for (const key of ["PAY", ...FIRST_TEN, "MOB", "WEB", "OPS"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, dana.userId, teams["PAY"] ?? "");
  ({ accountId: acmeId } = await addInstallation(install.owner, { account: "acme", repositories: [PAYMENTS_REPOSITORY] }));
  for (const name of ["payments-api", "billing-api", "ledger-api"]) {
    expect((await install.confirm(ada, "apis.register", { name, team: teams["PAY"], repository: PAYMENTS_REPOSITORY.fullName })).status).toBe(200);
  }
  // payments-api: T01 to T09 one day apart, then APP and MOB on the same day, then WEB.
  const declarations: [string, string][] = [
    ...["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09"].map((key, day): [string, string] => [key, `2026-09-0${day + 1}T09:00:00Z`]),
    ["MOB", "2026-09-15T09:00:00Z"],
    ["APP", "2026-09-15T09:00:00Z"],
    ["WEB", "2026-09-20T09:00:00Z"],
  ];
  for (const [key, at] of declarations) await declare("payments-api", key, at);
  // billing-api: the first ten of payments-api, and OPS.
  for (const key of [...FIRST_TEN, "OPS"]) await declare("billing-api", key, "2026-09-01T09:00:00Z");
  // ledger-api: exactly ten teams.
  for (const key of FIRST_TEN) await declare("ledger-api", key, "2026-09-01T09:00:00Z");
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
  pullRequest += 1;
});

/** A team's declaration that it consumes an API, made at this time. */
async function declare(api: string, key: string, at: string): Promise<void> {
  await install.owner.query(
    `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
       SELECT apis.org_id, apis.id, $2, $3, $4, $4 FROM apis WHERE apis.name = $1`,
    [api, teams[key], dana.userId, at],
  );
}

/** The CI run reports breaking changes to the API in this test's pull request, and the update is applied once its burst has ended. */
async function reportAndApply(api = "payments-api"): Promise<void> {
  await install.execute("contract.report", CI(), reportOf(api, changesOf("breaking"), { pullRequest }));
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
}

/** The keys of the teams that have a request for this test's pull request, in order. */
async function reached(api?: string): Promise<string[]> {
  const { rows } = await install.owner.query<{ key: string }>(
    `SELECT DISTINCT t.key FROM requests r
       JOIN teams t ON t.id = r.target_team_id
       JOIN packet_revisions p ON p.request_id = r.id AND p.number = 1
      WHERE (p.packet -> 'untrusted' -> 'contract' -> 'provider_pr' ->> 'number')::int = $1
        AND ($2::text IS NULL OR p.packet -> 'untrusted' -> 'contract' ->> 'api' = $2)
      ORDER BY t.key`,
    [pullRequest, api ?? null],
  );
  return rows.map(({ key }) => key);
}

/** The banners the web UI shows a member. */
async function bannersOf(session: WebSessionCaller): Promise<Banner[]> {
  return ((await install.execute("install.get_banners", session, {}, { readOnly: true })) as { banners: Banner[] }).banners;
}

/** The banners about a fan-out of this test's pull request that waits, to the API, that the web UI shows a member. */
async function fanOutBanners(session: WebSessionCaller, api = "payments-api"): Promise<Banner[]> {
  return (await bannersOf(session)).filter(({ id, text }) => id === "contract_fan_out" && text.includes(`acme/payments#${pullRequest} to ${api} `));
}

/** The fan-out the admins are asked to confirm: the change set and the waiting teams, as the banner's review page names them. */
async function waitingFanOut(): Promise<{ changeSet: string; teams: string[] }> {
  const [banner] = await fanOutBanners(ada);
  const href = new URL(banner?.link.href ?? "", URL_OF_INSTALL);
  expect(href.pathname).toBe("/confirm/contract.confirm_fan_out");
  return JSON.parse(href.searchParams.get("input") ?? "{}") as { changeSet: string; teams: string[] };
}

describe("a pull request whose breaking changes reach 12 consumer teams", () => {
  it("opens requests at once to the 10 teams whose declarations are the oldest, ties broken by key, and the other 2 wait", async () => {
    await reportAndApply();

    expect(await reached()).toEqual(FIRST_TEN);
  });

  it("shows every admin a banner about the waiting fan-out, and no member", async () => {
    await reportAndApply();

    for (const admin of [ada, pia]) {
      const [banner, ...others] = await fanOutBanners(admin);
      expect(others).toEqual([]);
      expect(banner?.text).toContain(`2 consumer teams wait for an admin to confirm that the breaking changes of acme/payments#${pullRequest} to payments-api reach them: MOB and WEB.`);
      expect(banner?.link.text).toBe("Review and confirm the fan-out");
    }
    expect(await bannersOf(dana)).toEqual([]);
    const fanOut = await waitingFanOut();
    expect(fanOut.teams.sort()).toEqual([teams["MOB"], teams["WEB"]].sort());
  });

  it("is refused with 403 to an admin whose confirmation has no confirmation step, and the 2 teams still have no request", async () => {
    await reportAndApply();
    const fanOut = await waitingFanOut();

    const refused = await install.execute("contract.confirm_fan_out", ada, fanOut).catch((error: unknown) => error);
    const member = await install.confirm(dana, "contract.confirm_fan_out", fanOut);
    await runDueUpdates(install, clock);

    expect(refused).toMatchObject({ status: 403 });
    expect(member.status).toBe(403);
    expect(await reached()).toEqual(FIRST_TEN);
  });

  it("opens the last 2 once an admin confirms it with the confirmation step, which is a security event, and its banner goes", async () => {
    await reportAndApply();
    const fanOut = await waitingFanOut();
    const before = Number((await install.owner.query("SELECT coalesce(max(number), 0) AS number FROM events")).rows[0].number);

    expect((await install.confirm(ada, "contract.confirm_fan_out", fanOut)).status).toBe(200);
    await runDueUpdates(install, clock);

    expect(await reached()).toEqual([...FIRST_TEN, "MOB", "WEB"].sort());
    const { rows } = await install.owner.query(
      "SELECT type, class, actor_kind, actor_user_id, surface, data FROM events WHERE number > $1 AND class = 'security' ORDER BY number",
      [before],
    );
    expect(rows).toEqual([
      {
        type: "contract.fan_out_confirmed",
        class: "security",
        actor_kind: "web_session",
        actor_user_id: ada.userId,
        surface: "web",
        data: { changeSetId: fanOut.changeSet, teams: 2 },
      },
    ]);
    const openings = await install.owner.query(
      `SELECT e.actor_kind, e.surface FROM events e JOIN requests r ON r.id::text = e.data ->> 'requestId'
        WHERE e.number > $1 AND e.type = 'request.opened' AND r.target_team_id = ANY($2::uuid[])`,
      [before, [teams["MOB"], teams["WEB"]]],
    );
    expect(openings.rows).toEqual([
      { actor_kind: "system", surface: "github" },
      { actor_kind: "system", surface: "github" },
    ]);
    expect(await fanOutBanners(ada)).toEqual([]);
  });

  it("opens no other team's request when the confirmation names one team that waits", async () => {
    await reportAndApply();
    const fanOut = await waitingFanOut();

    expect((await install.confirm(ada, "contract.confirm_fan_out", { changeSet: fanOut.changeSet, teams: [teams["WEB"]] })).status).toBe(200);
    await runDueUpdates(install, clock);

    expect(await reached()).toEqual([...FIRST_TEN, "WEB"].sort());
    expect((await waitingFanOut()).teams).toEqual([teams["MOB"]]);
  });

  it("counts the teams another change set of the same pull request reached toward its 10", async () => {
    await reportAndApply("payments-api");
    await reportAndApply("billing-api");

    // billing-api's consumers are the first ten, which payments-api reached already, and OPS, an eleventh team.
    expect(await reached("billing-api")).toEqual(FIRST_TEN);
    const [banner] = await fanOutBanners(ada, "billing-api");
    expect(banner?.text).toContain(`acme/payments#${pullRequest} to billing-api reach them: OPS.`);
  });
});

describe("a pull request whose breaking changes reach exactly 10 consumer teams", () => {
  it("opens all 10 requests without an admin, and shows no banner", async () => {
    await reportAndApply("ledger-api");

    expect(await reached("ledger-api")).toEqual(FIRST_TEN);
    expect(await fanOutBanners(ada, "ledger-api")).toEqual([]);
    expect(install.sentJobs.filter(({ queue }) => queue === emailAdminAlerts.type.queue)).toEqual([]);
  });
});

describe("the admins' email about a waiting fan-out", () => {
  let sink: SmtpSink;
  let mailer: Mailer;

  beforeEach(async () => {
    sink = await startSmtpSink();
    mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });
  });

  afterEach(async () => {
    mailer.close();
    await sink.close();
  });

  /** Runs the alert emails the updates started, as the worker does, with this mailer; returns how many ran. */
  async function runAlertJobs(with_: Mailer): Promise<number> {
    const jobs = install.sentJobs.splice(0).filter(({ queue }) => queue === emailAdminAlerts.type.queue);
    for (const { data } of jobs) {
      await emailAdminAlerts.handle(
        { id: randomUUID(), queue: emailAdminAlerts.type.queue, data: data as never, signal: new AbortController().signal },
        { database: install.db, now: () => clock, mailer: with_, installUrl: URL_OF_INSTALL },
      );
    }
    return jobs.length;
  }

  it("goes to every admin once when SMTP is set, and to no member", async () => {
    await reportAndApply();
    expect(await runAlertJobs(mailer)).toBe(1);

    expect(sink.messages.map(({ to }) => to[0]).sort()).toEqual(["ada@acme.example", "pia@acme.example"]);
    // The message as it reads: its folded header lines and its quoted-printable soft line breaks joined.
    const data = (sink.messages[0]?.data ?? "").replace(/\r?\n /g, " ").replace(/=\r?\n/g, "");
    expect(data).toContain("Subject: Tiehall: consumer teams wait for an admin to confirm a contract-change fan-out");
    expect(data).toContain(`2 consumer teams wait for an admin to confirm that the breaking changes of acme/payments#${pullRequest} to payments-api reach them: MOB and WEB.`);
    expect(data).toContain(`${URL_OF_INSTALL}/admin`);

    // A later update of the same change set while the teams still wait starts no second email.
    await reportAndApplySame();
    expect(await runAlertJobs(mailer)).toBe(0);
    expect(sink.messages).toHaveLength(2);
  });

  it("is not sent without SMTP settings: the banner is the only alert", async () => {
    await reportAndApply();
    expect(await runAlertJobs(openMailer(undefined))).toBe(1);
    expect(sink.messages).toEqual([]);
    expect(await fanOutBanners(ada)).toHaveLength(1);
  });
});

/** Another report of this test's pull request against payments-api, applied once its burst has ended. */
async function reportAndApplySame(): Promise<void> {
  await install.execute("contract.report", CI(), reportOf("payments-api", changesOf("breaking"), { pullRequest, head: "c".repeat(40) }));
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
}

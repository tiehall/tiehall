import { randomUUID } from "node:crypto";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEmailSettingsRoute,
  csrfTokenFor,
  EMAIL_SETTINGS_PATH,
  emailDigests,
  emailQuestion,
  notifyWaitingProposals,
  openMailer,
  type CiCaller,
  type Mailer,
  type WebSessionCaller,
} from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { changesOf, CONTRACT_WORKFLOW, PAYMENTS_REPOSITORY, reportOf, runDueUpdates } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, sessionOf, tokenOf } from "./support/requests.ts";

// When the requester is a team (requester-loop: When the requester is a team;
// requester-loop: What whats_new covers; requests: Where a proposal waits;
// design.md, Decisions this change rests on: D28 #62, #75; D29 (5); D30 (4);
// design.md, Readings to confirm with the founder: R16). A contract-change
// request whose provider PR's author is no member of the install has the
// provider team alone as its requester. The requester loop's events on it go
// to that team's inbox: the update feed of every member's web inbox, though
// not to their whats_new. When SMTP is set, the emails that go to the team as
// the requester, the questions asked of it and the notices that ask its side
// to confirm a two-sided commitment, go only to the members who opted in to
// that team's emails, in their email settings in the web UI; the choice is
// off until a member turns it on, and changes nothing in the web inbox, where
// every member who may confirm still finds the proposal. Here the install has
// no GitHub App, so no author is known, and PAY, the provider team, requests
// the changes of FE's request.

let install: TestInstall;
let clock = new Date("2026-10-05T08:00:00Z");
let sink: SmtpSink;
let mailer: Mailer;
const person: Record<string, string> = {};
const team: Record<string, string> = {};
let acmeId: number;
let pullRequest = 600;
let ada: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  for (const key of ["PAY", "FE"]) team[key] = await addTeam(install.owner, key);
  // Lee and Kim are in PAY, the provider team; Bob in FE, which consumes payments-api.
  for (const [login, teamKey] of [["lee", "PAY"], ["kim", "PAY"], ["bob", "FE"]] as const) {
    person[login] = await addUser(install.owner, { login });
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [person[login], `${login}@acme.example`]);
    await joinTeams(install.owner, person[login] ?? "", team[teamKey] ?? "");
  }
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  ({ accountId: acmeId } = await addInstallation(install.owner, { account: "acme", repositories: [PAYMENTS_REPOSITORY] }));
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: team["PAY"], repository: PAYMENTS_REPOSITORY.fullName })).status).toBe(200);
  await install.owner.query(
    `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
       SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
    [team["FE"], person["bob"]],
  );
  // Lee has opted in to PAY's emails as a requester; Kim has not.
  expect(await optIn("lee", true)).toEqual({ status: 303 });
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(async () => {
  sink = await startSmtpSink();
  mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });
  install.sentJobs.splice(0);
  pullRequest += 1;
});

afterEach(async () => {
  mailer.close();
  await sink.close();
});

/** The user's id; fails the test on a name the setup did not add. */
function id(login: string): string {
  const found = person[login];
  if (found === undefined) throw new Error(`No person ${login}.`);
  return found;
}

/** The email settings page, as the signed-in member uses it. */
function settingsPage(login: string) {
  const session: WebSessionCaller = sessionOf(id(login));
  return {
    session,
    route: createEmailSettingsRoute(
      { execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger },
      { emailSetUp: true },
    ),
  };
}

/** The member turns their emails as PAY's member on or off, with the form of their email settings page. */
async function optIn(login: string, on: boolean, teamKey = "PAY"): Promise<{ status: number }> {
  const { session, route } = settingsPage(login);
  const answer = await route(
    new Request(`${URL_OF_INSTALL}${EMAIL_SETTINGS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ team: team[teamKey] ?? "", requesterEmails: on ? "on" : "off", csrf: csrfTokenFor(install.authSecret, session.sessionId) }).toString(),
    }),
  );
  return { status: answer.status };
}

/** A contract-change request to FE whose requester is PAY alone, opened by a report of this test's pull request; returns its key and id. */
async function teamRequestedRequest(): Promise<{ id: string; key: string }> {
  const ci: CiCaller = { kind: "ci", repositoryId: String(PAYMENTS_REPOSITORY.id), repositoryOwnerId: String(acmeId), jobWorkflowRef: CONTRACT_WORKFLOW };
  await install.execute("contract.report", ci, reportOf("payments-api", changesOf("breaking"), { pullRequest }));
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
  const { rows } = await install.owner.query<{ id: string; key: string; requesting_user_id: string | null }>(
    `SELECT r.id, 'FE-' || r.number AS key, r.requesting_user_id FROM requests r
       JOIN packet_revisions p ON p.request_id = r.id AND p.number = 1
      WHERE (p.packet -> 'untrusted' -> 'contract' -> 'provider_pr' ->> 'number')::int = $1`,
    [pullRequest],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.requesting_user_id).toBeNull();
  install.sentJobs.splice(0);
  return { id: rows[0]?.id ?? "", key: rows[0]?.key ?? "" };
}

/** Bob, of FE, asks a question on the request with their agent; the job that emails it runs, as the worker runs it at once. */
async function bobAsks(key: string): Promise<void> {
  const answer = await callApi(install, tokenOf(id("bob")), "POST", `/api/v1/requests/${key}/messages`, { kind: "question", body: "Does amount move to amount_minor?" });
  expect(answer.status).toBe(200);
  for (const { queue, data } of install.sentJobs.splice(0)) {
    if (queue !== emailQuestion.type.queue) continue;
    await emailQuestion.handle({ id: randomUUID(), queue, data: data as { messageId: string }, signal: new AbortController().signal }, { database: install.db, now: () => clock, mailer, installUrl: URL_OF_INSTALL });
  }
}

/** Who got an email, by address, in order, with its subject. */
function emailed(): { to: string; subject: string }[] {
  return sink.messages.map(({ to, data }) => ({ to: to.join(","), subject: /^Subject: (.*)$/m.exec(data.replace(/\r\n[ \t]/g, " "))?.[1] ?? "" }));
}

/** The types of the updates on the request in the member's web inbox feed, read as the web UI reads it. */
async function webInboxOn(login: string, requestId: string): Promise<string[]> {
  const read = await install.web(sessionOf(id(login))).read<{ events: { type: string; data: Record<string, unknown> }[] }>("inbox.updates", { limit: 50 });
  if (!read.ok) throw new Error(`The web inbox answered ${JSON.stringify(read.problem)}`);
  return read.output.events.filter(({ data }) => data["requestId"] === requestId).map(({ type }) => type);
}

describe("a question on a request whose requester is a team", () => {
  it("reaches the team's inbox: the web inbox of each of its members, though not their whats_new", async () => {
    const request = await teamRequestedRequest();
    await bobAsks(request.key);

    for (const login of ["lee", "kim"]) expect(await webInboxOn(login, request.id)).toContain("request.message_posted");
    const whatsNew = (await install.execute("updates.read", tokenOf(id("kim")), { limit: 50 })) as { events: { data: Record<string, unknown> }[] };
    expect(whatsNew.events.filter(({ data }) => data["requestId"] === request.id)).toEqual([]);
  });

  it("is emailed, with SMTP set, only to the members who opted in to the team's emails", async () => {
    const request = await teamRequestedRequest();
    await bobAsks(request.key);

    expect(emailed()).toEqual([{ to: "lee@acme.example", subject: `Tiehall: ${request.key} request.message_posted (team FE)` }]);
  });

  it("is emailed to a member just added to the team only once they opt in", async () => {
    person["nia"] = await addUser(install.owner, { login: "nia" });
    await install.owner.query("UPDATE users SET email = 'nia@acme.example' WHERE id = $1", [id("nia")]);
    await joinTeams(install.owner, id("nia"), team["PAY"] ?? "");
    const request = await teamRequestedRequest();

    await bobAsks(request.key);
    expect(emailed().map(({ to }) => to)).toEqual(["lee@acme.example"]);

    expect(await optIn("nia", true)).toEqual({ status: 303 });
    await bobAsks(request.key);
    expect(emailed().map(({ to }) => to).sort()).toEqual(["lee@acme.example", "lee@acme.example", "nia@acme.example"]);
    expect(await optIn("nia", false)).toEqual({ status: 303 });
  });

  it("is emailed to a member who opted in, left the team and was added to it again, only once they opt in again", async () => {
    person["omar"] = await addUser(install.owner, { login: "omar" });
    await install.owner.query("UPDATE users SET email = 'omar@acme.example' WHERE id = $1", [id("omar")]);
    await joinTeams(install.owner, id("omar"), team["PAY"] ?? "");
    expect(await optIn("omar", true)).toEqual({ status: 303 });
    // An admin removes Omar from PAY and adds them to it again; Omar changes no setting.
    const membership = { teamId: team["PAY"], userId: id("omar") };
    expect((await install.web(ada).write("teams.remove_member", membership, install.fromThePage(ada))).ok).toBe(true);
    expect((await install.web(ada).write("teams.add_member", membership, install.fromThePage(ada))).ok).toBe(true);
    const request = await teamRequestedRequest();

    await bobAsks(request.key);

    expect(emailed().map(({ to }) => to)).toEqual(["lee@acme.example"]);
    const settings = (await install.execute("users.email_settings", sessionOf(id("omar")), {}, { readOnly: true })) as { teams: { team: { key: string }; requesterEmails: boolean }[] };
    expect(settings.teams).toEqual([{ team: { id: team["PAY"], key: "PAY" }, requesterEmails: false }]);
  });

  it("is off again for a member removed from the install, whose teams go with the membership", async () => {
    person["noor"] = await addUser(install.owner, { login: "noor" });
    await joinTeams(install.owner, id("noor"), team["PAY"] ?? "");
    expect(await optIn("noor", true)).toEqual({ status: 303 });

    expect((await install.confirm(ada, "members.remove", { userId: id("noor") })).status).toBe(200);

    const { rows } = await install.owner.query("SELECT count(*)::int AS count FROM team_requester_emails WHERE user_id = $1", [id("noor")]);
    expect(rows[0]).toEqual({ count: 0 });
  });

  it("is emailed to no member while none opted in, and still reaches every member's web inbox", async () => {
    expect(await optIn("lee", false)).toEqual({ status: 303 });
    try {
      const request = await teamRequestedRequest();
      await bobAsks(request.key);
      expect(emailed()).toEqual([]);
      for (const login of ["lee", "kim"]) expect(await webInboxOn(login, request.id)).toContain("request.message_posted");
    } finally {
      expect(await optIn("lee", true)).toEqual({ status: 303 });
    }
  });
});

describe("a two-sided due date on a request whose requester is a team", () => {
  it("waits in the standing list of every member of the team, and its notice is emailed only to those who opted in", async () => {
    const request = await teamRequestedRequest();
    const proposed = (await install.execute("proposals.propose", tokenOf(id("bob")), { kind: "due_date", key: request.key, dueDate: "2026-11-02", expectedRevision: 1 })) as { proposal: { id: string } };
    expect((await install.confirm(sessionOf(id("bob")), "proposals.confirm", { proposal: proposed.proposal.id })).status).toBe(200);

    for (const login of ["lee", "kim"]) {
      const list = (await install.execute("inbox.standing_list", sessionOf(id(login)), {}, { readOnly: true })) as { waiting: { id: string }[] };
      expect(list.waiting.map(({ id: proposal }) => proposal), login).toContain(proposed.proposal.id);
    }
    await notifyWaitingProposals.handle({ id: randomUUID(), queue: notifyWaitingProposals.type.queue, data: {}, signal: new AbortController().signal }, { database: install.db, now: () => clock, mailer, installUrl: URL_OF_INSTALL });
    const notices = emailed().filter(({ subject }) => subject === `Tiehall: a proposal on ${request.key} waits for your confirmation`);
    expect(notices.map(({ to }) => to)).toEqual(["lee@acme.example"]);
  });
});

describe("the email settings page", () => {
  it("offers each of the member's teams' emails as a requester, off until the member turns them on", async () => {
    const { route } = settingsPage("kim");
    const html = await (await route(new Request(`${URL_OF_INSTALL}${EMAIL_SETTINGS_PATH}`, { headers: { accept: "text/html" } }))).text();
    expect(html).toContain("Emails to your teams as requesters");
    expect(html).toContain("Emails to PAY as a requester are off.");
    expect(html).toContain("Turn on PAY&#39;s emails");
  });

  it("refuses a team the member does not belong to with 403, and changes nothing", async () => {
    const refused = await install.execute("users.set_requester_emails", sessionOf(id("kim")), { team: team["FE"], on: true }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 403 });
    const { rows } = await install.owner.query("SELECT count(*)::int AS count FROM team_requester_emails WHERE user_id = $1", [id("kim")]);
    expect(rows[0]).toEqual({ count: 0 });
  });
});

// A member who opted in to the team's emails as a requester also gets, in their daily digest, the updates on the
// requests whose requester is that team (requester-loop: When the requester is a team, "An opted-in member's digest
// holds the team's requests"; decisions-from-groups-15-28, D55 (65)). Each member gets one digest a day, so this
// runs the day's digest once, last.
describe("the daily digest of a member of a team that is a requester", () => {
  it("lists a state change of a request whose requester is the team for a member who opted in, and nothing about it for one who did not", async () => {
    const request = await teamRequestedRequest();
    expect((await callApi(install, tokenOf(id("bob")), "POST", `/api/v1/requests/${request.key}/claim`)).status).toBe(200);
    expect((await callApi(install, tokenOf(id("bob")), "POST", `/api/v1/requests/${request.key}/status`, { state: "in_progress" })).status).toBe(200);
    // Events carry the database's time: the digest of the day they happened on goes out once that day has ended, and a
    // member's first digest covers the 7 latest ended days, the last of them that day.
    const { rows } = await install.owner.query<{ at: Date }>("SELECT max(occurred_at) AS at FROM events WHERE data->>'requestId' = $1", [request.id]);
    const day = (rows[0]?.at ?? new Date()).toISOString().slice(0, 10);
    const after = new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 3_600_000 + 5 * 60_000);

    await emailDigests.handle({ id: randomUUID(), queue: emailDigests.type.queue, data: {}, signal: new AbortController().signal }, { database: install.db, now: () => after, mailer, installUrl: URL_OF_INSTALL });

    const textTo = (address: string) =>
      sink.messages
        .filter(({ to }) => to.includes(address))
        .map(({ data }) => data.replace(/=\r\n/g, "").replace(/=3D/g, "=").replace(/\r\n/g, "\n"))
        .join("\n");
    const lee = textTo("lee@acme.example");
    const firstDay = new Date(Date.parse(`${day}T00:00:00Z`) - 6 * 24 * 3_600_000).toISOString().slice(0, 10);
    expect(lee).toContain(`Subject: Tiehall: your updates of ${firstDay} to ${day} (UTC)`);
    expect(lee).toContain(`${request.key} (team FE): ${URL_OF_INSTALL}/${request.key}`);
    expect(lee).toContain("request.claimed: it was claimed");
    expect(lee).toContain("request.started: work on it started");
    expect(textTo("kim@acme.example")).not.toContain(request.key);
  });
});

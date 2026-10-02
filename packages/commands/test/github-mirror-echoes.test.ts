import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub, type StubDelivery } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitHubIssues, processDelivery, syncMirror, type Execute, type WebSessionCaller } from "../src/index.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { storeDelivery } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// Echoes of Tiehall's own writes (tracker-mirrors: Mirror writes are
// idempotent and never echo). Every label, comment and close Tiehall writes
// on a mirror issue comes back from GitHub as an `issues` delivery, sent as
// the App's bot. Processing it reads the issue from GitHub and finds what
// Tiehall wrote, or is writing, so it adds nothing to the request: no event,
// no message, no proposal. A person's change to the same issue is not
// dropped. The GitHub stub plays GitHub, and logs each delivery it makes to
// the App's webhook, which the test stores and processes as the worker does.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let alice: string;
let ayse: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["ayse"], { hook: true, repositories: ["acme/fe-intake"] });
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  alice = await addUser(install.owner, { login: "alice" });
  ayse = await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, ayse, fe);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
});

async function sync(requestId: string): Promise<void> {
  const app = (await provider.github.app())!;
  await syncMirror({ database: install.db, adapters: { github: createGitHubIssues({ app, database: install.db }) }, installUrl: URL_OF_INSTALL, logger: install.logger }, requestId);
}

async function issueNumberOf(requestId: string): Promise<number> {
  const { rows } = await install.owner.query<{ issue: string }>("SELECT issue FROM mirrors WHERE request_id = $1", [requestId]);
  return Number(rows[0]?.issue);
}

/** Everything that records something on the request: its events, its messages and its proposals, counted. */
async function traceOf(requestId: string): Promise<{ events: number; messages: number; proposals: number }> {
  const { rows } = await install.owner.query(
    `SELECT (SELECT count(*)::int FROM events WHERE data ->> 'requestId' = $1) AS events,
            (SELECT count(*)::int FROM messages WHERE request_id = $2) AS messages,
            (SELECT count(*)::int FROM proposals WHERE request_id = $2) AS proposals`,
    [requestId, requestId],
  );
  return rows[0];
}

async function trackerStateOf(requestId: string): Promise<unknown> {
  const { rows } = await install.owner.query("SELECT tracker_state FROM mirrors WHERE request_id = $1", [requestId]);
  return rows[0]?.tracker_state;
}

/** The changes each processed delivery's read showed, as mirrors.record_tracker_change found them, in order. */
let found: string[][] = [];

/** execute(), as the worker's, keeping what each recording of a read found. */
const recording: Execute = async (commandId, caller, input, options) => {
  const output = await install.execute(commandId, caller, input, options);
  if (commandId === "mirrors.record_tracker_change") found.push((output as { changes: string[] }).changes);
  return output;
};

/** The `issues` deliveries GitHub made about the issue since the log had `from` entries, stored and processed as the worker does. */
async function processIssueDeliveries(number: number, from: number): Promise<StubDelivery[]> {
  found = [];
  const deliveries = stub
    .deliveries(provider.app)
    .slice(from)
    .filter(({ event, request }) => event === "issues" && (request.payload as { issue?: { number?: number } }).issue?.number === number);
  for (const delivery of deliveries) {
    await processDelivery({ database: install.db, github: provider.github, execute: recording }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));
  }
  return deliveries;
}

describe("the deliveries that Tiehall's own writes cause", () => {
  it("add nothing to the request: the issue's opening, Tiehall's labels and comments, and its close", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
    const from = stub.deliveries(provider.app).length;
    await sync(request.id);
    await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "in_progress" });
    await sync(request.id);
    const done = (await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "done" })) as { proposal: { id: string } };
    expect((await install.confirm(sessionOf(ayse), "proposals.confirm", { proposal: done.proposal.id })).status).toBe(200);
    await sync(request.id);
    await stub.settled();
    const before = await traceOf(request.id);
    const known = await trackerStateOf(request.id);

    const deliveries = await processIssueDeliveries(await issueNumberOf(request.id), from);

    // GitHub sent them as the App's bot: the opening, each label added and taken off, and the close.
    expect(new Set(deliveries.map(({ action }) => action))).toEqual(new Set(["opened", "labeled", "unlabeled", "closed"]));
    expect(new Set(deliveries.map(({ request: { payload } }) => (payload as { sender: { type: string } }).sender.type))).toEqual(new Set(["Bot"]));
    // Each was read back from GitHub, and found to show only what Tiehall wrote.
    expect(found).toEqual(deliveries.map(() => []));
    expect(await traceOf(request.id)).toEqual(before);
    expect(await trackerStateOf(request.id)).toEqual(known);
  });

  it("add nothing when GitHub delivers Tiehall's close while its job still waits for GitHub's answer", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
    await sync(request.id);
    const number = await issueNumberOf(request.id);
    const withdrawal = (await install.execute("requests.propose", sessionOf(alice), { key: request.key, kind: "withdraw" })) as { proposal: { id: string } };
    expect((await install.confirm(sessionOf(alice), "proposals.confirm", { proposal: withdrawal.proposal.id })).status).toBe(200);
    // The job has written what it expects and asked GitHub to close the issue, as the App, whose answer has not come back yet.
    await install.owner.query(`UPDATE mirrors SET expected_state = '{"open": false, "closeReason": "not_planned"}' WHERE request_id = $1`, [request.id]);
    const from = stub.deliveries(provider.app).length;
    const app = (await provider.github.app())!;
    await app.client
      .installation(stub.installations(provider.app)[0]!.id)
      .request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { owner: "acme", repo: "fe-intake", issue_number: number, state: "closed", state_reason: "not_planned" });
    await stub.settled();
    const before = await traceOf(request.id);

    await processIssueDeliveries(number, from);

    expect(found).toEqual([[]]);
    expect(await traceOf(request.id)).toEqual(before);
    expect(await trackerStateOf(request.id)).toEqual({ open: false, closeReason: "not_planned", assignees: [] });
  });
});

describe("a person's change to a mirror issue", () => {
  it("is not taken for an echo: what Tiehall knows of the issue follows it", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
    await sync(request.id);
    const number = await issueNumberOf(request.id);
    await stub.settled();
    const from = stub.deliveries(provider.app).length;

    await stub.closeIssue("acme/fe-intake", number, { by: "ayse", reason: "not_planned" });
    await stub.settled();
    await processIssueDeliveries(number, from);

    expect(found).toEqual([["closed"]]);
    expect(await trackerStateOf(request.id)).toEqual({ open: false, closeReason: "not_planned", assignees: [] });
  });

  it("to an issue that mirrors no request changes nothing", async () => {
    const from = stub.deliveries(provider.app).length;
    const app = (await provider.github.app())!;
    const { data } = await app.client
      .installation(stub.installations(provider.app)[0]!.id)
      .request("POST /repos/{owner}/{repo}/issues", { owner: "acme", repo: "fe-intake", title: "A bug someone filed" });
    const { number } = data as { number: number };
    await stub.closeIssue("acme/fe-intake", number, { by: "ayse" });
    await stub.settled();
    const { rows: before } = await install.owner.query("SELECT count(*)::int AS count FROM events");

    await processIssueDeliveries(number, from);

    const { rows: after } = await install.owner.query("SELECT count(*)::int AS count FROM events");
    expect(after).toEqual(before);
    expect(found).toEqual([]);
  });
});

describe("recording what a mirror issue shows", () => {
  it("is for a change read from the tracker only: a member's web session gets 403, an agent's token 404, a job 403", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
    await sync(request.id);
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM mirrors WHERE request_id = $1", [request.id]);
    const input = { mirrorId: rows[0]!.id, issue: { open: false, closeReason: "completed", assignees: [], closedBy: null } };
    await expect(install.execute("mirrors.record_tracker_change", sessionOf(ayse), input)).rejects.toMatchObject({ status: 403 });
    const token = { kind: "personal_access_token" as const, userId: ayse, tokenId: randomUUID(), scopes: ["requests:read" as const, "requests:write" as const], surface: "api" as const };
    await expect(install.execute("mirrors.record_tracker_change", token, input)).rejects.toMatchObject({ status: 404 });
    await expect(install.execute("mirrors.record_tracker_change", { kind: "system_job", job: "probe" }, input)).rejects.toMatchObject({ status: 403 });
    expect(await trackerStateOf(request.id)).toEqual({ open: true, closeReason: null, assignees: [] });
  });
});

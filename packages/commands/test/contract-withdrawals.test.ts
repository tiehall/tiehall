import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CiCaller, WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { changesOf, CONTRACT_WORKFLOW, PAYMENTS_REPOSITORY, reportOf, runDueUpdates, type ClassifiedChange } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// Requests are withdrawn when the breaking changes disappear (contract-changes:
// Requests are withdrawn when the breaking changes disappear; requests:
// System withdrawals never touch a claimed request; requests: System actions
// need no proposal or confirmation; design.md, Decisions this change rests on:
// D23; design.md, Design rules: Requests and events). When an update of a
// change set holds no change that opens requests, Tiehall withdraws each of
// its requests that is unclaimed at that moment, as a system withdrawal with
// no proposal and no confirmation, recorded with the actor kind system and the
// surface github, and adds a notice to each claimed one, whose state does not
// change. A request whose claim was released counts as unclaimed. The reports
// come through the real contract.report, and the worker's job applies each
// burst once it has ended, on the test's clock.

let install: TestInstall;
let clock = new Date("2026-10-07T08:00:00Z");
let acmeId: number;
let pullRequest = 600;
let bob: string;
let erin: string;
let deniz: string;
const teams: Record<string, string> = {};

/** A CI run of the contract Action in acme/payments. */
const ciRun = (): CiCaller => ({ kind: "ci", repositoryId: String(PAYMENTS_REPOSITORY.id), repositoryOwnerId: String(acmeId), jobWorkflowRef: CONTRACT_WORKFLOW });

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  deniz = await addUser(install.owner, { login: "deniz" });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  for (const key of ["PAY", "FE", "MOBILE"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, deniz, teams["PAY"] ?? "");
  await joinTeams(install.owner, bob, teams["FE"] ?? "");
  await joinTeams(install.owner, erin, teams["MOBILE"] ?? "");
  ({ accountId: acmeId } = await addInstallation(install.owner, { account: "acme", repositories: [PAYMENTS_REPOSITORY] }));
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: teams["PAY"], repository: PAYMENTS_REPOSITORY.fullName })).status).toBe(200);
  for (const team of ["FE", "MOBILE"]) {
    await install.owner.query(
      `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
         SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
      [teams[team], deniz],
    );
  }
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
  pullRequest += 1;
});

/** The CI run reports the pull request with these changes, and the worker applies the update once its burst has ended. */
async function pushReports(changes: readonly ClassifiedChange[], head = "b"): Promise<void> {
  await install.execute("contract.report", ciRun(), reportOf("payments-api", changes, { pullRequest, head: head.repeat(40) }));
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
}

interface ContractRequest {
  id: string;
  key: string;
  state: string;
  claimant_user_id: string | null;
}

/** The pull request's requests to a team, oldest first. */
async function requestsTo(team: string): Promise<ContractRequest[]> {
  const { rows } = await install.owner.query<ContractRequest>(
    `SELECT r.id, t.key || '-' || r.number AS key, r.state, r.claimant_user_id
       FROM contract_change_requests c
       JOIN contract_change_sets s ON s.id = c.change_set_id
       JOIN requests r ON r.id = c.request_id
       JOIN teams t ON t.id = r.target_team_id
      WHERE s.pull_request_number = $1 AND t.key = $2
      ORDER BY r.number`,
    [pullRequest, team],
  );
  return rows;
}

/** The pull request's one request to a team. */
async function requestTo(team: string): Promise<ContractRequest> {
  const rows = await requestsTo(team);
  const [request] = rows;
  if (request === undefined || rows.length !== 1) throw new Error(`The pull request has ${rows.length} requests to ${team}.`);
  return request;
}

/** The request's thread, oldest first: each message's provenance and text. */
async function threadOf(requestId: string): Promise<{ actor_kind: string; surface: string | null; body: string }[]> {
  const { rows } = await install.owner.query(
    `SELECT m.actor_kind, m.surface, v.body
       FROM messages m JOIN message_versions v ON v.message_id = m.id AND v.version = 1
      WHERE m.request_id = $1 ORDER BY m.number`,
    [requestId],
  );
  return rows;
}

/** The request's proposals: each one's kind, state and why it was cancelled. */
async function proposalsOf(requestId: string): Promise<{ kind: string; state: string; cancel_reason: string | null }[]> {
  const { rows } = await install.owner.query("SELECT kind, state, cancel_reason FROM proposals WHERE request_id = $1 ORDER BY created_at", [requestId]);
  return rows;
}

/** The state-change events of the request, with their provenance. */
async function stateChangesOf(requestId: string): Promise<{ actor_kind: string; surface: string | null; actor_user_id: string | null; data: Record<string, unknown> }[]> {
  const { rows } = await install.owner.query(
    "SELECT actor_kind, surface, actor_user_id, data FROM events WHERE type = 'request.state_changed' AND data ->> 'requestId' = $1 ORDER BY number",
    [requestId],
  );
  return rows;
}

describe("an update that holds no change that opens requests", () => {
  it("withdraws an unclaimed request with no proposal, as the system from GitHub, and leaves a claimed one as it is with a notice", async () => {
    await pushReports(changesOf("breaking"));
    const mobile = await requestTo("MOBILE");
    await install.execute("requests.claim", sessionOf(erin), { key: mobile.key });

    // A fix on the provider pull request: WARN-level and INFO-level changes only, while the WARN switch is off.
    await pushReports(changesOf("warning"), "c");

    const fe = await requestTo("FE");
    expect(fe.state).toBe("withdrawn");
    expect(await proposalsOf(fe.id)).toEqual([]);
    expect(await stateChangesOf(fe.id)).toEqual([
      { actor_kind: "system", surface: "github", actor_user_id: null, data: { requestId: fe.id, state: "withdrawn", previousState: "open" } },
    ]);
    const [feMessage] = await threadOf(fe.id);
    expect(feMessage).toMatchObject({ actor_kind: "system", surface: "github" });
    expect(feMessage?.body).toContain("Diff updated: 2 → 0 breaking");
    expect(feMessage?.body).toContain(`Tiehall withdrew ${fe.key}`);

    expect(await requestTo("MOBILE")).toMatchObject({ state: "claimed", claimant_user_id: erin });
    expect(await stateChangesOf(mobile.id)).toEqual([]);
    expect(await proposalsOf(mobile.id)).toEqual([]);
    const [mobileMessage] = await threadOf(mobile.id);
    expect(mobileMessage).toMatchObject({ actor_kind: "system", surface: "github" });
    expect(mobileMessage?.body).toContain("The breaking changes are gone");
    expect(mobileMessage?.body).toContain(`${mobile.key} is claimed`);
    // The API's name is its provider team's text, which a system message, Tiehall's own, leaves out
    // (agent-safety: Every string shown to agents has an origin; decisions-from-groups-15-28, D55 (80)).
    for (const message of [feMessage, mobileMessage]) expect(message?.body).not.toContain("payments-api");
  });

  it("counts a request whose claim was released as unclaimed, and withdraws it", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("requests.claim", sessionOf(bob), { key: fe.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: fe.key, state: "open" });

    await pushReports(changesOf("informational"), "c");

    expect((await requestTo("FE")).state).toBe("withdrawn");
  });

  it("counts a request that waits on a question after its claim was released as unclaimed, and withdraws it", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("requests.claim", sessionOf(bob), { key: fe.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: fe.key, state: "in_progress" });
    await install.execute("messages.post", sessionOf(bob), { key: fe.key, kind: "question", blocking: true, body: "Which currency does the new field take?" });
    await install.execute("requests.set_status", sessionOf(bob), { key: fe.key, state: "open" });
    expect(await requestTo("FE")).toMatchObject({ state: "needs_info", claimant_user_id: null });

    await pushReports(changesOf("unchanged"), "c");

    expect((await requestTo("FE")).state).toBe("withdrawn");
    expect((await stateChangesOf(fe.id)).at(-1)?.data).toEqual({ requestId: fe.id, state: "withdrawn", previousState: "needs_info" });
  });

  it("leaves a claimed request that waits on a question in needs_info", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("requests.claim", sessionOf(bob), { key: fe.key });
    await install.execute("messages.post", sessionOf(bob), { key: fe.key, kind: "question", blocking: true, body: "Which currency does the new field take?" });

    await pushReports(changesOf("informational"), "c");

    expect(await requestTo("FE")).toMatchObject({ state: "needs_info", claimant_user_id: bob });
  });

  it("cancels the pending proposals of a request it withdraws", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("requests.set_status", sessionOf(bob), { key: fe.key, state: "declined" });

    await pushReports(changesOf("informational"), "c");

    expect(await proposalsOf(fe.id)).toEqual([{ kind: "decline", state: "cancelled", cancel_reason: "terminal_state" }]);
  });

  // contract-changes: Requests are withdrawn when the breaking changes disappear, "Breaking changes that come back open
  // a new request" (decisions-from-groups-15-28, D55 (68)).
  it("opens a new request for the team when the breaking changes come back, and the withdrawn one stays withdrawn with no notice", async () => {
    await pushReports(changesOf("breaking"));
    await pushReports(changesOf("informational"), "c");
    const fe = await requestTo("FE");
    expect(fe.state).toBe("withdrawn");
    const mobile = await requestTo("MOBILE");
    const before = (await threadOf(fe.id)).length;

    await pushReports(changesOf("breaking"), "d");

    const [withdrawn, opened, ...more] = await requestsTo("FE");
    expect(more).toEqual([]);
    expect(withdrawn).toEqual(fe);
    expect(opened).toMatchObject({ state: "open", claimant_user_id: null });
    expect(opened?.key).not.toBe(fe.key);
    expect((await threadOf(fe.id)).at(-1)?.body).toContain("If a later report brings breaking changes back, Tiehall opens a new request.");
    expect(await threadOf(fe.id)).toHaveLength(before);
    // MOBILE's request, withdrawn too, is replaced the same way.
    expect((await requestsTo("MOBILE")).map(({ id, state }) => ({ id, state }))).toEqual([{ id: mobile.id, state: "withdrawn" }, { id: expect.any(String), state: "open" }]);
    // A later update revises the new request, not the withdrawn one.
    await pushReports([...changesOf("breaking"), { id: "endpoint-added", level: "INFO", operation: "GET /refunds/{id}" }], "e");
    expect(await threadOf(fe.id)).toHaveLength(before);
    expect((await threadOf(opened?.id ?? "")).map(({ body }) => body)).toEqual([expect.stringContaining("Diff updated: 2 → 2 breaking")]);
  });

  it("opens no second request for a team whose request the requester side withdrew, which gets a notice", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    // A request withdrawn by people, not by the system for vanished changes.
    await install.owner.query("UPDATE requests SET state = 'withdrawn' WHERE id = $1", [fe.id]);

    await pushReports(threeBreaking(), "c");

    expect(await requestsTo("FE")).toEqual([{ ...fe, state: "withdrawn" }]);
    expect((await threadOf(fe.id)).at(-1)?.body).toContain(`${fe.key} is withdrawn`);
  });
});

/** The breaking pair's changes with a third ERR-level change, as a later push adds it. */
function threeBreaking(): ClassifiedChange[] {
  return [...changesOf("breaking"), { id: "response-property-type-changed", level: "ERR", operation: "GET /payments/{id}" }];
}

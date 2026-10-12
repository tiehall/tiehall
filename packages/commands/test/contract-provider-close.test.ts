import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pollGitHubChanges, processDelivery, processGitHubDelivery, type CiCaller, type JobData, type WebSessionCaller } from "../src/index.ts";
import { storeDelivery } from "./support/github-app.ts";
import { changesOf, CONTRACT_WORKFLOW, providerOnStub, reportOf, runDueUpdates, type ClassifiedChange, type StubProvider } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// Requests are withdrawn when the provider PR closes unmerged
// (contract-changes: Requests are withdrawn when the provider PR closes
// unmerged; requests: System withdrawals never touch a claimed request;
// agent-access: Six kinds of caller; tracker-mirrors: GitHub and Jira each run
// in webhook mode or polling mode; design.md, Decisions this change rests on:
// D23; D28 #74; design.md, Self-hosting decisions: S9). When Tiehall learns,
// from a delivery of the GitHub App or from the poll of polling mode, that a
// provider pull request in a covered repository closed without merging, it
// withdraws each unclaimed request of the pull request's change sets, as a
// system withdrawal recorded with the actor kind system and no user, with no
// proposal and no confirmation, and adds a notice to each claimed one and
// each one in a terminal state, whose states do not change. The processing
// reads the pull request from GitHub before it acts, so a delivery replayed
// after the pull request was reopened changes nothing. Once the pull request is
// reopened, the next report opens a new request to each team whose request the
// close withdrew; a request that stayed claimed gets the report's revision.
// The GitHub stub plays GitHub, with acme/payments, its pull requests and the
// install's App, whose deliveries GitHub cannot deliver here: the stub logs
// each, and the test stores it as /webhooks/github does and processes it as
// the worker does.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let clock = new Date("2026-10-08T08:00:00Z");
let bob: string;
let erin: string;
let quinn: string;

const ciRun = (): CiCaller => ({ kind: "ci", repositoryId: String(provider.repositoryId), repositoryOwnerId: String(provider.ownerId), jobWorkflowRef: CONTRACT_WORKFLOW });

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["deniz"], { hook: true });
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  const deniz = await addUser(install.owner, { login: "deniz", githubAccountId: provider.account("deniz") });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  quinn = await addUser(install.owner, { login: "quinn" });
  const teams: Record<string, string> = {};
  for (const key of ["PAY", "FE", "MOBILE", "QA"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, deniz, teams["PAY"] ?? "");
  await joinTeams(install.owner, bob, teams["FE"] ?? "");
  await joinTeams(install.owner, erin, teams["MOBILE"] ?? "");
  await joinTeams(install.owner, quinn, teams["QA"] ?? "");
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: teams["PAY"], repository: "acme/payments" })).status).toBe(200);
  for (const team of ["FE", "MOBILE", "QA"]) {
    await install.owner.query(
      `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
         SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
      [teams[team], deniz],
    );
  }
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(async () => {
  install.sentJobs.splice(0);
  await install.owner.query("UPDATE github_app SET mode = 'webhook'");
});

/** A provider pull request on acme/payments, which deniz opened; returns its number. */
async function providerPullRequest(): Promise<number> {
  return (await stub.openPullRequest("acme/payments", { title: "New payment fields", head: "deniz-payment-fields", author: "deniz" })).number;
}

/** The CI run reports the pull request with these changes, and the worker applies the update once its burst has ended. */
async function pushReports(pullRequest: number, changes: readonly ClassifiedChange[], head = "b"): Promise<void> {
  await install.execute("contract.report", ciRun(), reportOf("payments-api", changes, { pullRequest, head: head.repeat(40) }));
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
}

/** Stores the latest delivery GitHub made about the pull request with this action, as /webhooks/github does, and processes it as the worker does. */
async function deliver(pullRequest: number, action: string): Promise<void> {
  const delivery = stub
    .deliveries(provider.app)
    .filter(({ event, request }) => event === "pull_request" && (request.payload as { number?: number; action?: string }).number === pullRequest && (request.payload as { action?: string }).action === action)
    .at(-1);
  if (delivery === undefined) throw new Error(`GitHub made no ${action} delivery about #${pullRequest}.`);
  clock = new Date(clock.getTime() + 10 * 1000);
  await processDelivery({ database: install.db, github: provider.github, execute: install.execute, now: () => clock }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));
}

interface ContractRequest {
  id: string;
  key: string;
  state: string;
}

/** The pull request's requests to a team, oldest first. */
async function requestsTo(pullRequest: number, team: string): Promise<ContractRequest[]> {
  const { rows } = await install.owner.query<ContractRequest>(
    `SELECT r.id, t.key || '-' || r.number AS key, r.state
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
async function requestTo(pullRequest: number, team: string): Promise<ContractRequest> {
  const rows = await requestsTo(pullRequest, team);
  const [request] = rows;
  if (request === undefined || rows.length !== 1) throw new Error(`The pull request has ${rows.length} requests to ${team}.`);
  return request;
}

/** The texts of the request's thread, oldest first, with their provenance. */
async function threadOf(requestId: string): Promise<{ actor_kind: string; surface: string | null; body: string }[]> {
  const { rows } = await install.owner.query(
    `SELECT m.actor_kind, m.surface, v.body
       FROM messages m JOIN message_versions v ON v.message_id = m.id AND v.version = 1
      WHERE m.request_id = $1 ORDER BY m.number`,
    [requestId],
  );
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

async function revisionCount(requestId: string): Promise<number> {
  const { rows } = await install.owner.query<{ count: number }>("SELECT count(*)::int AS count FROM packet_revisions WHERE request_id = $1", [requestId]);
  return rows[0]?.count ?? 0;
}

/**
 * The breaking pair's changes and one more, as a later push of the pull request reports them: an update whose
 * changes equal the last update's adds nothing to the requests (decisions-from-groups-15-28, D55 (64)).
 */
const pushedAgain = (): ClassifiedChange[] => [...changesOf("breaking"), { id: "endpoint-added", level: "INFO", operation: "GET /refunds/{id}" }];

/** A pull request whose report opened requests to FE, MOBILE and QA, with MOBILE's in progress and QA's done. */
async function pullRequestWithRequests(): Promise<{ number: number; fe: ContractRequest; mobile: ContractRequest; qa: ContractRequest }> {
  const number = await providerPullRequest();
  await pushReports(number, changesOf("breaking"));
  const mobile = await requestTo(number, "MOBILE");
  await install.execute("requests.claim", sessionOf(erin), { key: mobile.key });
  await install.execute("requests.set_status", sessionOf(erin), { key: mobile.key, state: "in_progress" });
  const qa = await requestTo(number, "QA");
  await install.execute("requests.claim", sessionOf(quinn), { key: qa.key });
  const done = (await install.execute("requests.set_status", sessionOf(quinn), { key: qa.key, state: "done" })) as { proposal: { id: string } };
  expect((await install.confirm(sessionOf(quinn), "proposals.confirm", { proposal: done.proposal.id })).status).toBe(200);
  return { number, fe: await requestTo(number, "FE"), mobile, qa };
}

describe("a provider pull request that closes without merging", () => {
  it("withdraws an unclaimed request as the system, with no proposal, and leaves the claimed and the done ones as they are with a notice", async () => {
    const { number, fe, mobile, qa } = await pullRequestWithRequests();

    await stub.closePullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "closed");

    expect((await requestTo(number, "FE")).state).toBe("withdrawn");
    expect(await stateChangesOf(fe.id)).toEqual([
      { actor_kind: "system", surface: "github", actor_user_id: null, data: { requestId: fe.id, state: "withdrawn", previousState: "open" } },
    ]);
    expect((await install.owner.query("SELECT count(*)::int AS count FROM proposals WHERE request_id = $1", [fe.id])).rows).toEqual([{ count: 0 }]);
    const [feNotice] = await threadOf(fe.id);
    expect(feNotice).toMatchObject({ actor_kind: "system", surface: "github" });
    expect(feNotice?.body).toContain(`acme/payments#${number} closed without merging`);
    expect(feNotice?.body).toContain(`Tiehall withdrew ${fe.key}`);

    expect((await requestTo(number, "MOBILE")).state).toBe("in_progress");
    expect(await stateChangesOf(mobile.id)).toEqual([]);
    expect((await threadOf(mobile.id)).at(-1)?.body).toContain(`acme/payments#${number} closed without merging`);

    expect((await requestTo(number, "QA")).state).toBe("done");
    expect((await threadOf(qa.id)).at(-1)?.body).toContain(`acme/payments#${number} closed without merging`);
  });

  it("is found by the poll in polling mode, with the same effect", async () => {
    const { number } = await pullRequestWithRequests();
    await install.owner.query("UPDATE github_app SET mode = 'polling', polled_at = NULL");

    await stub.closePullRequest("acme/payments", number, { by: "deniz" }, { delivery: "none" });
    const sent: { queue: string; data: JobData }[] = [];
    const app = await provider.github.app();
    await pollGitHubChanges({ database: install.db, app: app!, jobs: { send: async (_tx, queue, data) => void sent.push({ queue, data }) }, now: () => new Date() });
    for (const { queue, data } of sent) {
      if (queue === processGitHubDelivery.type.queue) {
        await processDelivery({ database: install.db, github: provider.github, execute: install.execute, now: () => clock }, (data as { deliveryId: string }).deliveryId);
      }
    }

    expect((await requestTo(number, "FE")).state).toBe("withdrawn");
    expect((await requestTo(number, "MOBILE")).state).toBe("in_progress");
  });

  it("changes nothing when its closed delivery is processed again after the pull request was reopened", async () => {
    const { number } = await pullRequestWithRequests();
    await stub.closePullRequest("acme/payments", number, { by: "deniz" });
    await stub.reopenPullRequest("acme/payments", number, { by: "deniz" });

    await deliver(number, "closed");

    expect((await requestTo(number, "FE")).state).toBe("open");
  });
});

describe("a provider pull request reopened after it closed without merging", () => {
  it("gets a new request to each team whose request the close withdrew from its next report, and the claimed request gets the report's revision", async () => {
    const { number, fe, mobile } = await pullRequestWithRequests();
    await stub.closePullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "closed");

    await stub.reopenPullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "reopened");
    await pushReports(number, pushedAgain(), "c");

    const feRequests = await requestsTo(number, "FE");
    expect(feRequests.map(({ state }) => state)).toEqual(["withdrawn", "open"]);
    expect(feRequests[0]?.id).toBe(fe.id);
    expect(await requestTo(number, "MOBILE")).toMatchObject({ id: mobile.id, state: "in_progress" });
    expect(await revisionCount(mobile.id)).toBe(2);
    // The done request of QA gets the update's notice, and no second request.
    expect((await requestsTo(number, "QA")).map(({ state }) => state)).toEqual(["done"]);
  });

  // A report whose changes equal the last update's adds nothing to the requests that stayed, while it still opens
  // the new request (decisions-from-groups-15-28, D55 (64), (72)).
  it("opens the new request from a report after the reopen whose changes equal the last update's, and adds nothing to the claimed one", async () => {
    const { number, fe, mobile } = await pullRequestWithRequests();
    await stub.closePullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "closed");
    const notices = (await threadOf(mobile.id)).length;
    await stub.reopenPullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "reopened");

    await pushReports(number, changesOf("breaking"), "c");

    const feRequests = await requestsTo(number, "FE");
    expect(feRequests.map(({ state }) => state)).toEqual(["withdrawn", "open"]);
    expect(feRequests[0]?.id).toBe(fe.id);
    expect(await revisionCount(mobile.id)).toBe(1);
    expect(await threadOf(mobile.id)).toHaveLength(notices);
  });

  // After a reopen, the first report whose changes open requests opens them, not only the next report
  // (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (72)).
  it("opens the new request from a later report when its first report after the reopen has no ERR-level change", async () => {
    const { number, fe } = await pullRequestWithRequests();
    await stub.closePullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "closed");
    await stub.reopenPullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "reopened");

    const warnings = changesOf("warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(({ level }) => level === "ERR")).toBe(false);
    await pushReports(number, warnings, "c");
    expect(await requestsTo(number, "FE")).toEqual([{ ...fe, state: "withdrawn" }]);

    await pushReports(number, changesOf("breaking"), "d");

    const feRequests = await requestsTo(number, "FE");
    expect(feRequests.map(({ state }) => state)).toEqual(["withdrawn", "open"]);
    expect(feRequests[0]?.id).toBe(fe.id);
  });

  it("opens no request from a report that comes while the pull request is closed, and opens it once the pull request is reopened", async () => {
    const { number, mobile } = await pullRequestWithRequests();
    await stub.closePullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "closed");

    // A run that started before the close reports after it.
    await pushReports(number, pushedAgain(), "c");
    expect((await requestsTo(number, "FE")).map(({ state }) => state)).toEqual(["withdrawn"]);
    expect(await revisionCount(mobile.id)).toBe(2);

    await stub.reopenPullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "reopened");
    await runDueUpdates(install, clock);

    expect((await requestsTo(number, "FE")).map(({ state }) => state)).toEqual(["withdrawn", "open"]);
  });
});

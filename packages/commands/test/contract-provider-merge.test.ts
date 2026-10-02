import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processDelivery, type CiCaller, type WebSessionCaller } from "../src/index.ts";
import { storeDelivery } from "./support/github-app.ts";
import { changesOf, CONTRACT_WORKFLOW, providerOnStub, reportOf, runDueUpdates, type StubProvider } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, sessionOf, tokenOf } from "./support/requests.ts";

// Merging the provider PR marks the change shipped (contract-changes: Merging
// the provider PR marks the change shipped; requests: The event log; design.md,
// Decisions this change rests on: D14; design.md, Design rules: Contract
// changes). When Tiehall learns, from a delivery of the GitHub App or the
// poll, that a provider pull request merged, every request of its change sets
// shows the provider change as shipped, with when it merged, and a domain
// event that names each request records it, which the tracker mirrors' jobs
// pick up. The merge moves none of them to done: each consumer closes its own
// request with its own pull request. The GitHub stub plays GitHub; its
// deliveries are logged, and the test stores them as /webhooks/github does and
// processes them as the worker does.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let clock = new Date("2026-10-09T08:00:00Z");
let bob: string;
let erin: string;

const ciRun = (): CiCaller => ({ kind: "ci", repositoryId: String(provider.repositoryId), repositoryOwnerId: String(provider.ownerId), jobWorkflowRef: CONTRACT_WORKFLOW });

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["deniz"], { hook: true });
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  const deniz = await addUser(install.owner, { login: "deniz", githubAccountId: provider.account("deniz") });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  const teams: Record<string, string> = {};
  for (const key of ["PAY", "FE", "MOBILE"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, deniz, teams["PAY"] ?? "");
  await joinTeams(install.owner, bob, teams["FE"] ?? "");
  await joinTeams(install.owner, erin, teams["MOBILE"] ?? "");
  for (const name of ["payments-api", "billing-api"]) {
    expect((await install.confirm(ada, "apis.register", { name, team: teams["PAY"], repository: "acme/payments" })).status).toBe(200);
  }
  for (const [api, team] of [["payments-api", "FE"], ["payments-api", "MOBILE"], ["billing-api", "FE"]] as const) {
    await install.owner.query(
      `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
         SELECT apis.org_id, apis.id, $2, $3, now(), now() FROM apis WHERE apis.name = $1`,
      [api, teams[team], deniz],
    );
  }
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
});

/** A provider pull request on acme/payments, which deniz opened, reported with breaking changes to these APIs; returns its number. */
async function reportedPullRequest(apis: readonly string[] = ["payments-api"]): Promise<number> {
  const number = (await stub.openPullRequest("acme/payments", { title: "New payment fields", head: "deniz-payment-fields", author: "deniz" })).number;
  for (const api of apis) await install.execute("contract.report", ciRun(), reportOf(api, changesOf("breaking"), { pullRequest: number }));
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
  return number;
}

/** Stores the latest delivery GitHub made about the pull request with this action, and processes it as the worker does. */
async function deliver(pullRequest: number, action: string): Promise<void> {
  const delivery = stub
    .deliveries(provider.app)
    .filter(({ event, request }) => event === "pull_request" && (request.payload as { number?: number }).number === pullRequest && (request.payload as { action?: string }).action === action)
    .at(-1);
  if (delivery === undefined) throw new Error(`GitHub made no ${action} delivery about #${pullRequest}.`);
  clock = new Date(clock.getTime() + 10 * 1000);
  await processDelivery({ database: install.db, github: provider.github, execute: install.execute, now: () => clock }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));
}

/** The keys and ids of the pull request's requests, in the order of their teams' keys, then oldest first. */
async function requestsOf(pullRequest: number): Promise<{ id: string; key: string; team: string }[]> {
  const { rows } = await install.owner.query(
    `SELECT r.id, t.key || '-' || r.number AS key, t.key AS team
       FROM contract_change_requests c
       JOIN contract_change_sets s ON s.id = c.change_set_id
       JOIN requests r ON r.id = c.request_id
       JOIN teams t ON t.id = r.target_team_id
      WHERE s.pull_request_number = $1
      ORDER BY t.key, r.number`,
    [pullRequest],
  );
  return rows;
}

/** A request as /api/v1 returns it to a member. */
async function read(key: string): Promise<{ state: string; providerChange: unknown }> {
  const answer = await callApi(install, tokenOf(bob), "GET", `/api/v1/requests/${key}`);
  expect(answer.status).toBe(200);
  return answer.body;
}

describe("a provider pull request that merges", () => {
  it("shows the provider change as shipped on its requests, and moves none of them to done", async () => {
    const number = await reportedPullRequest();
    const [fe, mobile] = await requestsOf(number);
    await install.execute("requests.claim", sessionOf(bob), { key: fe!.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: fe!.key, state: "in_progress" });
    expect((await read(fe!.key)).providerChange).toEqual({
      api: "payments-api",
      pullRequest: { repository: "acme/payments", number, url: `https://github.com/acme/payments/pull/${number}` },
      status: "open",
      shippedAt: null,
    });

    const merged = await stub.mergePullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "closed");

    for (const { key, state } of [
      { key: fe!.key, state: "in_progress" },
      { key: mobile!.key, state: "open" },
    ]) {
      const request = await read(key);
      expect(request.state).toBe(state);
      expect(request.providerChange).toEqual({
        api: "payments-api",
        pullRequest: { repository: "acme/payments", number, url: `https://github.com/acme/payments/pull/${number}` },
        status: "merged",
        shippedAt: new Date(merged.mergedAt!).toISOString(),
      });
    }
  });

  it("records the shipped change as a domain event on each request of each of its change sets, once", async () => {
    const number = await reportedPullRequest(["payments-api", "billing-api"]);
    const requests = await requestsOf(number);
    expect(requests.map(({ team }) => team).sort()).toEqual(["FE", "FE", "MOBILE"]);

    await stub.mergePullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "closed");
    await deliver(number, "closed");

    const { rows } = await install.owner.query<{ request_id: string; class: string; actor_kind: string; surface: string; actor_user_id: string | null }>(
      "SELECT data ->> 'requestId' AS request_id, class, actor_kind, surface, actor_user_id FROM events WHERE type = 'request.provider_change_shipped' AND data ->> 'requestId' = ANY($1) ORDER BY number",
      [requests.map(({ id }) => id)],
    );
    expect(rows.map(({ request_id }) => request_id).sort()).toEqual(requests.map(({ id }) => id).sort());
    for (const row of rows) expect(row).toMatchObject({ class: "domain", actor_kind: "system", surface: "github", actor_user_id: null });
    // No request of the pull request moved to done.
    const { rows: states } = await install.owner.query<{ state: string }>("SELECT state FROM requests WHERE id = ANY($1)", [requests.map(({ id }) => id)]);
    expect(states.map(({ state }) => state)).toEqual(["open", "open", "open"]);
  });

  it("shows the change as shipped on a request that had ended, too", async () => {
    const number = await reportedPullRequest();
    const [, mobile] = await requestsOf(number);
    await install.execute("requests.claim", sessionOf(erin), { key: mobile!.key });
    const done = (await install.execute("requests.set_status", sessionOf(erin), { key: mobile!.key, state: "done" })) as { proposal: { id: string } };
    expect((await install.confirm(sessionOf(erin), "proposals.confirm", { proposal: done.proposal.id })).status).toBe(200);

    await stub.mergePullRequest("acme/payments", number, { by: "deniz" });
    await deliver(number, "closed");

    expect(await read(mobile!.key)).toMatchObject({ state: "done", providerChange: { status: "merged" } });
  });

  it("leaves a request that no report opened without a provider change", async () => {
    const opened = await callApi(install, tokenOf(bob), "POST", "/api/v1/requests", {
      targetTeam: "MOBILE",
      title: "Add a dark mode",
      packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "Add a dark mode to the settings page." } },
    });
    expect(opened.status).toBe(200);
    expect((await read(opened.body.key)).providerChange).toBeNull();
  });
});

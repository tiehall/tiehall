import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitHubIssues, mirrorRequest, processDelivery, syncMirror, type CiCaller, type WebSessionCaller } from "../src/index.ts";
import { storeDelivery } from "./support/github-app.ts";
import { changesOf, CONTRACT_WORKFLOW, providerOnStub, reportOf, runDueUpdates, type StubProvider } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// The shipped marker on mirror issues (contract-changes: Merging the provider
// PR marks the change shipped; tracker-mirrors: A mirror is a projection of
// the request). When the provider pull request of a change set merges, every
// request of the change set shows its provider change as shipped (task
// 23.14), and the domain event that records it wakes the mirror job of each
// mirrored request, which updates its mirror issue: the summary Tiehall writes
// says that the provider change it follows shipped, naming the provider pull
// request, while the request keeps its state and its state label.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let clock = new Date("2026-10-09T08:00:00Z");
let bob: string;

const ciRun = (): CiCaller => ({ kind: "ci", repositoryId: String(provider.repositoryId), repositoryOwnerId: String(provider.ownerId), jobWorkflowRef: CONTRACT_WORKFLOW });

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["deniz"], { hook: true, repositories: ["acme/fe-intake"] });
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  const deniz = await addUser(install.owner, { login: "deniz", githubAccountId: provider.account("deniz") });
  bob = await addUser(install.owner, { login: "bob" });
  const teams: Record<string, string> = {};
  for (const key of ["PAY", "FE"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, deniz, teams["PAY"] ?? "");
  await joinTeams(install.owner, bob, teams["FE"] ?? "");
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: teams["PAY"], repository: "acme/payments" })).status).toBe(200);
  await install.owner.query(
    `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
       SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
    [teams["FE"], deniz],
  );
  await install.execute("mirrors.map_repository", ada, { teamId: teams["FE"], repository: "acme/fe-intake" });
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
  await stub.settled();
}

describe("a merged provider pull request", () => {
  it("shows the change as shipped on the mirror issues of its change set's requests, which keep their state", async () => {
    const number = (await stub.openPullRequest("acme/payments", { title: "New payment fields", head: "deniz-payment-fields", author: "deniz" })).number;
    await install.execute("contract.report", ciRun(), reportOf("payments-api", changesOf("breaking"), { pullRequest: number }));
    clock = new Date(clock.getTime() + 3 * 60 * 1000);
    await runDueUpdates(install, clock);
    const { rows } = await install.owner.query<{ id: string; key: string }>(
      "SELECT r.id, t.key || '-' || r.number AS key FROM contract_change_requests c JOIN requests r ON r.id = c.request_id JOIN teams t ON t.id = r.target_team_id",
    );
    const request = rows[0]!;
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: request.key, state: "in_progress" });
    await sync(request.id);
    const { rows: mirrored } = await install.owner.query<{ issue: string }>("SELECT issue FROM mirrors WHERE request_id = $1", [request.id]);
    const issue = stub.issue("acme/fe-intake", Number(mirrored[0]?.issue));
    expect(issue.body).not.toContain("shipped");
    const comments = issue.comments.length;
    install.sentJobs.splice(0);

    await stub.mergePullRequest("acme/payments", number, { by: "deniz" });
    const delivery = stub
      .deliveries(provider.app)
      .filter(({ event, request: sent }) => event === "pull_request" && (sent.payload as { action?: string; number?: number }).action === "closed" && (sent.payload as { number?: number }).number === number)
      .at(-1)!;
    clock = new Date(clock.getTime() + 10 * 1000);
    await processDelivery({ database: install.db, github: provider.github, execute: install.execute, now: () => clock }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));

    // The shipped change wakes the request's mirror job, in the write that records it.
    expect(install.sentJobs.filter(({ queue }) => queue === mirrorRequest.queue)).toEqual([
      { queue: mirrorRequest.queue, data: { requestId: request.id }, singletonKey: request.id },
    ]);
    await sync(request.id);

    expect(issue.body).toContain(`The provider change ${request.key} follows shipped: acme/payments#${number} merged.`);
    expect(issue.labels).toEqual(["tiehall:in_progress"]);
    expect(issue.state).toBe("open");
    // No state changed, so no comment marks it.
    expect(issue.comments).toHaveLength(comments);
    const { rows: states } = await install.owner.query<{ state: string }>("SELECT state FROM requests WHERE id = $1", [request.id]);
    expect(states).toEqual([{ state: "in_progress" }]);
  });
});

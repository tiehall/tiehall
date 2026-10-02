import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mentionedKeys } from "../src/close-on-merge.ts";
import { pollGitHubChanges, processDelivery, processGitHubDelivery, type CiCaller, type JobData, type WebSessionCaller } from "../src/index.ts";
import { storeDelivery } from "./support/github-app.ts";
import { changesOf, CONTRACT_WORKFLOW, providerOnStub, reportOf, runDueUpdates, type StubProvider } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// Close on merge (requests: Linked PRs and done on merge; requests: System
// actions need no proposal or confirmation; contract-changes: Consumers close
// requests with their own PR; agent-access: Six kinds of caller;
// tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode;
// design.md, Decisions this change rests on: D14, D23, D37; design.md, Design
// rules: Requests and events; github-app-reachability: design.md, task 1.7;
// github-layer-hardening: design.md, Decisions this change rests on: D50
// (10)). A request moves to done, with no proposal and no confirmation, when a
// pull request merges that was linked to it, or mentioned its key in its
// title, body or branch name, before it merged; that merged after the request
// was claimed; and that is in a repository a connected installation covers;
// and only while the request is claimed, in_progress or needs_info. The
// change is recorded as the integration event from GitHub, acting for the
// Tiehall user who merged it while they are a member, and for no user
// otherwise, as for a merge the poll finds. The provider pull request of a
// contract-change request's own change set never closes it. The GitHub stub
// plays GitHub: acme/web and acme/payments are covered, acme/tools is not.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let clock = new Date("2026-10-10T08:00:00Z");
let alice: string;
let bob: string;
let dana: string;

const ciRun = (): CiCaller => ({ kind: "ci", repositoryId: String(provider.repositoryId), repositoryOwnerId: String(provider.ownerId), jobWorkflowRef: CONTRACT_WORKFLOW });

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["alice", "bob", "dana", "deniz"], { hook: true, repositories: ["acme/web"] });
  stub.addRepo("acme/tools");
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  alice = await addUser(install.owner, { login: "alice", githubAccountId: provider.account("alice") });
  bob = await addUser(install.owner, { login: "bob", githubAccountId: provider.account("bob") });
  dana = await addUser(install.owner, { login: "dana", githubAccountId: provider.account("dana") });
  const deniz = await addUser(install.owner, { login: "deniz", githubAccountId: provider.account("deniz") });
  const teams: Record<string, string> = {};
  for (const key of ["BE", "FE", "PAY"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, alice, teams["BE"] ?? "");
  await joinTeams(install.owner, bob, teams["FE"] ?? "");
  await joinTeams(install.owner, dana, teams["FE"] ?? "");
  await joinTeams(install.owner, deniz, teams["PAY"] ?? "");
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: teams["PAY"], repository: "acme/payments" })).status).toBe(200);
  await install.owner.query(
    `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
       SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
    [teams["FE"], bob],
  );
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
});

/** A request Alice opens to FE; returns its key and id. */
async function feRequest(): Promise<{ key: string; id: string }> {
  return openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
}

async function stateOf(id: string): Promise<{ state: string; claimant_user_id: string | null }> {
  const { rows } = await install.owner.query("SELECT state, claimant_user_id FROM requests WHERE id = $1", [id]);
  return rows[0];
}

/** Stores the latest delivery GitHub made about a pull request of a repository with this action, and processes it as the worker does. */
async function deliver(repository: string, number: number, action: string): Promise<void> {
  const delivery = stub
    .deliveries(provider.app)
    .filter(({ event, request }) => {
      const payload = request.payload as { number?: number; action?: string; repository?: { full_name?: string } };
      return event === "pull_request" && payload.repository?.full_name === repository && payload.number === number && payload.action === action;
    })
    .at(-1);
  if (delivery === undefined) throw new Error(`GitHub made no ${action} delivery about ${repository}#${number}.`);
  await processDelivery({ database: install.db, github: provider.github, execute: install.execute, now: () => clock }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));
}

/** A pull request on a repository of acme, by this GitHub user, merged by another or the same; its merge delivery is processed. */
async function mergedPullRequest(
  repository: string,
  input: { title?: string; body?: string; head?: string; author?: string; mergedBy?: string },
  before?: (number: number) => Promise<void>,
): Promise<number> {
  const opened = await stub.openPullRequest(repository, {
    title: input.title ?? "Update the header",
    body: input.body ?? null,
    head: input.head ?? "update-header",
    author: input.author ?? "bob",
  });
  await before?.(opened.number);
  await stub.mergePullRequest(repository, opened.number, { by: input.mergedBy ?? input.author ?? "bob" });
  await deliver(repository, opened.number, "closed");
  return opened.number;
}

/** The state-change events of the request, with their provenance. */
async function stateChangesOf(requestId: string): Promise<{ actor_kind: string; surface: string | null; actor_user_id: string | null; data: Record<string, unknown> }[]> {
  const { rows } = await install.owner.query(
    "SELECT actor_kind, surface, actor_user_id, data FROM events WHERE type = 'request.state_changed' AND data ->> 'requestId' = $1 ORDER BY number",
    [requestId],
  );
  return rows;
}

async function proposalCount(requestId: string): Promise<number> {
  const { rows } = await install.owner.query<{ count: number }>("SELECT count(*)::int AS count FROM proposals WHERE request_id = $1", [requestId]);
  return rows[0]?.count ?? 0;
}

describe("a pull request that qualifies", () => {
  it("moves a claimed request it was linked to before merging to done, with no proposal, for the member who merged it", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });

    await mergedPullRequest("acme/web", {}, async (number) => {
      await install.execute("requests.link_pr", sessionOf(bob), { key: request.key, url: `https://github.com/acme/web/pull/${number}` });
    });

    expect((await stateOf(request.id)).state).toBe("done");
    expect(await proposalCount(request.id)).toBe(0);
    expect(await stateChangesOf(request.id)).toEqual([
      { actor_kind: "integration", surface: "github", actor_user_id: bob, data: { requestId: request.id, state: "done", previousState: "claimed" } },
    ]);
  });

  it("moves an in_progress request whose key is in the branch name to done", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: request.key, state: "in_progress" });

    await mergedPullRequest("acme/web", { head: `${request.key}-new-payment-fields` });

    expect((await stateOf(request.id)).state).toBe("done");
  });

  it("moves a request whose key is in the title, written in lower case, or in the body, to done, also while it waits on a question", async () => {
    const titled = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: titled.key });
    await mergedPullRequest("acme/web", { title: `Use the new fields (${titled.key.toLowerCase()})` });
    expect((await stateOf(titled.id)).state).toBe("done");

    const waiting = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: waiting.key });
    await install.execute("messages.post", sessionOf(bob), { key: waiting.key, kind: "question", blocking: true, body: "Which currency?" });
    expect((await stateOf(waiting.id)).state).toBe("needs_info");
    await mergedPullRequest("acme/web", { body: `This closes ${waiting.key}.\n\nIt moves the header too.` });
    expect((await stateOf(waiting.id)).state).toBe("done");
  });

  it("cancels the request's pending proposals as its terminal state does", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: request.key, state: "declined" });

    await mergedPullRequest("acme/web", { head: `fix/${request.key}` });

    const { rows } = await install.owner.query("SELECT state, cancel_reason FROM proposals WHERE request_id = $1", [request.id]);
    expect(rows).toEqual([{ state: "cancelled", cancel_reason: "terminal_state" }]);
  });

  it("acts for no user when the member who merged it was removed, and still closes the request", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await mergedPullRequest("acme/web", { head: `${request.key}-header`, author: "dana", mergedBy: "dana" }, async () => {
      await install.owner.query("DELETE FROM team_members WHERE user_id = $1", [dana]);
      await install.owner.query("DELETE FROM members WHERE user_id = $1", [dana]);
    });

    expect(await stateChangesOf(request.id)).toEqual([
      { actor_kind: "integration", surface: "github", actor_user_id: null, data: { requestId: request.id, state: "done", previousState: "claimed" } },
    ]);
  });
});

describe("a pull request that does not qualify", () => {
  it("leaves a request whose claim was released before the merge open", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await mergedPullRequest("acme/web", {}, async (number) => {
      await install.execute("requests.link_pr", sessionOf(bob), { key: request.key, url: `https://github.com/acme/web/pull/${number}` });
      await install.execute("requests.set_status", sessionOf(bob), { key: request.key, state: "open" });
    });

    expect(await stateOf(request.id)).toEqual({ state: "open", claimant_user_id: null });
  });

  it("leaves a request alone when the pull request merged before it was claimed", async () => {
    const request = await feRequest();
    const opened = await stub.openPullRequest("acme/web", { title: `Fix ${request.key}`, head: "fix-early", author: "bob" });
    await stub.mergePullRequest("acme/web", opened.number, { by: "bob" });
    // GitHub's merge times are to the second: the claim comes in a later second.
    await sleep(1_100);
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });

    await deliver("acme/web", opened.number, "closed");

    expect((await stateOf(request.id)).state).toBe("claimed");
  });

  it("leaves an open request that a merged pull request was linked to open", async () => {
    const request = await feRequest();
    await mergedPullRequest("acme/web", {}, async (number) => {
      await install.execute("requests.link_pr", sessionOf(bob), { key: request.key, url: `https://github.com/acme/web/pull/${number}` });
    });

    expect((await stateOf(request.id)).state).toBe("open");
  });

  it("changes nothing for a pull request in a repository no connected installation covers", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    const opened = await stub.openPullRequest("acme/tools", { title: `Fix ${request.key}`, head: `${request.key}-tools`, author: "bob" });
    const merged = await stub.mergePullRequest("acme/tools", opened.number, { by: "bob" });
    // GitHub sends the installation nothing about acme/tools; a forged delivery that names it is read and dropped.
    const [installation] = stub.installations(provider.app);
    const delivery = await stub.deliver(provider.app, "pull_request", {
      action: "closed",
      number: merged.number,
      pull_request: { number: merged.number, state: "closed", merged_at: merged.mergedAt, title: merged.title, head: { ref: merged.head.ref }, base: { ref: "main" } },
      repository: { id: merged.repo.id, full_name: "acme/tools" },
      installation: { id: installation!.id },
      sender: { id: provider.account("bob"), login: "bob" },
    });
    await processDelivery({ database: install.db, github: provider.github, execute: install.execute }, await storeDelivery(install, delivery!));

    expect((await stateOf(request.id)).state).toBe("claimed");
  });

  it("never lets the provider pull request close a request of its own change set, even when it mentions and links it", async () => {
    const opened = await stub.openPullRequest("acme/payments", { title: "New payment fields", head: "deniz-payment-fields", author: "deniz" });
    await install.execute("contract.report", ciRun(), reportOf("payments-api", changesOf("breaking"), { pullRequest: opened.number }));
    clock = new Date(clock.getTime() + 3 * 60 * 1000);
    await runDueUpdates(install, clock);
    const { rows } = await install.owner.query<{ id: string; key: string }>(
      `SELECT r.id, t.key || '-' || r.number AS key FROM contract_change_requests c
         JOIN contract_change_sets s ON s.id = c.change_set_id JOIN requests r ON r.id = c.request_id JOIN teams t ON t.id = r.target_team_id
        WHERE s.pull_request_number = $1`,
      [opened.number],
    );
    const fe = rows[0]!;
    await install.execute("requests.claim", sessionOf(bob), { key: fe.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: fe.key, state: "in_progress" });
    await install.execute("requests.link_pr", sessionOf(bob), { key: fe.key, url: `https://github.com/acme/payments/pull/${opened.number}` });
    await stub.editPullRequest("acme/payments", opened.number, { body: `FE asked for this in ${fe.key}.` });

    await stub.mergePullRequest("acme/payments", opened.number, { by: "deniz" });
    await deliver("acme/payments", opened.number, "closed");

    expect((await stateOf(fe.id)).state).toBe("in_progress");
    const { rows: shipped } = await install.owner.query("SELECT count(*)::int AS count FROM events WHERE type = 'request.provider_change_shipped' AND data ->> 'requestId' = $1", [fe.id]);
    expect(shipped).toEqual([{ count: 1 }]);
  });
});

describe("a merge on a trial install, whose GitHub App has no webhook", () => {
  let trial: TestInstall;
  let trialStub: GitHubStub;
  let trialProvider: StubProvider;
  let carol: string;

  beforeAll(async () => {
    trial = await startTestInstall();
    trialStub = await startGitHubStub();
    trialProvider = await providerOnStub(trial, trialStub, ["carol", "alice"], { repositories: ["acme/web"] });
    await trial.owner.query("UPDATE github_app SET mode = 'polling', polled_at = NULL");
    const alice = await addUser(trial.owner, { login: "alice", githubAccountId: trialProvider.account("alice") });
    carol = await addUser(trial.owner, { login: "carol", githubAccountId: trialProvider.account("carol") });
    const be = await addTeam(trial.owner, "BE");
    const fe = await addTeam(trial.owner, "FE");
    await joinTeams(trial.owner, alice, be);
    await joinTeams(trial.owner, carol, fe);
  }, 60_000);

  afterAll(async () => {
    await trialStub?.close();
    await trial?.close();
  });

  it("moves a claimed request to done once the poll finds the merge, with no delivery, for no user", async () => {
    const { rows } = await trial.owner.query<{ id: string }>("SELECT id FROM users WHERE github_login = 'alice'");
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(trial, rows[0]!.id, { targetTeam: "FE" });
    await trial.execute("requests.claim", sessionOf(carol), { key: request.key });
    const opened = await trialStub.openPullRequest("acme/web", { title: "Header", head: `${request.key}-header`, author: "carol" });
    await trialStub.mergePullRequest("acme/web", opened.number, { by: "carol" });
    expect(trialStub.deliveries(trialProvider.app)).toEqual([]);

    // The poll that runs every 60 seconds, and the processing of what it found.
    const sent: { queue: string; data: JobData }[] = [];
    const app = await trialProvider.github.app();
    await pollGitHubChanges({ database: trial.db, app: app!, jobs: { send: async (_tx, queue, data) => void sent.push({ queue, data }) }, now: () => new Date() });
    for (const { queue, data } of sent) {
      if (queue === processGitHubDelivery.type.queue) {
        await processDelivery({ database: trial.db, github: trialProvider.github, execute: trial.execute }, (data as { deliveryId: string }).deliveryId);
      }
    }

    const { rows: states } = await trial.owner.query("SELECT state FROM requests WHERE id = $1", [request.id]);
    expect(states).toEqual([{ state: "done" }]);
    const { rows: events } = await trial.owner.query(
      "SELECT actor_kind, actor_user_id FROM events WHERE type = 'request.state_changed' AND data ->> 'requestId' = $1",
      [request.id],
    );
    expect(events).toEqual([{ actor_kind: "integration", actor_user_id: null }]);
  });
});

describe("the request keys a pull request mentions", () => {
  it("are found in either case, each once, with no letter or digit right before and no digit right after", () => {
    expect(mentionedKeys("Fix FE-142 and fe-142", "", "fe-143-new-fields")).toEqual(["FE-142", "FE-143"]);
    expect(mentionedKeys("feature/WEB-7: closes (ops-12).")).toEqual(["WEB-7", "OPS-12"]);
    expect(mentionedKeys("9FE-142, FE-1420x, FE-0, F-1, FE-")).toEqual(["FE-1420"]);
  });

  it("are read up to 50", () => {
    const body = Array.from({ length: 60 }, (_, index) => `FE-${index + 1}`).join(" ");
    expect(mentionedKeys(body)).toHaveLength(50);
  });
});

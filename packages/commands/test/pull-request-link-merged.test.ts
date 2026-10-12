import { randomUUID } from "node:crypto";
import { OPENAPI_JSON } from "@tiehall/catalog";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInstallGitHub, processDelivery } from "../src/index.ts";
import { storeDelivery } from "./support/github-app.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequestInTheWebUi, sessionOf, tokenOf } from "./support/requests.ts";

// Linking a merged pull request, and set_status to done, follow close on
// merge (requests: Linked PRs and done on merge; agent-surfaces: Commitment
// tools return proposals; requests: System actions need no proposal or
// confirmation; public-api: One error model for Tiehall's own refusals;
// design.md, Decisions this change rests on: D23; design.md, Design rules:
// Requests and events). Linking a pull request reads it from GitHub, through
// the connected installation that covers its repository, before the link is
// stored: one that had already merged, linked by a member of the request's
// target team while the request's state allows done, is linked and creates a
// done proposal with that member as its accountable human, which the call
// answers with, 202 on REST; linked by anyone else, or to a request whose
// state does not allow done, it is only linked. GitHub failing the read gets
// 502 and links nothing. Until Tiehall has processed the merge that closes a
// request on merge, set_status to done creates a done proposal, and once close
// on merge has moved the request to done, set_status to done answers with the
// request and proposes nothing. The GitHub stub plays GitHub: acme/web is
// covered, acme/tools is not.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let alice: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["alice", "bob"], { hook: true, repositories: ["acme/web"] });
  stub.addRepo("acme/tools");
  alice = await addUser(install.owner, { login: "alice", githubAccountId: provider.account("alice") });
  bob = await addUser(install.owner, { login: "bob", githubAccountId: provider.account("bob") });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.useGitHub(provider.github);
});

/** A request Alice opens to FE, which Bob claims and starts unless it should stay open; returns its key and id. */
async function feRequest(state: "open" | "in_progress" = "in_progress"): Promise<{ key: string; id: string }> {
  const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
  if (state === "in_progress") {
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: request.key, state: "in_progress" });
  }
  return request;
}

/** A pull request on a repository of acme by Bob, merged unless it should stay open; its URL and number. */
async function pullRequest(repository = "acme/web", merged = true): Promise<{ url: string; number: number }> {
  const opened = await stub.openPullRequest(repository, { title: "Update the header", head: `update-${randomUUID().slice(0, 8)}`, author: "bob" });
  if (merged) await stub.mergePullRequest(repository, opened.number, { by: "bob" });
  return { url: `https://github.com/${repository}/pull/${opened.number}`, number: opened.number };
}

async function link(userId: string, key: string, url: string) {
  return callApi(install, tokenOf(userId), "POST", `/api/v1/requests/${key}/pull-requests`, { url });
}

async function stateOf(id: string): Promise<string> {
  const { rows } = await install.owner.query<{ state: string }>("SELECT state FROM requests WHERE id = $1", [id]);
  return rows[0]?.state ?? "";
}

async function linksOf(id: string): Promise<{ number: number }[]> {
  const { rows } = await install.owner.query("SELECT number FROM pull_request_links WHERE request_id = $1 ORDER BY linked_at", [id]);
  return rows;
}

async function proposalsOf(id: string): Promise<{ kind: string; state: string; accountable_user_id: string }[]> {
  const { rows } = await install.owner.query("SELECT kind, state, accountable_user_id FROM proposals WHERE request_id = $1 ORDER BY created_at", [id]);
  return rows;
}

describe("linking a pull request that had already merged", () => {
  it("as a member of the target team, links it and creates a done proposal with them as its accountable human, answered with 202", async () => {
    const request = await feRequest();
    const { url, number } = await pullRequest();

    const answer = await link(bob, request.key, url);

    expect(answer.status).toBe(202);
    expect(answer.body.proposal).toMatchObject({ kind: "done", state: "pending", accountableHuman: { id: bob }, request: { key: request.key } });
    expect(await stateOf(request.id)).toBe("in_progress");
    expect(await linksOf(request.id)).toEqual([{ number }]);
    expect(await proposalsOf(request.id)).toEqual([{ kind: "done", state: "pending", accountable_user_id: bob }]);
  });

  it("as the requester, only links it", async () => {
    const request = await feRequest();
    const { url, number } = await pullRequest();

    const answer = await link(alice, request.key, url);

    expect(answer.status).toBe(200);
    expect(answer.body.pullRequest).toMatchObject({ number });
    expect(await proposalsOf(request.id)).toEqual([]);
    expect(await stateOf(request.id)).toBe("in_progress");
  });

  // The requester side linking it first does not keep the target team's link of it from making the proposal; the
  // link it has answers, and stays one that its merge, which came before the target team's link, does not count.
  it("as a member of the target team, after the requester linked it, creates a done proposal with the same link", async () => {
    const request = await feRequest();
    const { url, number } = await pullRequest();
    expect((await link(alice, request.key, url)).status).toBe(200);

    const answer = await link(bob, request.key, url);

    expect(answer.status).toBe(202);
    expect(answer.body.proposal).toMatchObject({ kind: "done", state: "pending", accountableHuman: { id: bob }, request: { key: request.key } });
    expect(await stateOf(request.id)).toBe("in_progress");
    expect(await linksOf(request.id)).toEqual([{ number }]);
    const { rows } = await install.owner.query("SELECT actor_user_id, target_side FROM pull_request_links WHERE request_id = $1", [request.id]);
    expect(rows).toEqual([{ actor_user_id: alice, target_side: false }]);
  });

  it("to an open request, only links it", async () => {
    const request = await feRequest("open");
    const { url, number } = await pullRequest();

    const answer = await link(bob, request.key, url);

    expect(answer.status).toBe(200);
    expect(await linksOf(request.id)).toEqual([{ number }]);
    expect(await proposalsOf(request.id)).toEqual([]);
  });

  it("creates no proposal for a pull request that has not merged", async () => {
    const request = await feRequest();
    const { url } = await pullRequest("acme/web", false);

    expect((await link(bob, request.key, url)).status).toBe(200);
    expect(await proposalsOf(request.id)).toEqual([]);
  });

  it("only links a pull request of a repository no connected installation covers, which Tiehall cannot read", async () => {
    const request = await feRequest();
    const { url, number } = await pullRequest("acme/tools");

    expect((await link(bob, request.key, url)).status).toBe(200);
    expect(await linksOf(request.id)).toEqual([{ number }]);
    expect(await proposalsOf(request.id)).toEqual([]);
  });

  it("is refused with 502 and links nothing when GitHub fails the read", async () => {
    const request = await feRequest();
    const { url } = await pullRequest();
    // GitHub cannot be reached: the install's App calls a port where nothing listens.
    install.useGitHub(createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: "http://127.0.0.1:9", fetch, logger: install.logger }));

    const answer = await link(bob, request.key, url);

    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/integration-unavailable", status: 502 });
    expect(await linksOf(request.id)).toEqual([]);
    expect(await proposalsOf(request.id)).toEqual([]);
    // The published document names that answer.
    const document = JSON.parse(OPENAPI_JSON) as { paths: Record<string, { post: { responses: Record<string, { description: string }> } }> };
    const operation = document.paths["/api/v1/requests/{key}/pull-requests"];
    expect(operation?.post.responses["502"]?.description).toContain("nothing was linked");
  });
});

describe("set_status to done with a qualifying merged pull request", () => {
  it("creates a done proposal before close on merge arrives, and answers with the request once close on merge has moved it to done", async () => {
    const request = await feRequest();
    const opened = await stub.openPullRequest("acme/web", { title: `Fix ${request.key}`, head: `${request.key}-fix`, author: "bob" });
    await stub.mergePullRequest("acme/web", opened.number, { by: "bob" });

    // Tiehall has not processed the merge yet.
    const before = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "done" });
    expect(before.status).toBe(202);
    expect(before.body.proposal).toMatchObject({ kind: "done", state: "pending" });
    expect(await stateOf(request.id)).toBe("in_progress");

    const delivery = stub
      .deliveries(provider.app)
      .filter(({ event, request: sent }) => event === "pull_request" && (sent.payload as { number?: number; action?: string }).number === opened.number && (sent.payload as { action?: string }).action === "closed")
      .at(-1);
    await processDelivery({ database: install.db, github: provider.github, execute: install.execute }, await storeDelivery(install, delivery!));
    expect(await stateOf(request.id)).toBe("done");
    // Close on merge ended the waiting proposal, as every terminal state does.
    expect(await proposalsOf(request.id)).toEqual([{ kind: "done", state: "cancelled", accountable_user_id: bob }]);

    const after = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "done" });
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ key: request.key, state: "done" });
    expect(await proposalsOf(request.id)).toHaveLength(1);
  });
});

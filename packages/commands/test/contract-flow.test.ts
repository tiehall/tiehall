import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { createActionsOidc, type ActionsOidc } from "@tiehall/testing/oidc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repositoryOf, runActionWith, type Npx, type Repository } from "../../../actions/contract/test/support/runner.ts";
import { createAgentTokenCheck, createApiCallerCheck, createCiTokenCheck, createRestHandler, processDelivery, type RestHandler } from "../src/index.ts";
import type { TiehallCli } from "./support/cli.ts";
import { CONTRACT_WORKFLOW, CONTRACT_WORKFLOW_FILE, providerOnStub, runDueUpdates, type StubProvider } from "./support/contract.ts";
import { storeDelivery } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, sessionOf, tokenOf } from "./support/requests.ts";

// The contract flow end to end, against the GitHub stub (contract-changes:
// The contract Action; contract-changes: Breaking changes open one request per
// consuming team; contract-changes: Each update adds a packet revision and a
// system message; contract-changes: Consumers close requests with their own
// PR; contract-changes: Merging the provider PR marks the change shipped;
// design.md, Decisions this change rests on: D14; design.md, Technical
// decisions: T12, T17). A fixture workflow run of the contract Action, with
// git and the pinned oasdiff running for real on a checkout of acme/payments,
// reports a provider pull request's breaking changes with the tiehall CLI of
// this repository, which asks GitHub Actions' token service, played by a test
// issuer, for the run's OIDC token, and sends the report to the install's
// real REST route, which checks the token against that issuer's keys. FE and
// MOBILE, which declared that they consume payments-api, each get a request.
// A later push that leaves the document alone makes the Action report the
// same changes again, which adds nothing (decisions-from-groups-15-28, D55
// (64)); a push that changes the document makes it report again, and each
// request gets a packet revision and a system message. FE's own pull request, whose branch names
// FE's request, merges after FE claimed it and closes it, and the provider
// pull request's merge marks the change shipped on both, closing neither.
// GitHub's deliveries are logged by the stub, and stored and processed as the
// install's webhook route and worker do.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let oidc: ActionsOidc;
let route: RestHandler;
let scratch: string;
let clock = new Date("2026-10-20T08:00:00Z");
let bob: string;

/** GitHub Actions' token service, as the fixture runner names it to the step. */
const TOKEN_SERVICE = "https://pipelines.actions.example.net";

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  stub = await startGitHubStub();
  oidc = createActionsOidc();
  provider = await providerOnStub(install, stub, ["deniz", "bob", "erin"], { hook: true, repositories: ["acme/web"] });
  const ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  const deniz = await addUser(install.owner, { login: "deniz", githubAccountId: provider.account("deniz") });
  bob = await addUser(install.owner, { login: "bob", githubAccountId: provider.account("bob") });
  const erin = await addUser(install.owner, { login: "erin", githubAccountId: provider.account("erin") });
  const pay = await addTeam(install.owner, "PAY");
  const fe = await addTeam(install.owner, "FE");
  const mobile = await addTeam(install.owner, "MOBILE");
  await joinTeams(install.owner, deniz, pay);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, erin, mobile);
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments", workflow: CONTRACT_WORKFLOW_FILE })).status).toBe(200);
  const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM apis WHERE name = 'payments-api'");
  const api = rows[0]?.id ?? "";
  await install.execute("apis.declare_consumer", sessionOf(bob), { api, team: fe });
  await install.execute("apis.declare_consumer", sessionOf(erin), { api, team: mobile });
  route = createRestHandler({
    catalog: CATALOG,
    document: OPENAPI_JSON,
    execute: install.execute,
    authenticate: createApiCallerCheck({
      agent: createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: async () => undefined, database: install.db }),
      ci: createCiTokenCheck({ url: URL_OF_INSTALL, database: install.db, keys: async () => oidc.jwks }),
    }),
    logger: install.logger,
  });
  scratch = mkdtempSync(join(tmpdir(), "tiehall-contract-flow-"));
}, 120_000);

afterAll(async () => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  await stub?.close();
  await install?.close();
});

/**
 * The pinned tiehall CLI as the Action runs it with npx: the CLI of this
 * repository, in this process, whose fetch reaches GitHub Actions' token
 * service, which gives a token for the run of the contract workflow in
 * acme/payments, and the install's REST route; nothing else.
 */
const pinnedCli: Npx = async (args, env) => {
  const cli = (await import("tiehall")) as unknown as TiehallCli;
  let stdout = "";
  let stderr = "";
  const status = await cli.run({
    argv: args.slice(args.findIndex((arg) => arg.startsWith("tiehall@")) + 1),
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.origin === TOKEN_SERVICE) {
        const token = oidc.token({
          audience: url.searchParams.get("audience") ?? "",
          repository: "acme/payments",
          repositoryId: provider.repositoryId,
          repositoryOwnerId: provider.ownerId,
          jobWorkflowRef: CONTRACT_WORKFLOW,
        });
        return Response.json({ value: token });
      }
      if (url.origin === URL_OF_INSTALL) return route(request);
      throw new TypeError(`fetch failed: ${url.origin} cannot be reached`);
    },
  });
  return { status, stdout, stderr };
};

/** Runs git in the checkout, and throws when it fails. */
function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
  return run.stdout.trim();
}

/** Stores the latest delivery GitHub made about a pull request with this action, and processes it as the worker does. */
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

/** The worker applies the change set's update once the report's burst has ended. */
async function applyUpdates(): Promise<void> {
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
}

interface ReadRequest {
  key: string;
  state: string;
  requester: { user: { login: string } | null; team: { key: string } };
  providerChange: { status: string; shippedAt: string | null } | null;
  messages: { provenance: { actorKind: string; surface: string | null }; untrusted: { body: string } }[];
}

/** A request as /api/v1 returns it to Bob. */
async function read(key: string): Promise<ReadRequest> {
  const answer = await callApi<ReadRequest>(install, tokenOf(bob), "GET", `/api/v1/requests/${key}`);
  expect(answer.status).toBe(200);
  return answer.body;
}

/** The packet of a request at its current revision, as /api/v1 returns it. */
async function packetOf(key: string): Promise<{ revision: number; packet: { untrusted: { contract: { head: { sha: string }; changes: { level: string }[] } } } }> {
  const answer = await callApi(install, tokenOf(bob), "GET", `/api/v1/requests/${key}/packet`);
  expect(answer.status).toBe(200);
  return answer.body;
}

/** The requests the provider pull request's reports opened, by their team's key. */
async function contractRequests(number: number): Promise<Record<string, string>> {
  const { rows } = await install.owner.query<{ team: string; key: string }>(
    `SELECT t.key AS team, t.key || '-' || r.number AS key FROM contract_change_requests c
       JOIN contract_change_sets s ON s.id = c.change_set_id JOIN requests r ON r.id = c.request_id JOIN teams t ON t.id = r.target_team_id
      WHERE s.pull_request_number = $1`,
    [number],
  );
  return Object.fromEntries(rows.map(({ team, key }) => [team, key]));
}

describe("the contract flow, from the Action's run to the provider's merge", () => {
  it("opens a request to each declaring team, revises them on a push, lets the consumer's PR close its own on merge and marks the change shipped when the provider PR merges", async () => {
    // Deniz opens the provider pull request on GitHub, and the contract workflow runs the Action on it.
    const providerPr = await stub.openPullRequest("acme/payments", { title: "New payment fields", head: "new-payment-fields", author: "deniz" });
    const checkout = repositoryOf(scratch, "breaking");
    const opened = await runActionWith(scratch, { number: providerPr.number, repository: checkout, npx: pinnedCli, inputs: { "install-url": URL_OF_INSTALL } });
    expect(opened.code).toBe(0);
    expect(opened.outputs["reported"]).toBe("true");
    await applyUpdates();

    // FE and MOBILE each get one request, with Deniz, the pull request's author, as the requester.
    const keys = await contractRequests(providerPr.number);
    expect(Object.keys(keys).sort()).toEqual(["FE", "MOBILE"]);
    for (const key of Object.values(keys)) {
      const request = await read(key);
      expect(request).toMatchObject({ state: "open", requester: { user: { login: "deniz" }, team: { key: "PAY" } }, providerChange: { status: "open", shippedAt: null } });
      const packet = await packetOf(key);
      expect(packet.revision).toBe(1);
      expect(packet.packet.untrusted.contract.changes.filter(({ level }) => level === "ERR")).toHaveLength(2);
      expect(packet.packet.untrusted.contract.head.sha).toBe(checkout.head);
    }

    // A push that leaves the document alone: the Action reports the same changes again, which adds nothing.
    writeFileSync(join(checkout.path, "README.md"), "The payments service, with the new payment fields.\n");
    git(checkout.path, "commit", "--quiet", "--all", "--message", "A push");
    const readme: Repository = { ...checkout, head: git(checkout.path, "rev-parse", "HEAD") };
    const unchanged = await runActionWith(scratch, { number: providerPr.number, repository: readme, action: "synchronize", npx: pinnedCli, inputs: { "install-url": URL_OF_INSTALL } });
    expect(unchanged.code).toBe(0);
    expect(unchanged.outputs["reported"]).toBe("true");
    await applyUpdates();
    for (const key of Object.values(keys)) {
      expect((await packetOf(key)).revision).toBe(1);
      expect((await read(key)).messages).toEqual([]);
    }

    // A push that adds an operation to the document: the Action runs on synchronize and reports again, which adds a revision and a system message.
    const document = join(checkout.path, "openapi", "payments.yaml");
    writeFileSync(document, readFileSync(document, "utf8").replace("paths:\n", 'paths:\n  /receipts:\n    get:\n      responses:\n        "200":\n          description: The receipts.\n'));
    git(checkout.path, "commit", "--quiet", "--all", "--message", "Another push");
    const pushed: Repository = { ...checkout, head: git(checkout.path, "rev-parse", "HEAD") };
    const synchronized = await runActionWith(scratch, { number: providerPr.number, repository: pushed, action: "synchronize", npx: pinnedCli, inputs: { "install-url": URL_OF_INSTALL } });
    expect(synchronized.code).toBe(0);
    await applyUpdates();
    for (const key of Object.values(keys)) {
      const packet = await packetOf(key);
      expect(packet.revision).toBe(2);
      expect(packet.packet.untrusted.contract.head.sha).toBe(pushed.head);
      const [message] = (await read(key)).messages;
      expect(message?.provenance).toMatchObject({ actorKind: "system", surface: "github" });
      expect(message?.untrusted.body).toContain("Diff updated: 2 → 2 breaking");
    }

    // Bob claims FE's request, and FE's own pull request, whose branch names it, merges in acme/web.
    const fe = keys["FE"] ?? "";
    await install.execute("requests.claim", sessionOf(bob), { key: fe });
    const consumerPr = await stub.openPullRequest("acme/web", { title: "Use the new payment fields", head: `${fe}-new-payment-fields`, author: "bob" });
    await stub.mergePullRequest("acme/web", consumerPr.number, { by: "bob" });
    await deliver("acme/web", consumerPr.number, "closed");
    expect((await read(fe)).state).toBe("done");

    // The provider pull request merges: the change ships on both requests, and MOBILE's stays open for MOBILE's own pull request.
    const merged = await stub.mergePullRequest("acme/payments", providerPr.number, { by: "deniz" });
    await deliver("acme/payments", providerPr.number, "closed");
    const mobile = await read(keys["MOBILE"] ?? "");
    expect(mobile).toMatchObject({ state: "open", providerChange: { status: "merged", shippedAt: new Date(merged.mergedAt!).toISOString() } });
    expect(await read(fe)).toMatchObject({ state: "done", providerChange: { status: "merged" } });
  }, 120_000);
});

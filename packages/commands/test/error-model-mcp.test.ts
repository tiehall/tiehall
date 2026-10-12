import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstallGitHub, readInstallations } from "../src/index.ts";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, mcpPerson, MODERN, PROBLEM, problemOf, type McpPerson } from "./support/mcp.ts";
import { openRequestInTheWebUi } from "./support/requests.ts";

// The rows of the error model that the MCP tools report as tool errors and no
// other test showed on MCP (public-api: One error model for Tiehall's own
// refusals; agent-safety: Runaway agent loops flag the request needs_human;
// agent-safety: Agent writes are limited per token and budgeted per install;
// agent-access: Personal access tokens; github-layer-hardening: design.md,
// Decisions this change rests on: D50 (3)). The MCP tools refuse in the same
// cases as REST and report each refusal as a tool result with isError set,
// whose content is the problem and names its type: an agent's write to a
// request flagged needs_human; link_pr when GitHub fails the read of the pull
// request; a personal access token's call once an admin has switched personal
// access tokens off; and an agent's write past the install's daily budget,
// with when to retry. tools/repo-checks/error-model-tests.json names, for every
// row, its test on REST and, where tool errors apply, on MCP, and
// `pnpm check:error-model` makes sure each one exists.

let harness: AgentAccessHarness;
let ada: McpPerson;
let sam: McpPerson;
let dana: McpPerson;

beforeAll(async () => {
  harness = await startAgentAccess();
  ada = await mcpPerson(harness, "ada", { role: "admin" });
  sam = await mcpPerson(harness, "sam-qa", { teams: ["QA"] });
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** A request QA opens to FE in the web UI. */
const openToFe = () => openRequestInTheWebUi<{ id: string; key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "QA" });

/** Calls a tool as the holder of this token, on protocol version 2026-07-28. */
async function call(token: string, name: string, args: Record<string, unknown>) {
  const client = await connectMcp(harness, { token, version: MODERN });
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

describe("the MCP tools", () => {
  it("answer an agent's write to a request flagged needs_human with a tool error naming needs-human, and post nothing", async () => {
    const request = await openToFe();
    // The seventh agent write within 10 minutes is taken and flags the request.
    for (let write = 1; write <= 7; write += 1) {
      const posted = await call(dana.token, "post_message", { key: request.key, kind: "comment", body: `Comment ${write}.` });
      expect(posted.isError ?? false, `write ${write}`).toBe(false);
    }
    const refused = await call(dana.token, "post_message", { key: request.key, kind: "comment", body: "One more." });
    expect(problemOf(refused)).toMatchObject({ type: `${PROBLEM}needs-human`, status: 409 });
    const { rows } = await harness.install.owner.query("SELECT count(*)::int AS count FROM messages WHERE request_id = $1", [request.id]);
    expect(rows[0]?.count).toBe(7);
  });

  it("answer link_pr with a tool error naming integration-unavailable when GitHub fails the read of the pull request, and link nothing", async () => {
    // FE's pull request is in acme/web, which the connected installation of the install's App covers.
    harness.stub.addRepo("acme/web");
    await harness.stub.addMember("acme", "ada", "admin");
    await harness.stub.install(harness.signIn.app, { account: "acme", repositories: ["acme/web"], by: "ada" });
    await harness.signIn.connect("acme");
    const app = await harness.signIn.github.app();
    if (app === undefined) throw new Error("The install stores no App.");
    await readInstallations({ database: harness.install.db, app });
    const pull = await harness.stub.openPullRequest("acme/web", { title: "Fix the settings page", head: "fix-settings", author: "dana-fe" });
    const request = await openToFe();
    // GitHub cannot be reached: the install's App calls a port where nothing listens.
    harness.install.useGitHub(createInstallGitHub({ database: harness.install.db, secrets: () => harness.install.box, apiUrl: "http://127.0.0.1:9", fetch, logger: harness.install.logger }));
    const refused = await call(dana.token, "link_pr", { key: request.key, url: `https://github.com/acme/web/pull/${pull.number}` });
    expect(problemOf(refused)).toMatchObject({ type: `${PROBLEM}integration-unavailable`, status: 502 });
    const { rows } = await harness.install.owner.query("SELECT count(*)::int AS count FROM pull_request_links WHERE request_id = $1", [request.id]);
    expect(rows[0]?.count).toBe(0);
  });

  it("answer a personal access token's call with a tool error naming personal-access-tokens-off once an admin has switched them off", async () => {
    const pat = await harness.personalAccessToken({ userId: dana.userId, cookie: dana.cookie }, { scopes: ["requests:read", "requests:write"] });
    expect((await call(pat, "whoami", {})).isError ?? false).toBe(false);
    expect((await harness.install.confirm(ada.session, "settings.set_personal_access_tokens", { on: false })).status).toBe(200);
    try {
      expect(problemOf(await call(pat, "whoami", {}))).toMatchObject({ type: `${PROBLEM}personal-access-tokens-off`, status: 403 });
    } finally {
      expect((await harness.install.confirm(ada.session, "settings.set_personal_access_tokens", { on: true })).status).toBe(200);
    }
  });

  it("answer an agent's write past the install's daily budget with a tool error naming rate-limited, which says when to retry, and post nothing", async () => {
    const request = await openToFe();
    // The day's agent writes have spent a budget of one already.
    expect((await harness.install.confirm(ada.session, "settings.set_write_budget", { dailyWriteBudget: 1 })).status).toBe(200);
    const refused = await call(dana.token, "post_message", { key: request.key, kind: "comment", body: "Past the budget." });
    const problem = problemOf(refused) as { type?: string; status?: number; retryAfter?: number };
    expect(problem).toMatchObject({ type: `${PROBLEM}rate-limited`, status: 429 });
    expect(problem.retryAfter).toBeGreaterThan(0);
    const { rows } = await harness.install.owner.query("SELECT count(*)::int AS count FROM messages WHERE request_id = $1", [request.id]);
    expect(rows[0]?.count).toBe(0);
  });
});

// public-api: One error model for Tiehall's own refusals (decisions-from-groups-15-28: design.md, Decisions this
// change rests on: D55 (26)). A request whose Origin header names another origin than the install's is one of the
// refusals on /mcp that are HTTP statuses, not tool errors: 403 forbidden, before the token is checked, with a valid
// token too, and nothing runs.
describe("the HTTP statuses of /mcp", () => {
  it("answer a foreign Origin with HTTP 403 forbidden, not a tool result inside a 200, though the token is valid, and post nothing", async () => {
    const request = await openToFe();
    const answer = await harness.handle(
      new Request(`${URL_OF_INSTALL}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${dana.token}`,
          origin: "https://attacker.example",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post_message", arguments: { key: request.key, kind: "comment", body: "From a page." } } }),
      }),
    );
    expect(answer.status).toBe(403);
    expect(answer.headers.get("content-type")).toBe("application/problem+json");
    expect(await answer.json()).toMatchObject({ type: `${PROBLEM}forbidden`, status: 403 });
    const { rows } = await harness.install.owner.query("SELECT count(*)::int AS count FROM messages WHERE request_id = $1", [request.id]);
    expect(rows[0]?.count).toBe(0);
  });
});

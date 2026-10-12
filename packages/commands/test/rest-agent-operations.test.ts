import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { mcpPerson, PROBLEM, type McpPerson } from "./support/mcp.ts";
import { openRequestInTheWebUi, packetOf } from "./support/requests.ts";

// The operations behind the MCP tools that the CLI runs over /api/v1
// (agent-surfaces: CLI request commands; public-api: One definition per
// operation, the same on every surface; public-api: Packet revisions use ETag
// and If-Match; design.md, Where the specs leave room: the expected revision
// off REST). The CLI calls the REST API, so the operations behind list_inbox,
// get_request and propose are offered there too, and so is whoami, whose
// teams decide the origin of each text the CLI fences. On REST, propose takes
// the revision a packet change expects from If-Match, never from the body.

let harness: AgentAccessHarness;
let sam: McpPerson;
let dana: McpPerson;

beforeAll(async () => {
  harness = await startAgentAccess();
  sam = await mcpPerson(harness, "sam-be-qa", { teams: ["QA", "BE"] });
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  await mcpPerson(harness, "oli-ops", { teams: ["OPS"] });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

interface Answer<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

async function api<T = any>(person: McpPerson, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer<T>> {
  const answer = await harness.api(method, path, { authorization: `Bearer ${person.token}`, ...headers }, body);
  return { status: answer.status, headers: answer.headers, body: (await answer.json()) as T };
}

function openToFe(): Promise<{ id: string; key: string }> {
  return openRequestInTheWebUi(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "QA", packet: packetOf("Add a dark mode.") });
}

describe("whoami on /api/v1", () => {
  it("names the user, the teams they belong to by key, and the install by its URL", async () => {
    const answer = await api(sam, "GET", "/api/v1/whoami");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      user: { id: sam.userId, login: "sam-be-qa", kind: "human", bot: false },
      teams: [
        { id: expect.any(String), key: "BE" },
        { id: expect.any(String), key: "QA" },
      ],
      install: { url: URL_OF_INSTALL },
      warnings: [],
    });
  });
});

describe("the inbox on /api/v1", () => {
  it("lists the requests addressed to the caller's teams, and none addressed to another team", async () => {
    const toFe = await openToFe();
    const toOps = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "OPS", requestingTeam: "QA" });
    const answer = await api<{ "requests": { key: string }[] }>(dana, "GET", "/api/v1/inbox?state=open&limit=50");
    expect(answer.status).toBe(200);
    const keys = answer.body["requests"].map(({ key }) => key);
    expect(keys).toContain(toFe.key);
    expect(keys).not.toContain(toOps.key);
  });

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (28): without a state, the inbox
  // leaves out done, declined and withdrawn requests, 20 a call and at most 50; with one, it lists that state's.
  it("leaves out done, declined and withdrawn requests unless the state names one, 20 a call and at most 50", async () => {
    const opened: { id: string; key: string }[] = [];
    for (let index = 0; index < 22; index += 1) opened.push(await openToFe());
    const ended: Record<string, string> = {};
    for (const state of ["done", "declined", "withdrawn"]) {
      const request = await openToFe();
      await harness.install.owner.query("UPDATE requests SET state = $2 WHERE id = $1", [request.id, state]);
      ended[state] = request.key;
    }
    const firstPage = await api<{ "requests": { key: string; state: string }[] }>(dana, "GET", "/api/v1/inbox");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body["requests"].map(({ key }) => key)).toEqual(opened.slice(-20).reverse().map(({ key }) => key));
    const most = await api<{ "requests": { key: string; state: string }[] }>(dana, "GET", "/api/v1/inbox?limit=50");
    expect(most.body["requests"].length).toBeGreaterThan(20);
    for (const { key, state } of most.body["requests"]) {
      expect(["done", "declined", "withdrawn"], key).not.toContain(state);
    }
    const tooMany = await api(dana, "GET", "/api/v1/inbox?limit=51");
    expect(tooMany).toMatchObject({ status: 400, body: { type: `${PROBLEM}invalid-input` } });
    for (const [state, key] of Object.entries(ended)) {
      const inState = await api<{ "requests": { key: string; state: string }[] }>(dana, "GET", `/api/v1/inbox?state=${state}`);
      expect(inState.body["requests"].map(({ key: each }) => each)).toContain(key);
      expect(inState.body["requests"].every(({ state: each }) => each === state)).toBe(true);
    }
  });
});

describe("a request's pages on /api/v1", () => {
  it("reads a request by its key, or by its URL on the install, in the section and page the query names", async () => {
    const request = await openToFe();
    const byKey = await api(dana, "GET", `/api/v1/requests/${request.key}/pages?section=packet&page=1`);
    expect(byKey.status).toBe(200);
    expect(byKey.body).toMatchObject({ request: { key: request.key }, section: "packet", page: 1, next: null });
    const byUrl = await api(dana, "GET", `/api/v1/requests/${encodeURIComponent(`${URL_OF_INSTALL}/${request.key}`)}/pages?section=packet`);
    expect(byUrl.body).toEqual(byKey.body);
  });

  it("refuses a URL on another origin as input that fails the schema", async () => {
    const answer = await api(dana, "GET", `/api/v1/requests/${encodeURIComponent("https://other.example.net/FE-1")}/pages`);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: `${PROBLEM}invalid-input` });
  });
});

describe("propose on /api/v1", () => {
  it("answers a due date with 202 and the proposal, with the revision it expects taken from If-Match", async () => {
    const request = await openToFe();
    const answer = await api(dana, "POST", "/api/v1/proposals", { kind: "due_date", key: request.key, dueDate: "2026-10-15" }, { "if-match": '"1"' });
    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({ proposal: { kind: "due_date", state: "pending", accountableHuman: { id: dana.userId } } });
    expect(JSON.stringify(answer.body)).not.toContain("/confirm/");
  });

  it("gets 428 for a packet change without If-Match, even when the body names the revision, and 412 for a stale one, and proposes nothing", async () => {
    const request = await openToFe();
    const without = await api(sam, "POST", "/api/v1/proposals", { kind: "due_date", key: request.key, dueDate: "2026-10-15", expectedRevision: 1 });
    expect(without).toMatchObject({ status: 428, body: { type: `${PROBLEM}if-match-required` } });
    const stale = await api(sam, "POST", "/api/v1/proposals", { kind: "due_date", key: request.key, dueDate: "2026-10-15" }, { "if-match": '"5"' });
    expect(stale).toMatchObject({ status: 412, body: { type: `${PROBLEM}precondition-failed` } });
    const { rows } = await harness.install.owner.query("SELECT count(*)::int AS count FROM proposals WHERE request_id = $1", [request.id]);
    expect(rows[0]?.count).toBe(0);
  });

  it("proposes a reassignment and withdraws a pending proposal of the caller's, as the tool does", async () => {
    const request = await openToFe();
    const reassign = await api(dana, "POST", "/api/v1/proposals", { kind: "reassign", key: request.key, team: "OPS" });
    expect(reassign).toMatchObject({ status: 202, body: { proposal: { kind: "reassign", state: "pending" } } });
    const withdrawn = await api(dana, "POST", "/api/v1/proposals", { kind: "withdraw_proposal", proposal: reassign.body.proposal.id });
    expect(withdrawn.body).toMatchObject({ proposal: { id: reassign.body.proposal.id, state: "withdrawn" } });
  });
});

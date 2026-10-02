import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { changesOf } from "./support/contract.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, mcpPerson, PROBLEM, problemOf, PROTOCOL_VERSIONS, type McpPerson, type ProtocolVersion } from "./support/mcp.ts";
import { packetOf } from "./support/requests.ts";

// Attaching a contract diff to a request by hand (contract-changes: Attaching
// a contract diff to a request by hand; agent-access: OAuth scopes are coarse;
// agent-surfaces: The MCP tools; handoff-packet: Packet changes that are
// commitments; design.md, Decisions this change rests on: D14, D23; D28 #3,
// #15, #77; D30 (3)). A developer runs `tiehall contract diff` on their own
// machine and attaches the classified result to a request as the contract
// section of its packet, through the MCP tool attach_contract_changes or its
// REST operation, both of which need the contracts:report scope. Attaching
// follows the rules of packet changes: only the requester side attaches, the
// call names the revision it expects, as If-Match does on REST, and a missing
// or stale one is refused as REST refuses it; attaching to a claimed request
// changes its scope, a commitment, and becomes a proposal. Attaching routes
// nothing: it opens or updates no other request, whoever consumes the API.
// The changes are those the pinned oasdiff classified for the breaking pair of
// task 23.1.

let harness: AgentAccessHarness;
/** Deniz, of PAY, the provider team, whose agent may attach contract changes. */
let deniz: McpPerson;
/** Deniz's other agent, whose token lacks contracts:report. */
let denizWithoutContracts: McpPerson;
/** Mehmet, of FE, the target team. */
let mehmet: McpPerson;

const CONTRACT = {
  api: "payments-api",
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "new-payment-fields", sha: "b".repeat(40) },
  engine: { name: "oasdiff", version: "1.32.1" },
  changes: changesOf("breaking"),
  provider_pr: { repository: "acme/payments", number: 310 },
  provider_status: "open",
};

beforeAll(async () => {
  harness = await startAgentAccess();
  deniz = await mcpPerson(harness, "deniz-pay", { teams: ["PAY"], scopes: ["requests:read", "requests:write", "contracts:report"] });
  denizWithoutContracts = { ...deniz, token: (await harness.tokens(deniz, ["requests:read", "requests:write"])).accessToken };
  mehmet = await mcpPerson(harness, "mehmet-fe", { teams: ["FE"], scopes: ["requests:read", "requests:write", "contracts:report"] });
  const zeynep = await mcpPerson(harness, "zeynep-mobile", { teams: ["MOBILE"] });
  // MOBILE consumes payments-api, which PAY provides from acme/payments.
  const { owner } = harness.install;
  await owner.query(
    `INSERT INTO apis (org_id, name, provider_team_id, repository_id, repository_owner_id, repository_full_name, registered_by)
       SELECT orgs.id, 'payments-api', teams.id, 7001, 7000, 'acme/payments', $1 FROM orgs, teams WHERE teams.key = 'PAY'`,
    [deniz.userId],
  );
  await owner.query(
    `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
       SELECT apis.org_id, apis.id, teams.id, $1, now(), now() FROM apis, teams WHERE apis.name = 'payments-api' AND teams.key = 'MOBILE'`,
    [zeynep.userId],
  );
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

interface RevisionJson {
  request: { id: string; key: string };
  revision: number;
  packet: { kind: string; untrusted: { need: string; contract?: unknown } };
}

/** Opens a request to FE from PAY with Deniz's agent, as a member of PAY asks FE about the change; returns its key and id. */
async function openToFe(): Promise<{ id: string; key: string }> {
  const answer = await harness.api("POST", "/api/v1/requests", { authorization: `Bearer ${deniz.token}` }, {
    targetTeam: "FE",
    title: "Move to the new payment fields",
    packet: packetOf("The payments API drops the amount field; move to the new one."),
  });
  expect(answer.status).toBe(200);
  return (await answer.json()) as { id: string; key: string };
}

/** Attaches the contract over REST with this token and these headers. */
async function attachOverRest(token: string, key: string, headers: Record<string, string> = { "if-match": '"1"' }, contract: unknown = CONTRACT) {
  const answer = await harness.api("POST", `/api/v1/requests/${key}/contract-changes`, { authorization: `Bearer ${token}`, ...headers }, { contract });
  return { status: answer.status, headers: answer.headers, body: (await answer.json()) as any };
}

/** Calls attach_contract_changes as the person's agent on this protocol version. */
async function attachOverMcp(person: McpPerson, version: ProtocolVersion, args: Record<string, unknown>) {
  const client = await connectMcp(harness, { token: person.token, version });
  try {
    await client.listTools();
    return await client.callTool({ name: "attach_contract_changes", arguments: args });
  } finally {
    await client.close();
  }
}

/** The request's packet as it is now. */
async function packetNow(key: string): Promise<RevisionJson> {
  const answer = await harness.api("GET", `/api/v1/requests/${key}/packet`, { authorization: `Bearer ${deniz.token}` });
  return (await answer.json()) as RevisionJson;
}

/** How many proposals the request has. */
async function proposalCount(requestId: string): Promise<number> {
  return Number((await harness.install.owner.query("SELECT count(*) FROM proposals WHERE request_id = $1", [requestId])).rows[0].count);
}

describe("attaching a classified diff over REST", () => {
  it("adds the next packet revision, whose contract section carries the classified changes, the refs and the engine", async () => {
    const request = await openToFe();

    const answer = await attachOverRest(deniz.token, request.key);

    expect(answer.status).toBe(200);
    expect(answer.body.packet.revision).toBe(2);
    const current = await packetNow(request.key);
    expect(current.revision).toBe(2);
    expect(current.packet.kind).toBe("request");
    expect(current.packet.untrusted.need).toBe("The payments API drops the amount field; move to the new one.");
    expect(current.packet.untrusted.contract).toEqual(CONTRACT);
  });

  it("routes nothing to the teams that consume the API: MOBILE gets no request, and no report is stored", async () => {
    const before = Number((await harness.install.owner.query("SELECT count(*) FROM requests")).rows[0].count);
    const request = await openToFe();

    expect((await attachOverRest(deniz.token, request.key)).status).toBe(200);

    const { rows } = await harness.install.owner.query(
      `SELECT (SELECT count(*)::int FROM requests) AS opened,
              (SELECT count(*)::int FROM requests JOIN teams ON teams.id = requests.target_team_id WHERE teams.key = 'MOBILE') AS mobile,
              (SELECT count(*)::int FROM contract_reports) AS reports`,
    );
    expect(rows[0]).toEqual({ opened: before + 1, mobile: 0, reports: 0 });
  });

  it("becomes a scope-change proposal on a claimed request, and the packet keeps its revision", async () => {
    const request = await openToFe();
    expect((await harness.api("POST", `/api/v1/requests/${request.key}/claim`, { authorization: `Bearer ${mehmet.token}` })).status).toBe(200);

    const answer = await attachOverRest(deniz.token, request.key);

    expect(answer.status).toBe(202);
    expect(answer.body.proposal).toMatchObject({ kind: "scope", state: "pending" });
    expect(JSON.stringify(answer.body)).not.toContain("/confirm/");
    expect((await packetNow(request.key)).revision).toBe(1);
  });

  it("refuses a call that names no expected revision with 428, and a stale one with 412, and changes nothing", async () => {
    const request = await openToFe();

    const missing = await attachOverRest(deniz.token, request.key, {});
    const stale = await attachOverRest(deniz.token, request.key, { "if-match": '"7"' });

    expect(missing.status).toBe(428);
    expect(missing.body.type).toBe(`${PROBLEM}if-match-required`);
    expect(stale.status).toBe(412);
    expect((await packetNow(request.key)).revision).toBe(1);
    expect(await proposalCount(request.id)).toBe(0);
  });

  it("refuses a token without contracts:report with 403 insufficient_scope naming it, and the packet is unchanged", async () => {
    const request = await openToFe();

    const answer = await attachOverRest(denizWithoutContracts.token, request.key);

    expect(answer.status).toBe(403);
    expect(answer.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(answer.headers.get("www-authenticate")).toContain('scope="contracts:report"');
    expect(answer.body.type).toBe(`${PROBLEM}insufficient-scope`);
    expect((await packetNow(request.key)).revision).toBe(1);
  });

  it("refuses the target team, who is not the requester side, with 403", async () => {
    const request = await openToFe();

    const answer = await attachOverRest(mehmet.token, request.key);

    expect(answer.status).toBe(403);
    expect(answer.body.type).toBe(`${PROBLEM}forbidden`);
    expect((await packetNow(request.key)).revision).toBe(1);
  });

  it("refuses a contract section that fails the packet's schema with 400", async () => {
    const request = await openToFe();

    const answer = await attachOverRest(deniz.token, request.key, { "if-match": '"1"' }, { ...CONTRACT, changes: [{ id: "x", level: "FATAL", operation: "GET /" }] });

    expect(answer.status).toBe(400);
    expect((await packetNow(request.key)).revision).toBe(1);
  });
});

describe.each(PROTOCOL_VERSIONS)("attach_contract_changes, on protocol version %s", (version) => {
  it("attaches the classified diff as the contract section of the packet's next revision", async () => {
    const request = await openToFe();

    const result = await attachOverMcp(deniz, version, { key: request.key, expectedRevision: 1, contract: CONTRACT });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ request: { key: request.key }, packet: { revision: 2 } });
    expect((await packetNow(request.key)).packet.untrusted.contract).toEqual(CONTRACT);
  });

  it("returns a scope-change proposal for a claimed request", async () => {
    const request = await openToFe();
    expect((await harness.api("POST", `/api/v1/requests/${request.key}/claim`, { authorization: `Bearer ${mehmet.token}` })).status).toBe(200);

    const result = await attachOverMcp(deniz, version, { key: request.key, expectedRevision: 1, contract: CONTRACT });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ proposal: { kind: "scope" } });
    expect((await packetNow(request.key)).revision).toBe(1);
  });

  it("refuses a call that names no expected revision, or a stale one, as REST refuses it", async () => {
    const request = await openToFe();

    const missing = problemOf(await attachOverMcp(deniz, version, { key: request.key, contract: CONTRACT }));
    const stale = problemOf(await attachOverMcp(deniz, version, { key: request.key, expectedRevision: 4, contract: CONTRACT }));

    expect(missing).toMatchObject({ type: `${PROBLEM}if-match-required`, status: 428 });
    expect(stale).toMatchObject({ type: `${PROBLEM}precondition-failed`, status: 412 });
    expect(await proposalCount(request.id)).toBe(0);
    expect((await packetNow(request.key)).revision).toBe(1);
  });
});

describe("attach_contract_changes without contracts:report", () => {
  it("is refused with HTTP 403 insufficient_scope naming it, before the tool runs", async () => {
    const request = await openToFe();
    const answer = await harness.handle(
      new Request(`${URL_OF_INSTALL}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${denizWithoutContracts.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "attach_contract_changes", arguments: { key: request.key, expectedRevision: 1, contract: CONTRACT } } }),
      }),
    );

    expect(answer.status).toBe(403);
    expect(answer.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(answer.headers.get("www-authenticate")).toContain('scope="contracts:report"');
    expect((await packetNow(request.key)).revision).toBe(1);
  });
});

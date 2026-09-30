import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, mcpPerson, PROBLEM, problemOf, PROTOCOL_VERSIONS, textOf, type McpPerson, type ProtocolVersion } from "./support/mcp.ts";
import { openRequestInTheWebUi, packetOf } from "./support/requests.ts";

// The tools that change a request (agent-surfaces: Tools that change a
// request directly; agent-surfaces: Commitment tools return proposals;
// agent-surfaces: Tool schemas that current clients accept; requests: Linked
// PRs and done on merge; handoff-packet: Immutable, numbered revisions;
// design.md, Decisions this change rests on: D23, D28 #13, #16, #17; D29 (3);
// D30 (2); D46 (1)). For an agent acting for its own signed-in user, claim,
// post_message, link_pr and set_status to a state change that is not a
// commitment take effect at once; a call that would make a commitment creates
// a proposal instead, which the result carries with the confirmations it needs
// and when it expires; propose makes the commitments no other tool makes, and
// withdraws a pending proposal of the caller's user. The contract tests use
// the official MCP SDK client on both protocol versions and waited as expected
// failures until the tasks that build the tools turned them into plain tests:
// claim, offered on MCP since 16.3, post_message, set_status and link_pr in
// 16.8, and propose in 16.9. A packet change through propose names the
// revision it expects in expectedRevision, where REST takes it from If-Match.

let harness: AgentAccessHarness;
let dana: McpPerson;
let bob: McpPerson;
let lee: McpPerson;
let sam: McpPerson;

beforeAll(async () => {
  harness = await startAgentAccess();
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  bob = await mcpPerson(harness, "bob-fe", { teams: ["FE"] });
  lee = await mcpPerson(harness, "lee-fe", { teams: ["FE"] });
  sam = await mcpPerson(harness, "sam-be-qa", { teams: ["BE", "QA"] });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

interface RequestJson {
  id: string;
  key: string;
  state: string;
  claimant: { id: string } | null;
}

/** Calls one tool as the person's agent on this protocol version, with the tool list read first, as clients do. */
async function call(person: McpPerson, version: ProtocolVersion, name: string, args: Record<string, unknown>) {
  const client = await connectMcp(harness, { token: person.token, version });
  try {
    await client.listTools();
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

/** A request to FE that Sam opened from QA, in the web UI. */
function openToFe(title = "Add a dark mode"): Promise<RequestJson> {
  return openRequestInTheWebUi<RequestJson>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "QA", title });
}

/** Runs an operation as the person in the web UI, and fails the test on a refusal. */
async function inTheWebUi<T = unknown>(person: McpPerson, commandId: string, input: unknown): Promise<T> {
  const result = await harness.install.web(person.session).write<T>(commandId, input, harness.install.fromThePage(person.session));
  if (!result.ok) throw new Error(`${commandId} answered ${JSON.stringify(result.problem)}`);
  return result.output;
}

/** The request as it is now, read over /api/v1 with the person's agent's token. */
async function current(person: McpPerson, key: string): Promise<RequestJson & { messages: { id: string; kind: string }[] }> {
  const answer = await harness.api("GET", `/api/v1/requests/${key}`, { authorization: `Bearer ${person.token}` });
  return (await answer.json()) as RequestJson & { messages: { id: string; kind: string }[] };
}

/** How many proposals the request has. */
async function proposalCount(requestId: string): Promise<number> {
  return Number((await harness.install.owner.query("SELECT count(*) FROM proposals WHERE request_id = $1", [requestId])).rows[0].count);
}

describe.each(PROTOCOL_VERSIONS)("the tools that change a request directly, on protocol version %s", (version) => {
  it("claim: an agent claims an open request of its user's team for them, with no proposal", async () => {
    const request = await openToFe();
    const result = await call(dana, version, "claim", { key: request.key });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ key: request.key, state: "claimed", claimant: { id: dana.userId } });
    expect(await proposalCount(request.id)).toBe(0);
  });

  it("post_message: a blocking question moves an in-progress request to needs_info, and an answer that names it returns it", async () => {
    const request = await openToFe();
    await inTheWebUi(dana, "requests.claim", { key: request.key });
    await inTheWebUi(dana, "requests.set_status", { key: request.key, state: "in_progress" });
    const asked = await call(dana, version, "post_message", { key: request.key, kind: "question", body: "Which browsers?", blocking: true });
    expect(asked.isError).not.toBe(true);
    expect(asked.structuredContent).toMatchObject({ message: { kind: "question", blocking: true }, request: { state: "needs_info" } });
    const questionId = (asked.structuredContent as { message: { id: string } }).message.id;
    const answered = await call(sam, version, "post_message", { key: request.key, kind: "answer", body: "The last two versions of each.", questionId });
    expect(answered.structuredContent).toMatchObject({ message: { kind: "answer", questionId }, request: { state: "in_progress" } });
  });

  it("post_message: an answer without the question it answers is refused as input that fails the schema, and nothing is added", async () => {
    const request = await openToFe();
    const result = await call(sam, version, "post_message", { key: request.key, kind: "answer", body: "Chrome only." });
    expect(problemOf(result).type).toBe(`${PROBLEM}invalid-input`);
    expect((await current(dana, request.key)).messages).toEqual([]);
  });

  it("post_message: an input that mixes two kinds is refused on MCP with a validation error and on /api/v1 with 400, and nothing changes", async () => {
    const request = await openToFe();
    const mixed = { kind: "comment", body: "Noted.", questionId: "00000000-0000-4000-8000-000000000000" };
    const result = await call(sam, version, "post_message", { key: request.key, ...mixed });
    expect(problemOf(result).type).toBe(`${PROBLEM}invalid-input`);
    const rest = await harness.api("POST", `/api/v1/requests/${request.key}/messages`, { authorization: `Bearer ${sam.token}` }, mixed);
    expect(rest.status).toBe(400);
    expect((await current(dana, request.key)).messages).toEqual([]);
  });

  it("set_status to open: the claimant releases the claim, with no proposal", async () => {
    const request = await openToFe();
    await inTheWebUi(dana, "requests.claim", { key: request.key });
    const result = await call(dana, version, "set_status", { key: request.key, state: "open" });
    expect(result.structuredContent).toMatchObject({ key: request.key, state: "open", claimant: null });
    expect(await proposalCount(request.id)).toBe(0);
  });

  it("set_status to open: a member of the target team releases the claim of someone who was removed, with no proposal", async () => {
    const request = await openToFe();
    await inTheWebUi(lee, "requests.claim", { key: request.key });
    await harness.install.owner.query("DELETE FROM members WHERE user_id = $1", [lee.userId]);
    try {
      const result = await call(dana, version, "set_status", { key: request.key, state: "open" });
      expect(result.structuredContent).toMatchObject({ key: request.key, state: "open", claimant: null });
      expect(await proposalCount(request.id)).toBe(0);
    } finally {
      // Lee rejoins, and joins FE again, which the removal took them out of.
      await harness.install.owner.query("INSERT INTO members (org_id, user_id, role) SELECT id, $1, 'member' FROM orgs", [lee.userId]);
      await harness.install.owner.query("INSERT INTO team_members (org_id, team_id, user_id) SELECT org_id, id, $1 FROM teams WHERE key = 'FE' ON CONFLICT DO NOTHING", [lee.userId]);
    }
  });

  it("set_status to open while the request waits on a blocking question: it stays needs_info with no claimant until the answer", async () => {
    const request = await openToFe();
    await inTheWebUi(dana, "requests.claim", { key: request.key });
    await inTheWebUi(dana, "requests.set_status", { key: request.key, state: "in_progress" });
    const asked = await call(dana, version, "post_message", { key: request.key, kind: "question", body: "Which browsers?", blocking: true });
    const questionId = (asked.structuredContent as { message: { id: string } }).message.id;
    const released = await call(dana, version, "set_status", { key: request.key, state: "open" });
    expect(released.structuredContent).toMatchObject({ state: "needs_info", claimant: null });
    await call(sam, version, "post_message", { key: request.key, kind: "answer", body: "Chrome and Firefox.", questionId });
    expect(await current(dana, request.key)).toMatchObject({ state: "open", claimant: null });
  });

  it("set_status to declined: the result carries a new decline proposal, which needs Bob's confirmation and says when it expires, and the state stays", async () => {
    const request = await openToFe();
    const result = await call(bob, version, "set_status", { key: request.key, state: "declined" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      proposal: {
        id: expect.any(String),
        kind: "decline",
        state: "pending",
        confirmations: { needed: [{ step: "accountable_human", user: { id: bob.userId } }], received: [] },
        expiresAt: expect.any(String),
      },
    });
    expect(JSON.stringify(result)).not.toContain("/confirm/");
    expect((await current(bob, request.key)).state).toBe("open");
  });

  it("set_status to done with no qualifying merged pull request: the result carries a new done proposal, and the state stays", async () => {
    const request = await openToFe();
    await inTheWebUi(dana, "requests.claim", { key: request.key });
    const result = await call(dana, version, "set_status", { key: request.key, state: "done" });
    expect(result.structuredContent).toMatchObject({ proposal: { kind: "done", state: "pending" } });
    expect((await current(dana, request.key)).state).toBe("claimed");
  });

  it("link_pr: an agent links a pull request, which creates no proposal", async () => {
    const request = await openToFe();
    await inTheWebUi(dana, "requests.claim", { key: request.key });
    const result = await call(dana, version, "link_pr", { key: request.key, url: "https://github.com/acme/web/pull/88" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      request: { key: request.key, state: "claimed" },
      pullRequest: { repository: "acme/web", number: 88, url: "https://github.com/acme/web/pull/88", linkedBy: { id: dana.userId } },
    });
    expect(textOf(result)).toContain(`Pull request acme/web#88 (https://github.com/acme/web/pull/88) is linked to ${request.key}, by dana-fe`);
    expect(await proposalCount(request.id)).toBe(0);
  });

  // requests: Provenance is stamped by the server: "a payload cannot fake provenance".
  it("post_message: provenance the payload claims is ignored, and the message is the agent's, on mcp, for its user and team", async () => {
    const request = await openToFe();
    const forged = { surface: "web", actorKind: "human", client: "https://forged.example/client.json", userId: sam.userId };
    const result = await call(dana, version, "post_message", { key: request.key, kind: "comment", body: "Posted by an agent.", ...forged });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      message: { kind: "comment", provenance: { actorKind: "agent", surface: "mcp", user: { id: dana.userId }, team: { key: "FE" } } },
    });
    const text = textOf(result);
    expect(text).toContain(`Posted on ${request.key}.`);
    expect(text).toContain("posted by dana-fe for team FE through mcp");
  });
});

describe.each(PROTOCOL_VERSIONS)("propose, on protocol version %s", (version) => {
  /** The current revision of a request's packet, read over /api/v1. */
  async function revisionOf(key: string): Promise<number> {
    const response = await harness.api("GET", `/api/v1/requests/${key}/packet`, { authorization: `Bearer ${sam.token}` });
    return ((await response.json()) as { revision: number }).revision;
  }

  it("withdraws a pending proposal of the caller's user by its id: it can no longer be confirmed, and the due date is unchanged", async () => {
    const request = await openToFe();
    const proposed = await call(sam, version, "propose", { kind: "due_date", key: request.key, dueDate: "2026-10-15", expectedRevision: await revisionOf(request.key) });
    const proposalId = (proposed.structuredContent as { proposal: { id: string } }).proposal.id;
    const withdrawn = await call(sam, version, "propose", { kind: "withdraw_proposal", proposal: proposalId });
    expect(withdrawn.isError).not.toBe(true);
    const { rows } = await harness.install.owner.query("SELECT state FROM proposals WHERE id = $1", [proposalId]);
    expect(rows[0]?.state).toBe("withdrawn");
    const packet = (await (await harness.api("GET", `/api/v1/requests/${request.key}/packet`, { authorization: `Bearer ${sam.token}` })).json()) as { packet: { due_date?: string } };
    expect(packet.packet.due_date).toBeUndefined();
  });

  it("adds a scope change before a claim as the next packet revision at once, with no proposal", async () => {
    const request = await openToFe();
    const before = await revisionOf(request.key);
    const packet = { ...packetOf(), untrusted: { need: "Add a dark mode to the settings page.", acceptance_criteria: ["The toggle remembers the choice."] } };
    const result = await call(sam, version, "propose", { kind: "scope", key: request.key, expectedRevision: before, packet });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).not.toContain('"proposal"');
    expect(await revisionOf(request.key)).toBe(before + 1);
    expect(await proposalCount(request.id)).toBe(0);
  });

  it("proposes a due date that needs the requester's confirmation and then a member of the target team's, and changes nothing yet", async () => {
    const request = await openToFe();
    const result = await call(sam, version, "propose", { kind: "due_date", key: request.key, dueDate: "2026-10-15", expectedRevision: await revisionOf(request.key) });
    expect(result.structuredContent).toMatchObject({
      proposal: {
        kind: "due_date",
        confirmations: {
          needed: [
            { step: "accountable_human", user: { id: sam.userId } },
            { step: "other_side", team: { key: "FE" }, rules: ["target_team"] },
          ],
        },
        expiresAt: expect.any(String),
      },
    });
    const packet = (await (await harness.api("GET", `/api/v1/requests/${request.key}/packet`, { authorization: `Bearer ${sam.token}` })).json()) as { packet: { due_date?: string } };
    expect(packet.packet.due_date).toBeUndefined();
  });

  it("proposes a scope change after a claim that needs the requester's confirmation and then the claimant's", async () => {
    const request = await openToFe();
    await inTheWebUi(dana, "requests.claim", { key: request.key });
    const packet = { ...packetOf(), untrusted: { need: "Add a dark mode to the settings page.", acceptance_criteria: ["It follows the system setting."] } };
    const result = await call(sam, version, "propose", { kind: "scope", key: request.key, expectedRevision: await revisionOf(request.key), packet });
    expect(result.structuredContent).toMatchObject({
      proposal: {
        kind: "scope",
        confirmations: { needed: [{ step: "accountable_human", user: { id: sam.userId } }, { step: "other_side", rules: ["claimant"] }] },
      },
    });
  });

  it("refuses a packet change that names a stale expected revision, or none, as REST refuses a mismatched or missing If-Match, and creates no proposal", async () => {
    const request = await openToFe();
    await inTheWebUi(dana, "requests.claim", { key: request.key });
    const stale = await call(sam, version, "propose", { kind: "due_date", key: request.key, dueDate: "2026-10-15", expectedRevision: (await revisionOf(request.key)) + 5 });
    expect(problemOf(stale)).toMatchObject({ type: `${PROBLEM}precondition-failed`, status: 412 });
    const none = await call(sam, version, "propose", { kind: "due_date", key: request.key, dueDate: "2026-10-15" });
    expect(problemOf(none)).toMatchObject({ type: `${PROBLEM}if-match-required`, status: 428 });
    expect(await proposalCount(request.id)).toBe(0);
  });

  it("proposes a reassignment, as a member of the target team, and a withdrawal, as the requester side", async () => {
    const request = await openToFe();
    const reassign = await call(dana, version, "propose", { kind: "reassign", key: request.key, team: "BE" });
    expect(reassign.structuredContent).toMatchObject({ proposal: { kind: "reassign", change: { team: { key: "BE" } } } });
    const withdraw = await call(sam, version, "propose", { kind: "withdraw", key: request.key });
    expect(withdraw.structuredContent).toMatchObject({ proposal: { kind: "withdraw" } });
    expect(textOf(withdraw)).not.toContain(`${URL_OF_INSTALL}/confirm/`);
  });

  it("proposes removing a due date the request has, as a due-date proposal with no date", async () => {
    const request = await openRequestInTheWebUi<RequestJson>(harness.install, sam.userId, {
      targetTeam: "FE",
      requestingTeam: "QA",
      packet: { ...packetOf(), due_date: "2026-11-01" },
    });
    const result = await call(sam, version, "propose", { kind: "due_date", key: request.key, dueDate: null, expectedRevision: await revisionOf(request.key) });
    expect(result.structuredContent).toMatchObject({ proposal: { kind: "due_date", change: { dueDate: null }, untrusted: { packet: expect.not.objectContaining({ due_date: expect.anything() }) } } });
  });

  it("refuses the side that may not make the commitment with 403, and creates no proposal", async () => {
    const request = await openToFe();
    expect(problemOf(await call(sam, version, "propose", { kind: "reassign", key: request.key, team: "BE" }))).toMatchObject({ type: `${PROBLEM}forbidden`, status: 403 });
    expect(problemOf(await call(dana, version, "propose", { kind: "withdraw", key: request.key }))).toMatchObject({ type: `${PROBLEM}forbidden`, status: 403 });
    expect(await proposalCount(request.id)).toBe(0);
  });

  it("refuses to withdraw a proposal another user proposed with 403, and leaves it pending", async () => {
    const request = await openToFe();
    const proposed = await call(sam, version, "propose", { kind: "withdraw", key: request.key });
    const proposalId = (proposed.structuredContent as { proposal: { id: string } }).proposal.id;
    expect(problemOf(await call(dana, version, "propose", { kind: "withdraw_proposal", proposal: proposalId }))).toMatchObject({ status: 403 });
    const { rows } = await harness.install.owner.query("SELECT state FROM proposals WHERE id = $1", [proposalId]);
    expect(rows[0]?.state).toBe("pending");
  });

  it("refuses an input that mixes two kinds as input that fails the schema, and creates nothing", async () => {
    const request = await openToFe();
    const mixed = await call(dana, version, "propose", { kind: "reassign", key: request.key, team: "BE", dueDate: "2026-10-15" });
    expect(problemOf(mixed)).toMatchObject({ type: `${PROBLEM}invalid-input`, status: 400 });
    expect(await proposalCount(request.id)).toBe(0);
  });
});

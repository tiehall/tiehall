import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { connectMcp, LEGACY, MODERN, mcpPerson, type McpPerson, type ProtocolVersion } from "./support/mcp.ts";
import { openRequestInTheWebUi } from "./support/requests.ts";

// Clients without the Claude Code hooks pull (requester-loop: Pull is the
// contract; requester-loop: Codex and other clients pull; design.md,
// Decisions this change rests on: D8; design.md, Design rules: Requester
// loop). Codex, Cursor, Copilot and every other client without the hooks get
// every update by pull: an agent that calls whats_new over MCP, as the skill
// teaches it to at the start of a session, gets the question seeded on its
// user's request, whatever client it runs in and whichever protocol version
// it speaks. Until a Codex SessionStart snippet has passed its test in a real
// Codex session, whats_new is how a Codex agent learns of news (task 19.21).

let harness: AgentAccessHarness;
let sam: McpPerson;
let dana: McpPerson;

beforeAll(async () => {
  harness = await startAgentAccess();
  sam = await mcpPerson(harness, "sam-be", { teams: ["BE"] });
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** Sam's agent in this client, with a token of its own, whose whats_new it reads to the end; the questions on this request it got. */
async function pulled(clientName: string, version: ProtocolVersion, key: string): Promise<number> {
  const { accessToken } = await harness.tokens(sam);
  const client = await connectMcp(harness, { token: accessToken, version, name: clientName });
  try {
    let questions = 0;
    let args: Record<string, unknown> = { limit: 50 };
    for (;;) {
      const read = await client.callTool({ name: "whats_new", arguments: args });
      expect(read.isError, clientName).not.toBe(true);
      const { events } = read.structuredContent as { events: { number: number; type: string; request: { key: string } }[] };
      if (events.length === 0) return questions;
      questions += events.filter(({ type, request }) => type === "request.message_posted" && request.key === key).length;
      args = { limit: 50, acknowledge: Math.max(...events.map(({ number }) => number)) };
    }
  } finally {
    await client.close();
  }
}

describe("a client without the Claude Code hooks", () => {
  it.each([
    // requester-loop: Codex and other clients pull, "A Codex agent pulls".
    ["codex-mcp-client", MODERN],
    ["codex-mcp-client", LEGACY],
    // requester-loop: Pull is the contract, "A client without hooks".
    ["cursor-vscode", MODERN],
    ["Visual Studio Code", LEGACY],
  ] as const)("%s on %s gets a question seeded on its user's request through whats_new", async (clientName, version) => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    const posted = await harness.install.web(dana.session).write("messages.post", { key: request.key, kind: "question", body: "Which browsers?" }, harness.install.fromThePage(dana.session));
    expect(posted.ok).toBe(true);
    expect(await pulled(clientName, version, request.key)).toBe(1);
  });
});

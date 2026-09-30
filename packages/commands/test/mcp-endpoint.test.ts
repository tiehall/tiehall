import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { connectMcp, LEGACY, MODERN, mcpPerson, PROTOCOL_VERSIONS, type McpExchange, type McpPerson } from "./support/mcp.ts";

// The MCP endpoint (agent-surfaces: Four agent surfaces; agent-surfaces: One
// MCP endpoint for both protocol versions; design.md, Technical decisions:
// T9). Each install serves its MCP server at /mcp on its own host, and that one
// endpoint serves clients on protocol version 2026-07-28 and clients on
// 2025-11-25 without holding a protocol session between calls. The server
// offers tools only: no resources and no prompts. The contract tests use the
// official MCP SDK client on both protocol versions, with an access token from
// the install's real authorization code flow. They wait as expected failures
// until the tasks that build /mcp and its tools turn them into plain tests:
// the endpoint in 16.2, and a tool to call in 16.5.

let harness: AgentAccessHarness;
let dana: McpPerson;

beforeAll(async () => {
  harness = await startAgentAccess();
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe.each(PROTOCOL_VERSIONS)("a client on protocol version %s", (version) => {
  it.fails("reads the server's capabilities: tools, and neither resources nor prompts", async () => {
    const client = await connectMcp(harness, { token: dana.token, version });
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.tools).toBeDefined();
      expect(capabilities?.resources).toBeUndefined();
      expect(capabilities?.prompts).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it.fails("uses the protocol version it speaks", async () => {
    const client = await connectMcp(harness, { token: dana.token, version });
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe(version);
    } finally {
      await client.close();
    }
  });

  it.fails("lists the tools, with calls that carry no session and get none back", async () => {
    const log: McpExchange[] = [];
    const client = await connectMcp(harness, { token: dana.token, version, log });
    try {
      const { tools } = await client.listTools();
      expect(Array.isArray(tools)).toBe(true);
      const answered = log.filter(({ method }) => method === "POST");
      expect(answered.map(({ rpcMethod }) => rpcMethod)).toContain("tools/list");
      for (const exchange of answered) {
        expect(exchange.status, `${exchange.rpcMethod}`).toBeLessThan(300);
        expect(exchange.sessionIdSent).toBeNull();
        expect(exchange.sessionIdReceived).toBeNull();
      }
    } finally {
      await client.close();
    }
  });

  // Calling a tool needs one, which 16.5 builds: whoami.
  it.fails("calls a tool without a session: each call is answered on its own", async () => {
    const log: McpExchange[] = [];
    const client = await connectMcp(harness, { token: dana.token, version, log });
    try {
      const first = await client.callTool({ name: "whoami", arguments: {} });
      const second = await client.callTool({ name: "whoami", arguments: {} });
      expect(first.isError).not.toBe(true);
      expect(second.structuredContent).toEqual(first.structuredContent);
      const calls = log.filter(({ rpcMethod }) => rpcMethod === "tools/call");
      expect(calls).toHaveLength(2);
      for (const exchange of calls) {
        expect(exchange.status).toBe(200);
        expect(exchange.sessionIdSent).toBeNull();
        expect(exchange.sessionIdReceived).toBeNull();
      }
    } finally {
      await client.close();
    }
  });
});

describe("the one endpoint", () => {
  it.fails("serves a 2026-07-28 client and a 2025-11-25 client at the same URL, one after the other", async () => {
    const modern = await connectMcp(harness, { token: dana.token, version: MODERN });
    const legacy = await connectMcp(harness, { token: dana.token, version: LEGACY });
    try {
      expect(modern.getNegotiatedProtocolVersion()).toBe(MODERN);
      expect(legacy.getNegotiatedProtocolVersion()).toBe(LEGACY);
      expect((await modern.listTools()).tools.map(({ name }) => name)).toEqual((await legacy.listTools()).tools.map(({ name }) => name));
    } finally {
      await modern.close();
      await legacy.close();
    }
  });
});

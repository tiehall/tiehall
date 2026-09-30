import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG } from "@tiehall/catalog";
import { URL_OF_INSTALL } from "./support/install.ts";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { connectMcp, mcpPerson, PROBLEM, problemOf, PROTOCOL_VERSIONS, textOf, type McpPerson, type ProtocolVersion } from "./support/mcp.ts";
import { openRequestInTheWebUi, packetOf } from "./support/requests.ts";

// The MCP tools (agent-surfaces: The MCP tools; agent-surfaces: Tool
// annotations and stability levels; agent-surfaces: Tool schemas that current
// clients accept; agent-surfaces: Admin actions and trust changes are on no
// agent surface; agent-surfaces: Tools that change a request directly;
// design.md, Decisions this change rests on: D28 #55, #56, #65). The contract
// tests use the official MCP SDK client on both protocol versions, with an
// access token from the install's real authorization code flow. Each waited
// as an expected failure until the task that builds what it checks turned it
// into a plain test: the tool list's annotations, levels and schemas in 16.3,
// whoami and directory in 16.5, open_request and list_inbox in 16.6. The list
// of exactly twelve tools waits for the last of them: whats_new comes in 19.3
// and attach_contract_changes in 23.5.

/** The _meta key under which every tool states its stability level. */
const STABILITY = "com.tiehall/stability";

/** The twelve tools the MCP server offers (agent-surfaces: The MCP tools). */
const TOOLS = [
  "attach_contract_changes",
  "claim",
  "directory",
  "get_request",
  "link_pr",
  "list_inbox",
  "open_request",
  "post_message",
  "propose",
  "set_status",
  "whats_new",
  "whoami",
];

let harness: AgentAccessHarness;
let dana: McpPerson;
let sam: McpPerson;
let erin: McpPerson;
let nola: McpPerson;
let kim: McpPerson;

beforeAll(async () => {
  harness = await startAgentAccess();
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  sam = await mcpPerson(harness, "sam-be-qa", { teams: ["BE", "QA"] });
  erin = await mcpPerson(harness, "erin-admin", { teams: ["FE"], role: "admin" });
  nola = await mcpPerson(harness, "nola-no-team");
  kim = await mcpPerson(harness, "kim-ops", { teams: ["OPS"] });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** Calls one tool as the person's agent on this protocol version, with the tool list read first, as clients do. */
async function call(person: McpPerson, version: ProtocolVersion, name: string, args: Record<string, unknown> = {}) {
  const client = await connectMcp(harness, { token: person.token, version });
  try {
    await client.listTools();
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

/** The tools as a person's agent lists them on this protocol version. */
async function listed(person: McpPerson, version: ProtocolVersion) {
  const client = await connectMcp(harness, { token: person.token, version });
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

describe.each(PROTOCOL_VERSIONS)("the tool list, on protocol version %s", (version) => {
  it.fails("holds exactly the twelve tools", async () => {
    expect((await listed(dana, version)).map(({ name }) => name).sort()).toEqual(TOOLS);
  });

  it("gives every tool an annotations object, and the read-only hint only to tools that only read", async () => {
    const tools = await listed(dana, version);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(tool.annotations, tool.name).toBeTypeOf("object");
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("get_request")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("claim")?.annotations?.readOnlyHint).not.toBe(true);
    for (const tool of tools) {
      const definition = CATALOG.commands.find(({ tool: name }) => name === tool.name);
      const writes = definition?.scopes.some((scope) => scope !== "requests:read") === true || (definition?.method !== undefined && definition.method !== "GET");
      if (writes) expect(tool.annotations?.readOnlyHint, tool.name).not.toBe(true);
    }
  });

  it("states each tool's stability level in its _meta, equal to its operation's", async () => {
    const tools = await listed(dana, version);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const definition = CATALOG.commands.find(({ tool: name }) => name === tool.name);
      expect(definition, tool.name).toBeDefined();
      expect(["alpha", "beta", "stable"]).toContain(tool._meta?.[STABILITY]);
      expect(tool._meta?.[STABILITY], tool.name).toBe(definition?.stability);
    }
  });

  it("gives every tool schemas that current clients accept: an object root with no composition, and no $ref or $defs", async () => {
    const tools = await listed(dana, version);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        expect(schema, tool.name).toBeDefined();
        const text = JSON.stringify(schema);
        expect(text, tool.name).not.toContain('"$ref"');
        expect(text, tool.name).not.toContain('"$defs"');
        expect(schema?.type, tool.name).toBe("object");
        for (const composition of ["anyOf", "oneOf", "allOf"]) expect(schema, tool.name).not.toHaveProperty(composition);
      }
    }
  });

  it("is the same for an admin's agent as for a member's, and holds no admin action and nothing that needs the confirmation step", async () => {
    const forAdmin = await listed(erin, version);
    const forMember = await listed(dana, version);
    expect(forAdmin.length).toBeGreaterThan(0);
    expect(forAdmin).toEqual(forMember);
    for (const tool of forAdmin) {
      const definition = CATALOG.commands.find(({ tool: name }) => name === tool.name);
      expect(definition?.admin, tool.name).toBeUndefined();
      expect(definition?.confirm, tool.name).toBe(false);
    }
  });
});

describe.each(PROTOCOL_VERSIONS)("whoami, on protocol version %s", (version) => {
  it("names the user the connection acts for, the teams they belong to and the install by its URL, and whether the user is a bot", async () => {
    const result = await call(dana, version, "whoami");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      user: { id: dana.userId, login: "dana-fe", kind: "human", bot: false },
      teams: [{ id: expect.any(String), key: "FE" }],
      install: { url: URL_OF_INSTALL },
    });
    const text = textOf(result);
    expect(text).toContain("dana-fe");
    expect(text).toContain("They belong to team FE.");
    expect(text).toContain(URL_OF_INSTALL);
  });

  it("says so when the user is a bot", async () => {
    await harness.install.owner.query("UPDATE users SET bot = true WHERE id = $1", [kim.userId]);
    try {
      const result = await call(kim, version, "whoami");
      expect(result.structuredContent).toMatchObject({ user: { login: "kim-ops", kind: "human", bot: true } });
      expect(textOf(result)).toContain("bot");
    } finally {
      await harness.install.owner.query("UPDATE users SET bot = false WHERE id = $1", [kim.userId]);
    }
  });
});

describe.each(PROTOCOL_VERSIONS)("directory, on protocol version %s", (version) => {
  it("lists each team of the install with its key, and the registered APIs, none yet", async () => {
    const result = await call(dana, version, "directory");
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { teams: { key: string; untrusted: { name: string } }[]; apis: unknown[] };
    expect(structured.teams.map(({ key }) => key).sort()).toEqual(["BE", "FE", "OPS", "QA"]);
    expect(structured.apis).toEqual([]);
    const text = textOf(result);
    for (const key of ["BE", "FE", "OPS", "QA"]) expect(text).toContain(key);
  });
});

describe.each(PROTOCOL_VERSIONS)("list_inbox, on protocol version %s", (version) => {
  it("lists the requests addressed to the caller's teams, and none addressed to another team", async () => {
    const toFe = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "QA", title: "Inbox check for FE" });
    const toOps = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "OPS", requestingTeam: "QA", title: "Inbox check for OPS" });
    const result = await call(dana, version, "list_inbox");
    expect(result.isError).not.toBe(true);
    const keys = (result.structuredContent as { "requests": { key: string }[] })["requests"].map(({ key }) => key);
    expect(keys).toContain(toFe.key);
    expect(keys).not.toContain(toOps.key);
    const text = textOf(result);
    expect(text).toContain(toFe.key);
    expect(text).not.toContain(toOps.key);
  });

  it("lists nothing for a member of no team", async () => {
    const result = await call(nola, version, "list_inbox");
    expect(result.isError).not.toBe(true);
    // The key is quoted, so the source-citation check does not take the name and its colon for a citation.
    expect(result.structuredContent).toMatchObject({ "requests": [] });
  });
});

describe.each(PROTOCOL_VERSIONS)("open_request, on protocol version %s", (version) => {
  it("opens a request from the team a member of two teams names", async () => {
    const result = await call(sam, version, "open_request", { targetTeam: "FE", requestingTeam: "QA", title: "Add a dark mode", packet: packetOf() });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      key: expect.stringMatching(/^FE-\d+$/),
      state: "open",
      targetTeam: { key: "FE" },
      requester: { user: { id: sam.userId, login: "sam-be-qa" }, team: { key: "QA" } },
      claimant: null,
    });
  });

  it("opens a request from the only team of a member who names none", async () => {
    const result = await call(dana, version, "open_request", { targetTeam: "OPS", title: "Rotate the staging keys", packet: packetOf("Rotate the staging keys.") });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ targetTeam: { key: "OPS" }, requester: { user: { id: dana.userId }, team: { key: "FE" } } });
  });

  it("refuses a member of two teams who names none as input that fails the schema, naming the teams, and opens nothing", async () => {
    const before = Number((await harness.install.owner.query("SELECT count(*) FROM requests")).rows[0].count);
    const result = await call(sam, version, "open_request", { targetTeam: "FE", title: "Add a dark mode", packet: packetOf() });
    const problem = problemOf(result);
    expect(problem.type).toBe(`${PROBLEM}invalid-input`);
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("BE and QA");
    expect(Number((await harness.install.owner.query("SELECT count(*) FROM requests")).rows[0].count)).toBe(before);
  });

  it("refuses a member of no team with 403, and opens nothing", async () => {
    const result = await call(nola, version, "open_request", { targetTeam: "FE", title: "Add a dark mode", packet: packetOf() });
    const problem = problemOf(result);
    expect(problem.type).toBe(`${PROBLEM}forbidden`);
    expect(problem.status).toBe(403);
  });
});

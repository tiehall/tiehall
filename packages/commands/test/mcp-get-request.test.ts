import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, mcpPerson, MODERN, PROBLEM, problemOf, PROTOCOL_VERSIONS, resultSize, textOf, type McpPerson, type ProtocolVersion } from "./support/mcp.ts";
import { openRequestInTheWebUi, packetOf, sessionOf } from "./support/requests.ts";
import { addUser } from "./support/members.ts";

// Reading a request by key or URL, in pages (agent-surfaces: Reading a
// request by key or URL, in pages; design.md, Decisions this change rests on:
// D28 #69; design.md, Self-hosting decisions: S15). get_request takes a
// request's key, one written with a team's earlier key included, or its URL on
// the install's own origin, and refuses a URL on any other origin as input
// that fails the schema, sending nothing there. It returns the request in
// sections, the packet and the thread, and in pages, so that no result
// reaches 10,000 tokens: at 4 characters per token, a page holds at most
// 8,000 tokens, 32,000 characters, counting both its markdown and its
// structured content. A page says how to fetch the next one, and every result
// shows whether the request waits for a person (needs_human). The contract
// tests waited as expected failures until 16.7 turned them into plain tests;
// those that the key-only read of 16.3 and the markdown of 16.4 already
// passed became plain tests then.

/** The most characters a page may hold: 8,000 tokens at 4 characters each. */
const PAGE_CHARACTERS = 32_000;

interface Part {
  kind: "packet_field" | "message";
  field?: string;
  message?: { id: string };
  part: number;
  parts: number;
  untrusted: { text: string };
}

interface Page {
  request: { key: string; needsHuman: boolean };
  section: string;
  page: number;
  pages: number;
  next: { section: string; page: number } | null;
  parts: Part[];
}

let harness: AgentAccessHarness;
let dana: McpPerson;
let sam: McpPerson;
let small: { id: string; key: string };
let large: { key: string };
/** What the large request holds: its need, and the text of its two messages, by who posted them. */
const NEED = "N".repeat(19_990) + " done.";
const FIRST = "F".repeat(39_990) + " done.";
const SECOND = "S".repeat(39_990) + " done.";

beforeAll(async () => {
  harness = await startAgentAccess();
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  sam = await mcpPerson(harness, "sam-be-qa", { teams: ["BE", "QA"] });
  small = await openRequestInTheWebUi(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "QA", title: "Add a dark mode" });
  large = await openRequestInTheWebUi(harness.install, sam.userId, {
    targetTeam: "FE",
    requestingTeam: "QA",
    title: "Move the settings page to the new layout",
    packet: packetOf(NEED),
  });
  for (const [person, body] of [
    [dana, FIRST],
    [sam, SECOND],
  ] as const) {
    const posted = await harness.install.web(person.session).write("messages.post", { key: large.key, kind: "comment", body }, harness.install.fromThePage(person.session));
    if (!posted.ok) throw new Error(`messages.post answered ${JSON.stringify(posted.problem)}`);
  }
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Calls get_request as the person's agent on this protocol version, with the tool list read first, as clients do. */
async function getRequest(person: McpPerson, version: ProtocolVersion, args: Record<string, unknown>) {
  const client = await connectMcp(harness, { token: person.token, version });
  try {
    await client.listTools();
    return await client.callTool({ name: "get_request", arguments: args });
  } finally {
    await client.close();
  }
}

describe.each(PROTOCOL_VERSIONS)("get_request, on protocol version %s", (version) => {
  it("returns the same request for its key and for its URL on the install's origin", async () => {
    const byKey = await getRequest(dana, version, { request: small.key });
    const byUrl = await getRequest(dana, version, { request: `${URL_OF_INSTALL}/${small.key}` });
    expect(byKey.isError).not.toBe(true);
    expect(byKey.structuredContent).toMatchObject({ request: { key: small.key, untrusted: { title: "Add a dark mode" } }, page: 1, pages: 1, next: null });
    expect(byUrl.structuredContent).toEqual(byKey.structuredContent);
  });

  it("refuses a URL on another origin as input that fails the schema, and sends nothing to that origin", async () => {
    const outbound = vi.spyOn(globalThis, "fetch");
    const result = await getRequest(dana, version, { request: `https://other.example.net/${small.key}` });
    const problem = problemOf(result);
    expect(problem.type).toBe(`${PROBLEM}invalid-input`);
    expect(problem.status).toBe(400);
    expect(outbound.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))).not.toContainEqual(expect.stringContaining("other.example.net"));
  });

  it("refuses what is neither a key nor a URL as input that fails the schema", async () => {
    for (const request of ["not a key", "fe-1", `${URL_OF_INSTALL}/api/v1/requests/${small.key}`]) {
      const problem = problemOf(await getRequest(dana, version, { request }));
      expect(problem.type, request).toBe(`${PROBLEM}invalid-input`);
    }
  });

  it("answers a key written with a team's earlier key with the request under its current key", async () => {
    // A team of its own for each protocol version, whose key changes from AL… to AK….
    const suffix = version === MODERN ? "M" : "L";
    const admin = sessionOf(await addUser(harness.install.owner, { role: "admin" }));
    const { rows } = await harness.install.owner.query<{ id: string }>("INSERT INTO teams (org_id, key, name) SELECT id, $1, 'Aliases' FROM orgs RETURNING id", [`AL${suffix}`]);
    const opened = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: `AL${suffix}`, requestingTeam: "QA" });
    const renamed = await harness.install.web(admin).write("teams.change_key", { teamId: rows[0]?.id, key: `AK${suffix}` }, harness.install.fromThePage(admin));
    expect(renamed.ok).toBe(true);
    const result = await getRequest(dana, version, { request: opened.key });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as Page).request.key).toBe(opened.key.replace(/^AL/, "AK"));
  });

  it("pages a 100,000-character request: the first page holds at most 32,000 characters and says how to fetch the next", async () => {
    const first = await getRequest(dana, version, { request: large.key });
    expect(first.isError).not.toBe(true);
    expect(resultSize(first)).toBeLessThanOrEqual(PAGE_CHARACTERS);
    const page = first.structuredContent as Page;
    expect(page.page).toBe(1);
    expect(page.pages).toBeGreaterThan(1);
    expect(page.next).toEqual({ section: "all", page: 2 });
    expect(textOf(first)).toContain("page 2");
  });

  it("gives the whole request over its pages, each within 32,000 characters", async () => {
    const texts = new Map<string, string>();
    let args: Record<string, unknown> = { request: large.key };
    for (let count = 0; count < 20; count += 1) {
      const result = await getRequest(dana, version, args);
      expect(result.isError).not.toBe(true);
      expect(resultSize(result)).toBeLessThanOrEqual(PAGE_CHARACTERS);
      const page = result.structuredContent as Page;
      for (const part of page.parts) {
        const id = part.kind === "message" ? `message ${part.message?.id}` : `packet ${part.field}`;
        texts.set(id, (texts.get(id) ?? "") + part.untrusted.text);
      }
      if (page.next === null) break;
      args = { request: large.key, section: page.next.section, page: page.next.page };
    }
    const values = [...texts.values()];
    expect(values).toContain(NEED);
    expect(values).toContain(FIRST);
    expect(values).toContain(SECOND);
  });

  it("reads one section, the thread or the packet, in pages of its own", async () => {
    const thread = (await getRequest(dana, version, { request: large.key, section: "thread" })).structuredContent as Page;
    expect(thread.section).toBe("thread");
    expect(thread.parts.length).toBeGreaterThan(0);
    expect(thread.parts.every(({ kind }) => kind === "message")).toBe(true);
    const packet = (await getRequest(dana, version, { request: large.key, section: "packet" })).structuredContent as Page;
    expect(packet.section).toBe("packet");
    expect(packet.parts.every(({ kind }) => kind === "packet_field")).toBe(true);
    expect(packet.parts.map(({ field }) => field)).toContain("need");
  });

  it("refuses a page the request does not have as input that fails the schema", async () => {
    const problem = problemOf(await getRequest(dana, version, { request: small.key, page: 99 }));
    expect(problem.type).toBe(`${PROBLEM}invalid-input`);
  });

  it("shows whether the request waits for a person", async () => {
    expect(((await getRequest(dana, version, { request: small.key })).structuredContent as Page).request.needsHuman).toBe(false);
    await harness.install.owner.query("UPDATE requests SET needs_human = true WHERE id = $1", [small.id]);
    try {
      const flagged = await getRequest(dana, version, { request: small.key });
      expect((flagged.structuredContent as Page).request.needsHuman).toBe(true);
      expect(textOf(flagged)).toContain("needs_human");
    } finally {
      await harness.install.owner.query("UPDATE requests SET needs_human = false WHERE id = $1", [small.id]);
    }
  });
});

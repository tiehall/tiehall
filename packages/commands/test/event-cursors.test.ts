import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller, WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, openRequestInTheWebUi, sessionOf, tokenOf } from "./support/requests.ts";

// Read cursors move only on acknowledgement (requests: Read cursors move only
// on acknowledgement; requester-loop: The pull readers; design.md, Design
// rules: Requests and events). Each user has a read cursor per client: an
// agent reads the updates after its cursor, and the cursor moves only when the
// reader acknowledges them, so reading without acknowledging returns the same
// updates again. The CLI and an MCP client are two clients, each with its own
// cursor, whichever endpoint the MCP client's token calls; so is each personal
// access token and the web UI.
//
// The raw reads of the event log, events.read and events.acknowledge, which
// return every domain event of the install outside the scope of whats_new and
// share each client's cursor with it, are internal commands that no agent
// surface offers (decisions-from-groups-15-28: design.md, Decisions this change
// rests on: D55 (50)): /api/v1/events answers 404 to a valid token. The
// readers' API is whats_new, whose REST operation, POST /api/v1/updates, the
// CLI's `tiehall updates` calls too, and the wait; so the agents' cursors are
// read and moved here through it, and the web UI's through the internal
// commands, which only a web session runs.
//
// A reader that has no cursor yet, such as a new MCP client or the CLI's
// first login, starts at the user's web inbox cursor, not at the first event,
// and keeps that place once it has read (decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (44); design.md, Technical
// decisions: T6).
//
// Alice of team BE opens two requests to team FE, and Bob of team FE asks
// three questions on the first: Bob's questions are updates of Alice's, as
// the requester.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;
let firstKey: string;

/** An MCP client's id, as its Client ID Metadata Document names it. */
const MCP_CLIENT = "https://agent.example/client-metadata.json";
/** The CLI's registered OAuth client. */
const CLI_CLIENT = "tiehall-cli";

let cli: Caller;
let mcp: Caller;
let web: WebSessionCaller;

interface ReadEvent {
  number: number;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

const question = (body: string) => callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${firstKey}/messages`, { kind: "question", body });

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE"]) team[name] = await addTeam(install.owner, name);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, bob, team["FE"] ?? "");
  cli = oauthTokenOf(alice, CLI_CLIENT, "cli");
  mcp = oauthTokenOf(alice, MCP_CLIENT, "api");
  web = sessionOf(alice);
  // Some updates to read: two requests opened, and three questions on the first.
  const first = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  firstKey = first.key;
  await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  for (const body of ["Which browsers?", "Which themes?", "By when?"]) await question(body);
});

afterAll(async () => {
  await install.close();
});

/** A read of the caller's updates through whats_new's REST operation, acknowledging up to a number first when one is given. */
async function read(caller: Caller, { limit = 50, acknowledge }: { limit?: number; acknowledge?: number } = {}): Promise<{ events: ReadEvent[]; cursor: number }> {
  const answer = await callApi(install, caller, "POST", "/api/v1/updates", { limit, ...(acknowledge === undefined ? {} : { acknowledge }) });
  if (answer.status !== 200) throw new Error(`updates.read answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

const acknowledge = (caller: Caller, upTo: number) => callApi(install, caller, "POST", "/api/v1/updates", { acknowledge: upTo, limit: 1 });
const numbers = (events: ReadEvent[]) => events.map(({ number }) => number);
const questions = (events: ReadEvent[]) => events.filter(({ type, data }) => type === "request.message_posted" && data["kind"] === "question");

describe("the raw reads of the event log", () => {
  it("are offered on no agent surface: a valid token's call to /api/v1/events answers 404, and moves nothing", async () => {
    const before = (await read(cli)).cursor;
    for (const [method, path, body] of [
      ["GET", "/api/v1/events", undefined],
      ["POST", "/api/v1/events/acknowledge", { upTo: 1 }],
    ] as const) {
      for (const caller of [cli, mcp, tokenOf(alice)]) {
        const answer = await callApi(install, caller, method, path, body);
        expect(answer.status, `${method} ${path}`).toBe(404);
        expect(answer.body, `${method} ${path}`).toMatchObject({ type: "https://tiehall.com/problems/route-not-found" });
      }
    }
    expect((await read(cli)).cursor).toBe(before);
  });

  it("are internal commands the web UI's session runs, on the web UI's own cursor", async () => {
    // Bob's web UI, so that Alice's, where Alice's new readers will start, stays at 0. Bob's MCP client reads once
    // first, so that it has a cursor of its own before Bob's web UI moves on.
    const bobsWeb = sessionOf(bob);
    expect((await read(oauthTokenOf(bob, MCP_CLIENT, "api"))).cursor).toBe(0);
    const all = await install.web(bobsWeb).read<{ events: ReadEvent[]; cursor: number }>("events.read", {});
    expect(all).toMatchObject({ ok: true, output: { cursor: 0 } });
    const events = all.ok ? all.output.events : [];
    expect(questions(events)).toHaveLength(3);
    const upTo = events[0]?.number ?? 0;
    expect(await install.web(bobsWeb).write("events.acknowledge", { upTo }, install.fromThePage(bobsWeb))).toMatchObject({ ok: true, output: { cursor: upTo } });
    expect(await install.web(bobsWeb).read("events.read", {})).toMatchObject({ ok: true, output: { cursor: upTo } });
    // Bob's agents' cursors stay where they were.
    expect((await read(oauthTokenOf(bob, MCP_CLIENT, "api"))).cursor).toBe(0);
  });
});

describe("reading updates", () => {
  it("returns the updates after the reader's cursor, oldest first, with their type and the ids they carry", async () => {
    const { events, cursor } = await read(cli);
    expect(cursor).toBe(0);
    expect(numbers(events)).toEqual([...numbers(events)].sort((a, b) => a - b));
    expect(questions(events)).toHaveLength(3);
    expect(questions(events)[0]).toMatchObject({
      number: expect.any(Number),
      type: "request.message_posted",
      occurredAt: expect.any(String),
      data: { requestId: expect.any(String), messageId: expect.any(String), kind: "question", blocking: false },
    });
  });

  it("returns the same updates again when the reader has not acknowledged them", async () => {
    const first = await read(cli);
    const second = await read(cli);
    expect(second).toEqual(first);
  });

  it("returns at most the number of updates asked for", async () => {
    const all = await read(cli);
    expect(numbers((await read(cli, { limit: 2 })).events)).toEqual(numbers(all.events).slice(0, 2));
    expect((await callApi(install, cli, "POST", "/api/v1/updates", { limit: 0 })).status).toBe(400);
    expect((await callApi(install, cli, "POST", "/api/v1/updates", { limit: 51 })).status).toBe(400);
  });
});

describe("acknowledging", () => {
  it("up to update N makes the reader's next read start after N", async () => {
    const all = (await read(cli)).events;
    const upTo = all.at(-2)?.number ?? 0;
    expect(await acknowledge(cli, upTo)).toMatchObject({ status: 200, body: { cursor: upTo } });
    const next = await read(cli);
    expect(next.cursor).toBe(upTo);
    expect(next.events.every(({ number }) => number > upTo)).toBe(true);
    expect(numbers(next.events)).toEqual(numbers(all).slice(-1));
  });

  it("moves only the cursor of the client that acknowledged: the CLI's leaves the MCP client's where it was", async () => {
    const cliCursor = (await read(cli)).cursor;
    expect(cliCursor).toBeGreaterThan(0);
    const other = await read(mcp);
    expect(other.cursor).toBe(0);
    expect(questions(other.events)).toHaveLength(3);
    // And the MCP client's acknowledgement leaves the CLI's cursor alone.
    const last = other.events.at(-1)?.number ?? 0;
    await acknowledge(mcp, last);
    expect((await read(mcp)).events).toEqual([]);
    expect((await read(cli)).cursor).toBe(cliCursor);
  });

  it("keeps a cursor per user, per personal access token and for the web UI", async () => {
    // Bob's CLI has no cursor of its own yet, so it starts where Bob's web inbox is, not where Alice's CLI is.
    const { rows } = await install.owner.query<{ acknowledged: string }>("SELECT acknowledged FROM read_cursors WHERE user_id = $1 AND reader = 'web'", [bob]);
    expect((await read(oauthTokenOf(bob, CLI_CLIENT, "cli"))).cursor).toBe(Number(rows[0]?.acknowledged ?? 0));
    expect((await read(cli)).cursor).toBeGreaterThan(Number(rows[0]?.acknowledged ?? 0));
    expect((await read(tokenOf(alice))).cursor).toBe(0);
    expect(await install.web(web).read("events.read", {})).toMatchObject({ ok: true, output: { cursor: 0 } });
  });

  it("never moves a cursor back", async () => {
    const before = (await read(cli)).cursor;
    expect(await acknowledge(cli, 1)).toMatchObject({ status: 200, body: { cursor: before } });
    expect((await read(cli)).cursor).toBe(before);
  });

  it("gets 404 for an update that does not exist yet, and moves nothing", async () => {
    const before = (await read(cli)).cursor;
    const answer = await acknowledge(cli, 1_000_000);
    expect(answer).toEqual({ status: 404, body: expect.objectContaining({ type: "https://tiehall.com/problems/record-not-found" }) });
    expect((await read(cli)).cursor).toBe(before);
    expect((await acknowledge(cli, -1)).status).toBe(400);
  });

  it("brings new updates after the cursor, and only them", async () => {
    const all = await read(cli);
    await acknowledge(cli, all.events.at(-1)?.number ?? all.cursor);
    await question("And on mobile?");
    expect(questions((await read(cli)).events)).toHaveLength(1);
    expect((await read(cli)).events).toHaveLength(1);
  });
});

// requests: Read cursors move only on acknowledgement, "A new client starts at the web inbox's place"; requester-loop:
// The pull readers, "A new client starts where the web inbox is".
describe("a reader with no cursor yet", () => {
  it("starts at the user's web inbox cursor, keeps that place when the web inbox moves on, and is never moved back", async () => {
    const carol = await addUser(install.owner, { login: "carol" });
    await joinTeams(install.owner, carol, team["FE"] ?? "");
    // Two new requests to FE, which reach Carol through FE.
    const first = await openRequestInTheWebUi<{ id: string }>(install, alice, { targetTeam: "FE" });
    const second = await openRequestInTheWebUi<{ id: string }>(install, alice, { targetTeam: "FE" });
    const carolsWeb = sessionOf(carol);
    const feed = await install.web(carolsWeb).read<{ events: ReadEvent[] }>("inbox.updates", { limit: 50 });
    const openings = (feed.ok ? feed.output.events : []).filter(({ type }) => type === "request.opened");
    const [atFirst, atSecond] = [first.id, second.id].map((id) => openings.find(({ data }) => data["requestId"] === id)?.number ?? 0);
    expect(atFirst).toBeGreaterThan(0);
    expect(atSecond).toBeGreaterThan(atFirst ?? 0);
    expect(await install.web(carolsWeb).write("inbox.updates", { acknowledge: atFirst }, install.fromThePage(carolsWeb))).toMatchObject({ ok: true });
    // A new MCP client of Carol's starts after the web inbox's place, not at the first event.
    const carolsMcp = oauthTokenOf(carol, MCP_CLIENT, "mcp");
    const firstRead = await read(carolsMcp);
    expect(firstRead.cursor).toBe(atFirst);
    expect(numbers(firstRead.events)).toEqual([atSecond]);
    // The web inbox moves on; the client keeps its place, so reading without acknowledging returns the same updates.
    expect(await install.web(carolsWeb).write("inbox.updates", { acknowledge: atSecond }, install.fromThePage(carolsWeb))).toMatchObject({ ok: true });
    expect(await read(carolsMcp)).toEqual(firstRead);
    // The CLI's first login starts where the web inbox is now.
    expect(await read(oauthTokenOf(carol, CLI_CLIENT, "cli"))).toMatchObject({ cursor: atSecond, events: [] });
    // A personal access token that acknowledges an earlier update on its first call starts at the web inbox's place all the same.
    expect(await acknowledge(tokenOf(carol), atFirst ?? 0)).toMatchObject({ status: 200, body: { cursor: atSecond } });
  });
});

// requester-loop: The hooks read with the CLI's cursor and acknowledge nothing (decisions-from-groups-15-28: design.md,
// Decisions this change rests on: D55 (44); design.md, Technical decisions: T6). The hooks read after the furthest
// cursor of the user's CLI and other agent clients, which such a read neither moves nor creates.
describe("a read after the furthest cursor of the user's agents", () => {
  async function cursors(userId: string): Promise<Record<string, number>> {
    const { rows } = await install.owner.query<{ reader: string; acknowledged: string }>("SELECT reader, acknowledged FROM read_cursors WHERE user_id = $1", [userId]);
    return Object.fromEntries(rows.map(({ reader, acknowledged }) => [reader, Number(acknowledged)]));
  }

  it("reads after the furthest of the CLI's and the other agent clients' cursors, and moves and creates no cursor", async () => {
    // The MCP client acknowledges everything so far; the CLI stays behind.
    const all = await read(mcp);
    const furthest = all.events.at(-1)?.number ?? all.cursor;
    await acknowledge(mcp, furthest);
    await question("And in print?");
    const before = await cursors(alice);
    expect(before[`oauth:${CLI_CLIENT}`]).toBeLessThan(furthest);
    const answer = await callApi(install, oauthTokenOf(alice, CLI_CLIENT, "cli"), "POST", "/api/v1/updates", { limit: 50, readAfter: "furthest_cursor" });
    expect(answer.status).toBe(200);
    expect(answer.body.cursor).toBe(furthest);
    expect(numbers(answer.body.events).every((number) => number > furthest)).toBe(true);
    expect(questions(answer.body.events)).toHaveLength(1);
    // A new client of Alice's reads that way too, and is given no cursor of its own.
    expect((await callApi(install, oauthTokenOf(alice, "https://hooks.example/client.json", "api"), "POST", "/api/v1/updates", { readAfter: "furthest_cursor" })).body.cursor).toBe(furthest);
    expect(await cursors(alice)).toEqual(before);
  });

  it("refuses an acknowledgement with 400, and moves nothing", async () => {
    const before = await cursors(alice);
    const answer = await callApi(install, cli, "POST", "/api/v1/updates", { readAfter: "furthest_cursor", acknowledge: 1 });
    expect(answer).toEqual({ status: 400, body: expect.objectContaining({ type: "https://tiehall.com/problems/invalid-input" }) });
    expect(await cursors(alice)).toEqual(before);
  });
});

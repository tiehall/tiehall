import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Read cursors move only on acknowledgement (requests: Read cursors move only
// on acknowledgement; design.md, Design rules: Requests and events). Each user
// has a read cursor per client: an agent reads the events after its cursor,
// and the cursor moves only when the reader acknowledges them, so reading
// without acknowledging returns the same events again. The CLI and an MCP
// client are two clients, each with its own cursor, whichever endpoint the
// MCP client's token calls; so is each personal access token and the web UI.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;

/** An MCP client's id, as its Client ID Metadata Document names it. */
const MCP_CLIENT = "https://agent.example/client-metadata.json";
/** The CLI's registered OAuth client. */
const CLI_CLIENT = "tiehall-cli";

let cli: Caller;
let mcp: Caller;

interface ReadEvent {
  number: number;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE"]) team[name] = await addTeam(install.owner, name);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, bob, team["FE"] ?? "");
  cli = oauthTokenOf(alice, CLI_CLIENT, "cli");
  mcp = oauthTokenOf(alice, MCP_CLIENT, "api");
  // Some events to read: two requests opened, and a question on the first.
  const first = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${first.key}/messages`, { kind: "question", body: "Which browsers?" });
});

afterAll(async () => {
  await install.close();
});

async function read(caller: Caller, query = ""): Promise<{ events: ReadEvent[]; cursor: number }> {
  const answer = await callApi(install, caller, "GET", `/api/v1/events${query}`);
  if (answer.status !== 200) throw new Error(`events.read answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

const acknowledge = (caller: Caller, upTo: number) => callApi(install, caller, "POST", "/api/v1/events/acknowledge", { upTo });
const numbers = (events: ReadEvent[]) => events.map(({ number }) => number);

describe("reading events", () => {
  it("returns the events after the reader's cursor, oldest first, with their type and the ids they carry", async () => {
    const { events, cursor } = await read(cli);
    expect(cursor).toBe(0);
    expect(events.map(({ type }) => type)).toEqual(["request.opened", "request.opened", "request.message_posted"]);
    expect(numbers(events)).toEqual([...numbers(events)].sort((a, b) => a - b));
    expect(events[2]).toEqual({
      number: expect.any(Number),
      type: "request.message_posted",
      occurredAt: expect.any(String),
      data: { requestId: expect.any(String), messageId: expect.any(String), kind: "question", blocking: false },
    });
  });

  it("returns the same events again when the reader has not acknowledged them", async () => {
    const first = await read(cli);
    const second = await read(cli);
    expect(second).toEqual(first);
  });

  it("returns at most the number of events asked for", async () => {
    const all = await read(cli);
    expect(numbers((await read(cli, "?limit=2")).events)).toEqual(numbers(all.events).slice(0, 2));
    expect((await callApi(install, cli, "GET", "/api/v1/events?limit=0")).status).toBe(400);
    expect((await callApi(install, cli, "GET", "/api/v1/events?limit=501")).status).toBe(400);
  });
});

describe("acknowledging", () => {
  it("up to event N makes the reader's next read start after N", async () => {
    const [, second] = (await read(cli)).events;
    const upTo = second?.number ?? 0;
    expect(await acknowledge(cli, upTo)).toEqual({ status: 200, body: { cursor: upTo } });
    const next = await read(cli);
    expect(next.cursor).toBe(upTo);
    expect(next.events.every(({ number }) => number > upTo)).toBe(true);
    expect(next.events.map(({ type }) => type)).toEqual(["request.message_posted"]);
  });

  it("moves only the cursor of the client that acknowledged: the CLI's leaves the MCP client's where it was", async () => {
    const cliCursor = (await read(cli)).cursor;
    expect(cliCursor).toBeGreaterThan(0);
    const other = await read(mcp);
    expect(other.cursor).toBe(0);
    expect(other.events).toHaveLength(3);
    // And the MCP client's acknowledgement leaves the CLI's cursor alone.
    const last = other.events.at(-1)?.number ?? 0;
    await acknowledge(mcp, last);
    expect((await read(mcp)).events).toEqual([]);
    expect((await read(cli)).cursor).toBe(cliCursor);
  });

  it("keeps a cursor per user, per personal access token and for the web UI", async () => {
    expect((await read(oauthTokenOf(bob, CLI_CLIENT, "cli"))).cursor).toBe(0);
    expect((await read(tokenOf(alice))).cursor).toBe(0);
    const caller = sessionOf(alice);
    expect(await install.web(caller).read("events.read", {})).toMatchObject({ ok: true, output: { cursor: 0 } });
  });

  it("never moves a cursor back", async () => {
    const before = (await read(cli)).cursor;
    expect(await acknowledge(cli, 1)).toEqual({ status: 200, body: { cursor: before } });
    expect((await read(cli)).cursor).toBe(before);
  });

  it("gets 404 for an event that does not exist yet, and moves nothing", async () => {
    const before = (await read(cli)).cursor;
    const answer = await acknowledge(cli, 1_000_000);
    expect(answer).toEqual({ status: 404, body: expect.objectContaining({ type: "https://tiehall.com/problems/record-not-found" }) });
    expect((await read(cli)).cursor).toBe(before);
    expect((await acknowledge(cli, -1)).status).toBe(400);
  });

  it("brings new events after the cursor, and only them", async () => {
    const { cursor } = await read(cli);
    const all = await read(cli);
    await acknowledge(cli, all.events.at(-1)?.number ?? cursor);
    await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "A new one" });
    expect((await read(cli)).events.map(({ type }) => type)).toEqual(["request.opened"]);
  });
});

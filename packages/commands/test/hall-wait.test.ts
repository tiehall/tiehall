import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { waitForHall } from "@tiehall/catalog";
import { Refusal, requestProviderChangeShipped, requestStateChanged } from "@tiehall/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendEvent } from "../src/append-event.ts";
import { actorWords } from "../src/event-lines.ts";
import { HALL_HANDLERS, HALL_HOLD_MS } from "../src/hall.ts";
import { withOrg, type Caller, type EventWakeups, type PrepareContext, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// The live hall's long-poll (web-ui: The live hall's reads and its long-poll;
// requester-loop: No push paths other than the hooks; activity-log: Security
// events are shown to admins only; design.md, Design: The live hall; D57
// (12)). hall.wait answers at once when a domain event about a request comes
// after the cursor; otherwise it holds, woken through Postgres's LISTEN and
// NOTIFY, answers within 2 seconds of a commit, gathering a burst committed
// within 250 milliseconds into one answer, and reads again on its own every 5
// seconds should a wake-up be lost; when its hold ends it answers with no
// events and the cursor it was given. Its answers carry the server's time, the
// new events, the requests they name as they are now by id, every team's and
// the lines' counts, the people and agents at work and the new cursor; past 50
// events, only that the page must read the state again. A security event
// never ends it, and while the app shuts down it ends at once with 503 and
// Retry-After: 0. Here the holds are shortened, as the install's settings
// allow a test to, the API wait's differently from the hall's, the clock is a
// test's own that follows the real one, and the shutdown is the install's own
// signal.

/** How long the hall's wait holds here, instead of 25 seconds. */
const HOLD_MS = 1_500;
/** How long the API's wait holds here, which the hall's does not take. */
const API_HOLD_MS = 4_000;
const MARKER = "MARKER-c03f5a: text people wrote";
const EXAMPLE_AGENT = "https://client.example.com/tiehall.json";

let install: TestInstall;
const shutdown = new AbortController();
let offset = 0;
const team: Record<string, string> = {};
const person: Record<string, string> = {};

function id(login: string): string {
  const found = person[login];
  if (found === undefined) throw new Error(`No person ${login}.`);
  return found;
}

interface Ref {
  id: string;
  key: string;
}

interface Answer {
  now: string;
  cursor: number;
  reload: boolean;
  events: { seq: number; type: string; line: string; actor: { kind: string; user: { login: string } | null }; request: Ref & { state: string } }[];
  requestLines: (Ref & { state: string; from: Ref; to: Ref; terminal: boolean; claimant: { login: string } | null; untrusted: { title: string } })[];
  teams: { key: string; counts: Record<string, number>; doneLastDay: number }[];
  lines: { from: Ref; to: Ref; counts: Record<string, number> }[];
  atWork: { actor: { kind: string; user: { login: string } | null }; request: Ref }[];
}

interface Waited {
  answer: Answer;
  /** When the answer came, by the real clock. */
  at: number;
}

/** Waits as this member from the cursor, narrowed as asked; resolves with the answer and when it came. No answer may hold the text people wrote. */
async function wait(after: number, narrowing: { team?: string; agents?: boolean } = {}, caller: WebSessionCaller = sessionOf(id("oli"))): Promise<Waited> {
  const answer = (await install.execute("hall.wait", caller, { after, ...narrowing }, { readOnly: true })) as Answer;
  expect(JSON.stringify(answer)).not.toContain("MARKER-c03f5a");
  return { answer, at: Date.now() };
}

/** The number of the install's last event, which a wait that should see only what comes next starts from. */
async function lastNumber(): Promise<number> {
  const { rows } = await install.owner.query<{ last: string }>("SELECT coalesce(max(number), 0) AS last FROM events");
  return Number(rows[0]?.last ?? 0);
}

async function requestIdOf(key: string): Promise<string> {
  const [teamKey, number] = key.split("-");
  const { rows } = await install.owner.query<{ id: string }>(
    "SELECT requests.id FROM requests JOIN teams ON teams.id = requests.target_team_id WHERE teams.key = $1 AND requests.number = $2",
    [teamKey, Number(number)],
  );
  return rows[0]?.id ?? "";
}

/** An event about a request that changes nothing else, committed on its own, as a system action. */
async function shipped(requestId: string): Promise<void> {
  await withOrg(install.db, (context) => appendEvent(context, requestProviderChangeShipped, { requestId }, { actorKind: "system", surface: "github" }));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  install = await startTestInstall({ now: () => new Date(Date.now() + offset), wait: { holdMs: API_HOLD_MS, hallHoldMs: HOLD_MS, shutdown: shutdown.signal } });
  for (const key of ["BE", "FE", "MOB", "OPS"]) team[key] = await addTeam(install.owner, key);
  for (const [login, teamKey, role] of [
    ["sam", "BE", "member"],
    ["bob", "FE", "member"],
    ["dana", "FE", "member"],
    ["oli", "OPS", "member"],
    ["pia", "FE", "admin"],
    ["lee", "OPS", "member"],
  ] as const) {
    person[login] = await addUser(install.owner, { login, role });
    await joinTeams(install.owner, id(login), team[teamKey] ?? "");
  }
  await install.owner.query(
    "INSERT INTO oauth_clients (org_id, client_id, name, client_discovery_id, redirect_uris) SELECT id, $1, 'Example Agent', 'cimd', ARRAY['https://client.example.com/callback'] FROM orgs",
    [EXAMPLE_AGENT],
  );
}, 120_000);

afterAll(async () => {
  await install?.close();
});

describe("hall.wait", () => {
  it("answers at once when an event about a request comes after the cursor: the events oldest first, the requests they name, the teams, the lines, the people at work and the cursor", async () => {
    const cursor = await lastNumber();
    await openRequest(install, tokenOf(id("sam")), { targetTeam: "FE", title: "Add a forgot password link", packet: { schema_version: "1-beta", kind: "request", untrusted: { need: MARKER } } });
    expect((await callApi(install, oauthTokenOf(id("bob"), EXAMPLE_AGENT, "mcp"), "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
    const started = Date.now();
    const { answer, at } = await wait(cursor);
    expect(at - started).toBeLessThan(HOLD_MS / 2);
    expect(Date.parse(answer.now)).toBeGreaterThanOrEqual(started - 1000);
    expect(answer.reload).toBe(false);
    expect(answer.events.map(({ type, line, actor, request }) => [type, line, actorWords(actor as never), request.key, request.state])).toEqual([
      ["request.opened", "It was opened", "sam's agent", "FE-1", "claimed"],
      ["request.claimed", "It was claimed", "bob's agent", "FE-1", "claimed"],
    ]);
    expect(answer.cursor).toBe(answer.events[1]?.seq);
    expect(answer.cursor).toBe(await lastNumber());
    expect(answer.requestLines).toEqual([
      expect.objectContaining({
        id: await requestIdOf("FE-1"),
        key: "FE-1",
        state: "claimed",
        from: { id: team["BE"], key: "BE" },
        to: { id: team["FE"], key: "FE" },
        claimant: expect.objectContaining({ login: "bob" }),
        terminal: false,
        untrusted: { title: "Add a forgot password link" },
      }),
    ]);
    expect(answer.teams.map(({ key }) => key)).toEqual(["BE", "FE", "MOB", "OPS"]);
    expect(answer.teams.find(({ key }) => key === "FE")?.counts).toEqual({ open: 0, claimed: 1, in_progress: 0, needs_info: 0 });
    expect(answer.lines).toEqual([{ from: { id: team["BE"], key: "BE" }, to: { id: team["FE"], key: "FE" }, counts: { open: 0, claimed: 1, in_progress: 0, needs_info: 0 } }]);
    expect(answer.atWork.map(({ actor, request }) => [actorWords(actor as never), request.key])).toEqual([
      ["bob's agent", "FE-1"],
      ["sam's agent", "FE-1"],
    ]);
  });

  it("holds, and answers within 2 seconds of a commit", async () => {
    const waiting = wait(await lastNumber());
    await pause(300);
    const committed = Date.now();
    expect((await callApi(install, tokenOf(id("dana")), "POST", "/api/v1/requests/FE-1/messages", { kind: "comment", body: MARKER })).status).toBe(200);
    const { answer, at } = await waiting;
    expect(at - committed).toBeLessThan(2_000);
    expect(answer.events.map(({ type, line }) => [type, line])).toEqual([["request.message_posted", "A comment was posted"]]);
  });

  it("gathers a burst of events committed within 250 milliseconds into one answer", async () => {
    const requestId = await requestIdOf("FE-1");
    const waiting = wait(await lastNumber());
    await pause(300);
    for (let index = 0; index < 3; index += 1) await shipped(requestId);
    const { answer } = await waiting;
    expect(answer.events.map(({ type }) => type)).toEqual(["request.provider_change_shipped", "request.provider_change_shipped", "request.provider_change_shipped"]);
  });

  it("answers 200 with no events and the cursor it was given when its hold ends", async () => {
    const cursor = await lastNumber();
    const started = Date.now();
    const { answer, at } = await wait(cursor);
    expect(at - started).toBeGreaterThanOrEqual(HOLD_MS - 50);
    expect(answer).toMatchObject({ cursor, reload: false, events: [], requestLines: [] });
    expect(answer.teams).toHaveLength(4);
  });

  it("takes its hold from the hall's own setting, 25 seconds unless a test shortens it, while the API's wait keeps its own", async () => {
    expect(HALL_HOLD_MS).toBe(25_000);
    const cursor = await lastNumber();
    const started = Date.now();
    const hall = wait(cursor);
    const api = install.api(tokenOf(id("sam")))(new Request(`${URL_OF_INSTALL}/api/v1/events/wait?cursor=${cursor}`)).then(() => Date.now());
    const { at } = await hall;
    expect(at - started).toBeLessThan(API_HOLD_MS - 1_000);
    expect((await api) - started).toBeGreaterThanOrEqual(API_HOLD_MS - 50);
  });

  it("is not ended by a security event, such as a role change, an admin's wait included", async () => {
    const cursor = await lastNumber();
    const started = Date.now();
    const waits = [wait(cursor), wait(cursor, {}, sessionOf(id("pia")))];
    await pause(200);
    expect((await install.confirm(sessionOf(id("pia")), "members.change_role", { userId: id("lee"), role: "admin" })).status).toBe(200);
    for (const { answer, at } of await Promise.all(waits)) {
      expect(at - started).toBeGreaterThanOrEqual(HOLD_MS - 50);
      expect(answer).toMatchObject({ cursor, events: [] });
      expect(JSON.stringify(answer)).not.toMatch(/member\.|"lee"/);
    }
  });

  it("asks the page to read the state again, with no events, past 50 events, and brings 50", async () => {
    const requestId = await requestIdOf("FE-1");
    const before = await lastNumber();
    for (let index = 0; index < 50; index += 1) await shipped(requestId);
    const fifty = (await wait(before)).answer;
    expect(fifty.reload).toBe(false);
    expect(fifty.events).toHaveLength(50);
    expect(fifty.cursor).toBe(await lastNumber());
    await shipped(requestId);
    const more = (await wait(before)).answer;
    expect(more).toMatchObject({ reload: true, events: [], requestLines: [] });
  });

  it("names a reassigned request under its new key with its id, and as gone from a hall narrowed to the team it left", async () => {
    await openRequest(install, tokenOf(id("sam")), { targetTeam: "FE", title: "Move the banner" });
    const requestId = await requestIdOf("FE-2");
    const cursor = await lastNumber();
    const reassign = await callApi(install, tokenOf(id("bob")), "POST", "/api/v1/requests/FE-2/proposals", { kind: "reassign", team: "MOB" });
    expect(reassign.status).toBe(202);
    expect((await install.confirm(sessionOf(id("bob")), "proposals.confirm", { proposal: reassign.body.proposal.id })).status).toBe(200);
    const all = (await wait(cursor)).answer;
    expect(all.requestLines).toEqual([expect.objectContaining({ id: requestId, key: "MOB-1", to: { id: team["MOB"], key: "MOB" }, terminal: false })]);
    expect(all.lines.map(({ from, to }) => `${from.key}>${to.key}`)).toEqual(["BE>FE", "BE>MOB"]);
    const fe = (await wait(cursor, { team: "FE" })).answer;
    expect(fe.requestLines).toEqual([expect.objectContaining({ id: requestId, key: "MOB-1", terminal: true })]);
    expect(fe.lines.map(({ from, to }) => `${from.key}>${to.key}`)).toEqual(["BE>FE"]);
    expect(fe.events).toEqual([]);
    const mob = (await wait(cursor, { team: "MOB" })).answer;
    expect(mob.events.length).toBeGreaterThan(0);
    expect(mob.events.every(({ request }) => request.id === requestId && request.key === "MOB-1")).toBe(true);
  });

  it("names a request that reached a terminal state as gone, and counts it done within the last 24 hours", async () => {
    const requestId = await requestIdOf("FE-1");
    const cursor = await lastNumber();
    await install.owner.query("UPDATE requests SET state = 'done' WHERE id = $1", [requestId]);
    await withOrg(install.db, (context) => appendEvent(context, requestStateChanged, { requestId, state: "done", previousState: "claimed" }, { actorKind: "system", surface: "github" }));
    const { answer } = await wait(cursor);
    expect(answer.events.map(({ type, actor }) => [type, actorWords(actor as never)])).toEqual([["request.state_changed", "Tiehall"]]);
    expect(answer.requestLines).toEqual([expect.objectContaining({ key: "FE-1", state: "done", terminal: true })]);
    expect(answer.teams.find(({ key }) => key === "FE")).toMatchObject({ counts: { open: 0, claimed: 0, in_progress: 0, needs_info: 0 }, doneLastDay: 1 });
    expect(answer.lines.map(({ from, to }) => `${from.key}>${to.key}`)).toEqual(["BE>MOB"]);
  });

  it("narrows the events and the people at work to what agents did", async () => {
    await openRequest(install, tokenOf(id("sam")), { targetTeam: "FE", title: "Fix the footer" });
    const cursor = await lastNumber();
    const session = sessionOf(id("dana"));
    expect(await install.web(session).write("messages.post", { key: "FE-3", kind: "comment", body: MARKER }, install.fromThePage(session))).toMatchObject({ ok: true });
    expect((await callApi(install, tokenOf(id("bob")), "POST", "/api/v1/requests/FE-3/messages", { kind: "comment", body: MARKER })).status).toBe(200);
    const all = (await wait(cursor)).answer;
    expect(all.events.map(({ actor }) => actor.kind)).toEqual(["web", "agent"]);
    const agents = (await wait(cursor, { agents: true })).answer;
    expect(agents.events.map(({ actor }) => actorWords(actor as never))).toEqual(["bob's agent"]);
    expect(agents.atWork.every(({ actor }) => actor.kind === "agent")).toBe(true);
    expect(agents.requestLines.map(({ key }) => key)).toEqual(["FE-3"]);
  });

  it("refuses a removed member with 403, and holds nothing", async () => {
    const lee = sessionOf(id("lee"));
    expect((await install.confirm(sessionOf(id("pia")), "members.remove", { userId: id("lee") })).status).toBe(200);
    const started = Date.now();
    await expect(install.execute("hall.wait", lee, { after: 0 }, { readOnly: true })).rejects.toMatchObject({ reason: "removed-member" });
    expect(Date.now() - started).toBeLessThan(HOLD_MS / 2);
  });

  it("is offered by no agent surface: neither the OpenAPI document nor the MCP tools name it", () => {
    for (const file of ["../../../openapi/v1.json", "../../../mcp/tools.json"]) {
      expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"), file).not.toMatch(/\bhall\.(state|wait)\b|readHall|waitForHall/);
    }
  });
});

// A wake-up lost with a lost listening connection: the wait's own step runs here with wake-ups that never come, and
// reads again on its own.
describe("a wait whose wake-up is lost", () => {
  it("answers within 5 seconds of the commit, by its own re-read", { timeout: 30_000 }, async () => {
    const step = HALL_HANDLERS[waitForHall.id]?.prepare;
    if (step === undefined) throw new Error("The hall's wait has no step that holds.");
    const never: EventWakeups = {
      ready: async () => {},
      next: () => ({ woken: new Promise<void>(() => {}), cancel: () => {} }),
      close: async () => {},
    };
    const context = {
      caller: sessionOf(id("oli")) as Caller,
      member: undefined,
      github: undefined,
      secrets: undefined,
      sealed: {},
      read: (read) => withOrg(install.db, read, { readOnly: true }),
      url: URL_OF_INSTALL,
      waits: { wakeups: never, hallHoldMs: 20_000 },
    } satisfies PrepareContext;
    const requestId = await requestIdOf("FE-3");
    const holding = step({ after: await lastNumber() }, context).then((prepared) => ({ prepared, at: Date.now() }));
    await pause(300);
    const committed = Date.now();
    await shipped(requestId);
    const { prepared, at } = await holding;
    expect(prepared).toEqual({ found: true });
    expect(at - committed).toBeGreaterThan(2_000);
    expect(at - committed).toBeLessThanOrEqual(5_000);
  });
});

// While the app shuts down (self-host-install: A restart stops the app gracefully). This runs last: once the install
// shuts down, every wait ends at once.
describe("a shutdown", () => {
  it("ends a held wait with 503 and Retry-After: 0 at once, and a wait that starts afterwards too", async () => {
    const waiting = wait(await lastNumber()).then(
      () => undefined,
      (error: unknown) => ({ error, at: Date.now() }),
    );
    await pause(200);
    const stopped = Date.now();
    shutdown.abort();
    const ended = await waiting;
    expect(ended?.error).toBeInstanceOf(Refusal);
    expect(ended?.error).toMatchObject({ reason: "shutting-down", status: 503, retryAfterSeconds: 0 });
    expect((ended?.at ?? Number.POSITIVE_INFINITY) - stopped).toBeLessThan(500);
    const started = Date.now();
    await expect(install.execute("hall.wait", sessionOf(id("oli")), { after: 0 }, { readOnly: true })).rejects.toMatchObject({ reason: "shutting-down", status: 503 });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { actorWords as serverActorWords, clientParts as serverClientParts, relativeTime as serverRelativeTime, type EventActor } from "../src/event-lines.ts";
import { countsWords as serverCountsWords, waitingRows as serverWaitingRows } from "../src/hall-page.ts";
import { initialsOf as serverInitialsOf } from "../src/shell.ts";

// The live hall's script, its pure parts (web-ui: The live hall; web-ui: The
// live hall's reads and its long-poll; web-ui: The live hall with many teams
// and on a phone; design.md, Design: The live hall; D57 (11), (12)). The
// script, packages/commands/assets/hall.js, exports what it computes without a
// page: the ring of team nodes, which keeps every node apart in the map's box
// at a viewport of 1,280 by 800 CSS pixels for every team count from 1 to 20,
// and above 20 shows the 19 most active teams, ties by key, and one node for
// the others; the curve of a line, two lines between the same teams curving
// apart; a team with a question waiting, whose node and row the stylesheet
// lights in gold (D59 (2)); the merge of a wait's answer into the state by
// id; relative times from the answer's time; the delays of its retries; and
// the words it shows, which are the server's. It runs on a page only when the page loads it, so
// importing it here runs nothing.

const HALL_JS = fileURLToPath(new URL("../assets/hall.js", import.meta.url));

interface Point {
  x: number;
  y: number;
}
interface Size {
  width: number;
  height: number;
}
interface Counts {
  open: number;
  claimed: number;
  in_progress: number;
  needs_info: number;
}
interface Team {
  id: string;
  key: string;
  counts: Counts;
  doneLastDay: number;
  untrusted: { name: string };
}
interface Ref {
  id: string;
  key: string;
}
interface RequestLine {
  id: string;
  key: string;
  state: string;
  from: Ref;
  to: Ref;
  needsHuman: boolean;
  untrusted: { title: string };
  claimant: null;
  changedAt: string;
  terminal?: boolean;
}
interface HallEvent {
  seq: number;
  at: string;
  type: string;
  line: string;
  actor: EventActor;
  team: Ref | null;
  request: Omit<RequestLine, "claimant" | "changedAt" | "terminal">;
}
interface HallState {
  now: string;
  cursor: number;
  teams: Team[];
  lines: { from: Ref; to: Ref; counts: Counts }[];
  requestLines: RequestLine[];
  atWork: unknown[];
  feed: HallEvent[];
}

/** What hall.js exports, as the tests use it. */
interface HallScript {
  ringLayout(count: number, box: Size): { size: Size; centers: Point[] };
  nodeSize(count: number): Size;
  overlap(a: Point, b: Point, size: Size): boolean;
  NODE_GAP: number;
  mapNodes(teams: Team[], lines: HallState["lines"], narrowedTo: string | undefined): { nodes: { id: string; key: string; name: string; counts: Counts; others: number }[]; nodeOf: Map<string, string> };
  cordPath(from: Point, to: Point, middle: Point, both: boolean): string;
  cordControl(from: Point, to: Point, middle: Point, both: boolean): Point;
  cordWidth(counts: Counts): number;
  placeChip(chip: Size, node: { center: Point; size: Size }, middle: Point, box: Size, taken: (Point & Size)[]): (Point & Size) | undefined;
  pressingState(counts: Counts): string;
  asking(counts: Counts): boolean;
  mergeChange(state: HallState, change: Omit<HallState, "feed"> & { reload: boolean; events: HallEvent[] }): { state: HallState; reread: boolean; added: HallEvent[] };
  relativeTime(at: string, now: number): string;
  retryDelay(failures: number, random?: () => number): number;
  actorWords(actor: EventActor): string;
  clientParts(client: NonNullable<EventActor["client"]>): { name: string; mark: string | null };
  initialsOf(login: string): string;
  countsWords(counts: Counts, doneLastDay?: number): string;
  waitingRows(feed: Pick<HallEvent, "seq" | "request">[]): Set<number>;
}

let hall: HallScript;

beforeAll(async () => {
  hall = (await import(pathToFileURL(HALL_JS).href)) as HallScript;
});

/** The map's box, the map's drawing area, at a viewport of 1,280 by 800 CSS pixels: the column beside the feed, under the legend. */
const MAP_BOX_AT_1280_BY_800: Size = { width: 770, height: 562 };

const NONE: Counts = { open: 0, claimed: 0, in_progress: 0, needs_info: 0 };
const team = (key: string, open = 0): Team => ({ id: `id-${key}`, key, counts: { ...NONE, open }, doneLastDay: 0, untrusted: { name: `Team ${key}` } });

/** Every pair of nodes that overlap, as their indexes. */
function overlapping(centers: Point[], size: Size): [number, number][] {
  const found: [number, number][] = [];
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = i + 1; j < centers.length; j += 1) {
      const a = centers[i] as Point;
      const b = centers[j] as Point;
      if (Math.abs(a.x - b.x) < size.width && Math.abs(a.y - b.y) < size.height) found.push([i, j]);
    }
  }
  return found;
}

describe("the ring of team nodes", () => {
  it("keeps every node apart, and inside the map's box, at a viewport of 1,280 by 800 for every team count from 1 to 20", () => {
    for (let count = 1; count <= 20; count += 1) {
      const { size, centers } = hall.ringLayout(count, MAP_BOX_AT_1280_BY_800);
      expect(centers, String(count)).toHaveLength(count);
      expect(overlapping(centers, { width: size.width + hall.NODE_GAP, height: size.height + hall.NODE_GAP }), `${count} teams`).toEqual([]);
      for (const { x, y } of centers) {
        expect(x - size.width / 2, `${count} teams`).toBeGreaterThanOrEqual(0);
        expect(y - size.height / 2, `${count} teams`).toBeGreaterThanOrEqual(0);
        expect(x + size.width / 2, `${count} teams`).toBeLessThanOrEqual(MAP_BOX_AT_1280_BY_800.width);
        expect(y + size.height / 2, `${count} teams`).toBeLessThanOrEqual(MAP_BOX_AT_1280_BY_800.height);
      }
    }
  });

  it("keeps every node apart in the boxes the map takes from a tablet's width up, for 20 teams and for 8", () => {
    for (const box of [
      { width: 718, height: 522 },
      { width: 718, height: 782 },
      { width: 770, height: 522 },
      { width: 1150, height: 782 },
    ]) {
      for (const count of [8, 20]) {
        const { size, centers } = hall.ringLayout(count, box);
        expect(overlapping(centers, size), `${count} teams in ${box.width} by ${box.height}`).toEqual([]);
      }
    }
  });

  it("draws large nodes for up to 8 teams, and compact ones for 9 to 20", () => {
    expect(hall.nodeSize(8)).toEqual({ width: 220, height: 92 });
    expect(hall.nodeSize(9)).toEqual({ width: 124, height: 52 });
  });

  it("puts the teams on the ring in the order of their keys, from the top", () => {
    const teams = ["PAY", "BE", "FE", "OPS"].map((key) => team(key));
    const { nodes } = hall.mapNodes(teams, [], undefined);
    expect(nodes.map(({ key }) => key)).toEqual(["BE", "FE", "OPS", "PAY"]);
    const { centers } = hall.ringLayout(4, MAP_BOX_AT_1280_BY_800);
    expect(centers[0]?.x).toBeCloseTo(MAP_BOX_AT_1280_BY_800.width / 2, 0);
    expect(centers[0]?.y).toBeLessThan(MAP_BOX_AT_1280_BY_800.height / 2);
  });

  it("shows every team up to 20, and above 20 the 19 with the most live requests, ties by key, and one node for the others", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => team(`T${String(index).padStart(2, "0")}`, index % 3));
    expect(hall.mapNodes(twenty, [], undefined).nodes).toHaveLength(20);
    // 25 teams: T00 to T24, the last six of them busier than the rest; the others node counts the 6 left out.
    const many = Array.from({ length: 25 }, (_, index) => team(`T${String(index).padStart(2, "0")}`, index >= 19 ? 5 : 1));
    const { nodes, nodeOf } = hall.mapNodes(many, [], undefined);
    expect(nodes).toHaveLength(20);
    expect(nodes.slice(0, 19).map(({ key }) => key)).toEqual([...Array.from({ length: 13 }, (_, index) => `T${String(index).padStart(2, "0")}`), "T19", "T20", "T21", "T22", "T23", "T24"]);
    expect(nodes[19]).toMatchObject({ id: "others", name: "+6 teams", others: 6, counts: { ...NONE, open: 6 } });
    expect(nodeOf.get("id-T13")).toBe("others");
    expect(nodeOf.get("id-T24")).toBe("id-T24");
  });

  it("above 20 teams, shows the team the hall is narrowed to and the teams on its lines", () => {
    const many = Array.from({ length: 25 }, (_, index) => team(`T${String(index).padStart(2, "0")}`, index >= 19 ? 5 : 1));
    const lines = [{ from: { id: "id-T15", key: "T15" }, to: { id: "id-T16", key: "T16" }, counts: { ...NONE, open: 1 } }];
    const { nodeOf } = hall.mapNodes(many, lines, "id-T16");
    expect(nodeOf.get("id-T15")).toBe("id-T15");
    expect(nodeOf.get("id-T16")).toBe("id-T16");
  });
});

describe("a line between two teams", () => {
  const middle = { x: 400, y: 300 };
  const a = { x: 150, y: 120 };
  const b = { x: 650, y: 140 };
  /** Which side of the line from a to b a point lies on: the sign of the cross product. */
  const side = (point: Point) => Math.sign((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x));

  it("curves through the ring's middle", () => {
    const control = hall.cordControl(a, b, middle, false);
    expect(side(control)).toBe(side(middle));
    expect(hall.cordPath(a, b, middle, false)).toMatch(/^M 150 120 Q [\d.]+ [\d.]+ 650 140$/);
  });

  it("curves apart from the line the other way between the same teams: their middles lie apart, and each bends to its own left", () => {
    /** The middle of a curve from p to q with this control point. */
    const halfway = (p: Point, control: Point, q: Point) => ({ x: 0.25 * p.x + 0.5 * control.x + 0.25 * q.x, y: 0.25 * p.y + 0.5 * control.y + 0.25 * q.y });
    const there = halfway(a, hall.cordControl(a, b, middle, true), b);
    const back = halfway(b, hall.cordControl(b, a, middle, true), a);
    expect(Math.hypot(there.x - back.x, there.y - back.y)).toBeGreaterThan(20);
    const alone = halfway(a, hall.cordControl(a, b, middle, false), b);
    expect(side(there) * side(alone)).toBeGreaterThanOrEqual(0);
    expect(Math.sign((there.x - alone.x) * (back.x - alone.x) + (there.y - alone.y) * (back.y - alone.y))).toBe(-1);
  });

  it("is 2 pixels wide for one request, a pixel more for each further one, 6 at most, in the color of its most pressing state", () => {
    expect([1, 2, 3, 5, 9].map((open) => hall.cordWidth({ ...NONE, open }))).toEqual([2, 3, 4, 6, 6]);
    expect(hall.pressingState({ open: 2, claimed: 1, in_progress: 1, needs_info: 1 })).toBe("needs_info");
    expect(hall.pressingState({ open: 2, claimed: 1, in_progress: 1, needs_info: 0 })).toBe("in_progress");
    expect(hall.pressingState({ ...NONE, open: 1, claimed: 1 })).toBe("claimed");
    expect(hall.pressingState({ ...NONE, open: 1 })).toBe("open");
  });
});

describe("a team with a question waiting", () => {
  it("is asking while one of the live requests addressed to it needs info, and only then", () => {
    expect(hall.asking({ ...NONE, needs_info: 1 })).toBe(true);
    expect(hall.asking({ open: 2, claimed: 1, in_progress: 1, needs_info: 3 })).toBe(true);
    expect(hall.asking({ open: 2, claimed: 1, in_progress: 1, needs_info: 0 })).toBe(false);
    expect(hall.asking(NONE)).toBe(false);
  });
});

describe("where a person or an agent at work sits on the map", () => {
  const box = MAP_BOX_AT_1280_BY_800;
  const middle = { x: box.width / 2, y: box.height / 2 };
  const node = { center: { x: 110 + 12, y: middle.y }, size: { width: 220, height: 92 } };
  const chip = { width: 200, height: 44 };
  const nodeRect = { x: node.center.x - 110, y: node.center.y - 46, width: 220, height: 92 };

  it("is beside its node, towards the ring's middle, inside the box", () => {
    const spot = hall.placeChip(chip, node, middle, box, [nodeRect]);
    expect(spot).toBeDefined();
    expect(spot?.x).toBeGreaterThanOrEqual(nodeRect.x + nodeRect.width);
    expect(Math.abs((spot?.y ?? 0) + chip.height / 2 - node.center.y)).toBeLessThan(1);
  });

  it("covers no node and no chip placed before it, and is left out when there is no room", () => {
    const taken = [nodeRect];
    for (let index = 0; index < 12; index += 1) {
      const spot = hall.placeChip(chip, node, middle, box, taken);
      if (spot === undefined) break;
      for (const other of taken) {
        const apart = spot.x >= other.x + other.width || other.x >= spot.x + spot.width || spot.y >= other.y + other.height || other.y >= spot.y + spot.height;
        expect(apart).toBe(true);
      }
      expect(spot.x).toBeGreaterThanOrEqual(0);
      expect(spot.y + spot.height).toBeLessThanOrEqual(box.height);
      taken.push(spot);
    }
    expect(taken.length).toBeGreaterThan(4);
    // No chip lies further from its node than two chips in.
    for (const spot of taken.slice(1)) expect(spot.x - (nodeRect.x + nodeRect.width)).toBeLessThan(3 * (chip.width + 12));
    expect(hall.placeChip(chip, node, middle, { width: 240, height: 100 }, [{ x: 0, y: 0, width: 240, height: 100 }])).toBeUndefined();
  });
});

describe("the feed's rows in the notice colors", () => {
  const row = (seq: number, id: string, state: string, needsHuman = false): Pick<HallEvent, "seq" | "request"> => ({
    seq,
    request: { id, key: id.toUpperCase(), state, from: { id: "id-BE", key: "BE" }, to: { id: "id-FE", key: "FE" }, needsHuman, untrusted: { title: `Request ${id}` } },
  });
  // Newest first, as the feed is: FE-1 needs info, with three rows; FE-2 waits for a person, with two; FE-3 waits on nobody.
  const feed = [row(9, "fe-1", "needs_info"), row(8, "fe-3", "in_progress"), row(7, "fe-2", "open", true), row(6, "fe-1", "needs_info"), row(5, "fe-2", "open", true), row(4, "fe-1", "needs_info"), row(3, "fe-3", "in_progress")];

  it("are only the newest row of each request that waits on a question or a person, so the feed does not turn gold", () => {
    expect([...hall.waitingRows(feed)].sort((a, b) => b - a)).toEqual([9, 7]);
    expect(hall.waitingRows([])).toEqual(new Set());
    expect(hall.waitingRows(feed.filter(({ request }) => request.id === "fe-3"))).toEqual(new Set());
  });

  it("are the rows the server fills on the page it serves", () => {
    for (const each of [feed, feed.slice(1), feed.slice(3), []]) expect(hall.waitingRows(each)).toEqual(serverWaitingRows(each));
  });
});

describe("a wait's answer, merged into the state", () => {
  const be = { id: "id-BE", key: "BE" };
  const fe = { id: "id-FE", key: "FE" };
  const ops = { id: "id-OPS", key: "OPS" };
  const actor: EventActor = { kind: "web", user: { id: "u1", login: "selin", kind: "human", bot: false }, client: null };
  const request = (id: string, key: string, to: Ref, state = "open", changedAt = "2026-10-11T12:00:00.000Z"): RequestLine => ({
    id,
    key,
    state,
    from: be,
    to,
    needsHuman: false,
    untrusted: { title: `Request ${key}` },
    claimant: null,
    changedAt,
  });
  const event = (seq: number, line: RequestLine): HallEvent => ({
    seq,
    at: "2026-10-11T12:00:00.000Z",
    type: "request.message_posted",
    line: "A comment was posted",
    actor,
    team: null,
    request: { id: line.id, key: line.key, state: line.state, from: line.from, to: line.to, needsHuman: line.needsHuman, untrusted: line.untrusted },
  });
  const teams = [team("BE"), team("FE"), team("OPS")].map((each) => ({ ...each, id: `id-${each.key}` }));
  const fe1 = request("r1", "FE-1", fe, "open", "2026-10-11T11:00:00.000Z");
  const fe2 = request("r2", "FE-2", fe, "claimed", "2026-10-11T11:30:00.000Z");
  const state: HallState = { now: "2026-10-11T12:00:00.000Z", cursor: 10, teams, lines: [], requestLines: [fe2, fe1], atWork: [], feed: [event(10, fe2), event(9, fe1)] };
  const change = (more: Partial<Omit<HallState, "feed"> & { reload: boolean; events: HallEvent[] }>) => ({
    now: "2026-10-11T12:01:00.000Z",
    cursor: 12,
    reload: false,
    events: [],
    requestLines: [],
    teams,
    lines: [],
    atWork: [],
    ...more,
  });

  it("puts the new events at the top of the feed, each once, and moves the cursor", () => {
    const changed = request("r1", "FE-1", fe, "claimed", "2026-10-11T12:01:00.000Z");
    const merged = hall.mergeChange(state, change({ events: [event(10, fe2), event(11, changed), event(12, changed)], requestLines: [changed] }));
    expect(merged.reread).toBe(false);
    expect(merged.added.map(({ seq }) => seq)).toEqual([11, 12]);
    expect(merged.state.feed.map(({ seq }) => seq)).toEqual([12, 11, 10, 9]);
    expect(merged.state.cursor).toBe(12);
    expect(merged.state.now).toBe("2026-10-11T12:01:00.000Z");
    expect(merged.state.requestLines.map(({ key, state: now }) => [key, now])).toEqual([
      ["FE-1", "claimed"],
      ["FE-2", "claimed"],
    ]);
    expect(merged.state.feed.find(({ seq }) => seq === 9)?.request.state).toBe("claimed");
  });

  it("drops a request that left the hall", () => {
    const done = { ...request("r2", "FE-2", fe, "done", "2026-10-11T12:01:00.000Z"), terminal: true };
    const merged = hall.mergeChange(state, change({ requestLines: [done] }));
    expect(merged.state.requestLines.map(({ key }) => key)).toEqual(["FE-1"]);
  });

  it("moves a reassigned request to its new line under its new key, by its id", () => {
    const moved = request("r1", "OPS-1", ops, "open", "2026-10-11T12:01:00.000Z");
    const merged = hall.mergeChange(state, change({ events: [event(11, moved)], requestLines: [moved] }));
    expect(merged.state.requestLines.map(({ id, key, to }) => [id, key, to.key])).toEqual([
      ["r1", "OPS-1", "OPS"],
      ["r2", "FE-2", "FE"],
    ]);
    expect(merged.state.feed.filter(({ request: each }) => each.id === "r1").map(({ request: each }) => each.key)).toEqual(["OPS-1", "OPS-1"]);
  });

  it("asks for a read of the state when the answer says so, or names a team the state does not have", () => {
    expect(hall.mergeChange(state, change({ reload: true })).reread).toBe(true);
    const mob = { ...team("MOB"), id: "id-MOB" };
    expect(hall.mergeChange(state, change({ teams: [...teams, mob] })).reread).toBe(true);
    expect(hall.mergeChange(state, change({ requestLines: [request("r3", "MOB-1", { id: "id-MOB", key: "MOB" })] })).reread).toBe(true);
    expect(hall.mergeChange(state, change({})).reread).toBe(false);
  });

  it("keeps the 50 latest events", () => {
    const many = Array.from({ length: 60 }, (_, index) => event(100 + index, fe1));
    expect(hall.mergeChange(state, change({ events: many })).state.feed.map(({ seq }) => seq)).toEqual(Array.from({ length: 50 }, (_, index) => 159 - index));
  });
});

describe("relative times", () => {
  it("count from the answer's time: now, seconds, minutes, hours and days", () => {
    const at = "2026-10-11T12:00:00.000Z";
    const from = Date.parse(at);
    expect([0, 4_000, 40_000, 3 * 60_000, 2 * 3_600_000, 3 * 86_400_000].map((later) => hall.relativeTime(at, from + later))).toEqual(["now", "now", "40 s", "3 min", "2 h", "3 d"]);
    for (const later of [0, 40_000, 3 * 60_000, 2 * 3_600_000, 3 * 86_400_000]) expect(hall.relativeTime(at, from + later)).toBe(serverRelativeTime(at, new Date(from + later).toISOString()));
  });
});

describe("the delays of the retries", () => {
  it("run from 1 to 30 seconds, doubling, each with at most 20 percent of spread", () => {
    const steps = [1, 2, 4, 8, 16, 30, 30];
    for (const [index, step] of steps.entries()) {
      const failures = index + 1;
      for (const random of [0, 0.5, 0.999]) {
        const delay = hall.retryDelay(failures, () => random);
        expect(delay, `${failures} failures`).toBeGreaterThanOrEqual(Math.max(1_000, step * 900));
        expect(delay, `${failures} failures`).toBeLessThanOrEqual(Math.min(30_000, step * 1_100));
      }
      expect(hall.retryDelay(failures, () => 0.5)).toBe(step * 1_000);
    }
  });
});

describe("the script's words", () => {
  const user = { id: "u1", login: "mert-kaya", kind: "human" as const, bot: false };
  const actors: EventActor[] = [
    { kind: "agent", user, client: { kind: "metadata_document", host: "client.example.com", version: null, unverified: false, untrusted: { name: "Example Agent" } } },
    { kind: "agent", user: { ...user, bot: true }, client: { kind: "registered", host: null, version: null, unverified: true, untrusted: { name: "<img src=x onerror=alert(1)>" } } },
    { kind: "agent", user, client: { kind: "registered", host: null, version: null, unverified: true, untrusted: { name: null } } },
    { kind: "agent", user, client: { kind: "cli", host: null, version: "0.4.0", unverified: false, untrusted: { name: null } } },
    { kind: "agent", user, client: { kind: "personal_access_token", host: null, version: null, unverified: false, untrusted: { name: null } } },
    { kind: "agent", user, client: null },
    { kind: "web", user, client: null },
    { kind: "tiehall", user: null, client: null },
    { kind: "github", user: null, client: null },
    { kind: "jira", user: null, client: null },
    { kind: "operator", user: null, client: null },
  ];

  it("keep a client's name, its own claim, apart from the mark Tiehall gives it, as the server does", () => {
    expect(actors.flatMap(({ client }) => (client === null ? [] : [hall.clientParts(client)]))).toEqual([
      { name: "Example Agent", mark: "(client.example.com)" },
      { name: "<img src=x onerror=alert(1)>", mark: "(unverified)" },
      { name: "unnamed client", mark: "(unverified)" },
      { name: "tiehall CLI 0.4.0", mark: null },
      { name: "personal access token", mark: null },
    ]);
  });

  it("are the server's: who acted, the client, the initials and the counts", () => {
    for (const actor of actors) {
      expect(hall.actorWords(actor)).toBe(serverActorWords(actor));
      if (actor.client !== null) expect(hall.clientParts(actor.client)).toEqual(serverClientParts(actor.client));
    }
    for (const login of ["mert-kaya", "selin", "a", "x1-y2", "Ayse_Y"]) expect(hall.initialsOf(login)).toBe(serverInitialsOf(login));
    for (const [counts, done] of [
      [NONE, 0],
      [NONE, 2],
      [{ open: 3, claimed: 1, in_progress: 2, needs_info: 1 }, 0],
      [{ ...NONE, needs_info: 1 }, 4],
    ] as const) {
      expect(hall.countsWords(counts, done)).toBe(serverCountsWords(counts, done));
    }
  });

  it("are set as text: the script writes no markup into the page", () => {
    const source = readFileSync(HALL_JS, "utf8");
    expect(source).toMatch(/^\/\/ @ts-check\n/);
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b|setAttribute\("style"|animateMotion|eval\(|new Function/);
    expect(source).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });
});

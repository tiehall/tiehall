// @ts-check

/*
 * The live hall's script (web-ui: The live hall; web-ui: The live hall's reads and its long-poll; web-ui: The live
 * hall with many teams and on a phone; web-ui: Motion, and reduced motion; web-ui: What the live hall shows of the
 * people and agents at work; agent-safety: The web UI renders no raw HTML and no remote images; design.md, Design:
 * The live hall; design.md, Design: Motion and reduced motion; D57 (6), (11), (12), (13)).
 *
 * One module of plain JavaScript, with no dependency and no build step, which the install serves at
 * /assets/hall.js and the live hall's page loads as its one script. It reads the hall's state from /hall/state and
 * then holds a long-poll on /hall/wait from the state's cursor, applying each answer and waiting again at once; a
 * failed wait is tried again after 1 second, then 2, 4, 8, 16 and 30, each with some random spread, and the live
 * lamp says Reconnecting; a 401 stops it, Signed out, with a link to sign in again; an answer that asks for it, or
 * names a team the page does not have, makes it read the state again. A hidden page holds no wait, and waits from
 * its cursor once it is shown. Relative times are kept current every 15 seconds from the answers' time, with no
 * read. On a screen at least 768 CSS pixels wide it draws the map: every team as a node on a ring around the map's
 * box, the 19 most active and one node for the others above 20; a line per ordered pair of teams with live requests
 * between them, curving through the ring's middle, two lines between the same teams curving apart; the people and
 * agents at work beside the target team's node, 12 at most; and a dot that travels along a line when an event
 * arrives on it, towards the team that did not act, 8 at most at once, each an SVG circle moved by setting its cx
 * and cy, never by SMIL and never through a style.
 *
 * It puts the class live on the page's body, under which the stylesheet runs the hall's repeating motion, and
 * shows Pause motion, which stops every animation, through the class paused, and the dots, and starts them again;
 * a browser that prefers reduced motion starts with it pressed, and the hall never starts a dot or a slide then.
 * Everything it writes into the page it builds as elements and sets as text: under the hall's Trusted Types policy
 * no write of markup could work, and every title, name, login and client name people and agents wrote stays text.
 *
 * Its pure parts are exported, so the tests run them in Node; it runs on the page only when the page loads it.
 */

/** @typedef {{ id: string, key: string }} TeamRef */
/** @typedef {{ open: number, claimed: number, in_progress: number, needs_info: number }} Counts */
/** @typedef {{ id: string, key: string, counts: Counts, doneLastDay: number, untrusted: { name: string } }} Team */
/** @typedef {{ from: TeamRef, to: TeamRef, counts: Counts }} Line */
/** @typedef {{ id: string, login: string, kind: "human", bot: boolean }} User */
/** @typedef {{ kind: "metadata_document" | "registered" | "cli" | "personal_access_token", host: string | null, version: string | null, unverified: boolean, untrusted: { name: string | null } }} Client */
/** @typedef {{ kind: "agent" | "web" | "tiehall" | "github" | "jira" | "operator", user: User | null, client: Client | null }} Actor */
/** @typedef {{ id: string, key: string, state: string, from: TeamRef, to: TeamRef, needsHuman: boolean, untrusted: { title: string } }} RequestRef */
/** @typedef {RequestRef & { claimant: User | null, changedAt: string, terminal?: boolean }} RequestLine */
/** @typedef {{ seq: number, at: string, type: string, line: string, actor: Actor, team: TeamRef | null, request: RequestRef }} HallEvent */
/** @typedef {{ actor: Actor, at: string, type: string, line: string, team: TeamRef | null, request: RequestRef, waiting: boolean, onMap: boolean }} AtWork */
/** @typedef {{ now: string, cursor: number, teams: Team[], lines: Line[], requestLines: RequestLine[], atWork: AtWork[], feed: HallEvent[] }} HallState */
/** @typedef {{ now: string, cursor: number, reload: boolean, events: HallEvent[], requestLines: RequestLine[], teams: Team[], lines: Line[], atWork: AtWork[] }} HallChange */
/** @typedef {{ width: number, height: number }} Size */
/** @typedef {{ x: number, y: number }} Point */

/** The states that are not terminal, in the order a request goes through them. */
export const LIVE_STATES = /** @type {const} */ (["open", "claimed", "in_progress", "needs_info"]);

/** @type {Readonly<Record<string, string>>} */
export const STATE_WORDS = { open: "Open", claimed: "Claimed", in_progress: "In progress", needs_info: "Needs info", done: "Done", declined: "Declined", withdrawn: "Withdrawn" };

/** How many entries the feed keeps, and how many requests the lists keep. */
export const FEED_SIZE = 50;
export const REQUEST_LINES = 200;
/** How many people and agents at work the map shows, and how many dots it moves at once. */
export const CHIPS = 12;
export const DOTS = 8;
/** How long a dot takes to travel its line. */
export const DOT_MS = 1_200;
/** How often relative times are kept current, with no read. */
export const TICK_MS = 15_000;
/** How long after its people or agents last wrote a team's node glows, and how long the dots of an agent at work pulse. */
export const ACTIVE_MS = 60_000;
/** How often the status region may speak. */
export const ANNOUNCE_MS = 10_000;

// ---------------------------------------------------------------------------------------------------------------
// Words, as the server says them (event-lines.ts, hall-page.ts).
// ---------------------------------------------------------------------------------------------------------------

/**
 * How long ago a moment was, from now, in a few words: "now", "40 s", "3 min", "2 h" or "5 d".
 * @param {string} at
 * @param {number} now The time, in milliseconds since the epoch.
 */
export function relativeTime(at, now) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** @param {Pick<User, "login" | "bot">} user */
export function userWords(user) {
  return user.bot ? `${user.login} (bot)` : user.login;
}

/**
 * Who caused an event, such as "mert's agent", "selin", "Tiehall" or "GitHub".
 * @param {Actor} actor
 */
export function actorWords(actor) {
  switch (actor.kind) {
    case "agent":
      return `${actor.user === null ? "someone" : userWords(actor.user)}'s agent`;
    case "web":
      return actor.user === null ? "someone in the web UI" : userWords(actor.user);
    case "tiehall":
      return "Tiehall";
    case "github":
      return "GitHub";
    case "jira":
      return "Jira";
    default:
      return "the operator";
  }
}

/**
 * A client's name, its own claim or Tiehall's words for it, and the mark Tiehall gives it, apart: the verified host
 * of a metadata document, "(unverified)" for a registered client, and none for the CLI or a personal access token.
 * The page isolates the name in a bdi and keeps the mark outside it, so no character of the name can reorder it.
 * @param {Client} client
 * @returns {{ name: string, mark: string | null }}
 */
export function clientParts(client) {
  const name = client.untrusted.name ?? "unnamed client";
  switch (client.kind) {
    case "metadata_document":
      return { name, mark: client.host === null ? null : `(${client.host})` };
    case "registered":
      return { name, mark: "(unverified)" };
    case "cli":
      return { name: client.version === null ? "tiehall CLI" : `tiehall CLI ${client.version}`, mark: null };
    default:
      return { name: "personal access token", mark: null };
  }
}

/**
 * The initials of a GitHub login: the first letters of its first two parts, or its first two letters.
 * @param {string} login
 */
export function initialsOf(login) {
  const parts = login.split(/[^A-Za-z]+/).filter((part) => part !== "");
  const initials = parts.length >= 2 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : (parts[0] ?? login).slice(0, 2);
  return initials.toUpperCase();
}

/**
 * Requests by live state in words, such as "3 open · 1 needs info · 2 done in 24 h", or "Nothing live".
 * @param {Counts} counts
 * @param {number} [doneLastDay]
 */
export function countsWords(counts, doneLastDay = 0) {
  const parts = LIVE_STATES.filter((state) => counts[state] > 0).map((state) => `${counts[state]} ${(STATE_WORDS[state] ?? state).toLowerCase()}`);
  if (doneLastDay > 0) parts.push(`${doneLastDay} done in 24 h`);
  return parts.length === 0 ? "Nothing live" : parts.join(" · ");
}

/** @param {Counts} counts */
export function liveTotal(counts) {
  return counts.open + counts.claimed + counts.in_progress + counts.needs_info;
}

/**
 * The state a line or a request is drawn in: the most pressing among its live requests, needs info, then in
 * progress, then claimed, then open.
 * @param {Counts} counts
 */
export function pressingState(counts) {
  if (counts.needs_info > 0) return "needs_info";
  if (counts.in_progress > 0) return "in_progress";
  if (counts.claimed > 0) return "claimed";
  return "open";
}

/**
 * Whether a team has a question waiting: one of the live requests addressed to it needs info. Its node and its row
 * then carry the class asking, which gives them a gold border and glow (D59 (2)).
 * @param {Counts} counts
 */
export function asking(counts) {
  return counts.needs_info > 0;
}

/**
 * The rows of the feed shown in the notice colors: of each request that waits on a question or a person, its newest
 * row only, so the request stands out once and the feed does not turn gold row after row (D59 (2)).
 * @param {Pick<HallEvent, "seq" | "request">[]} feed The feed, newest first.
 * @returns {Set<number>} The rows' event numbers.
 */
export function waitingRows(feed) {
  const seen = new Set();
  const rows = new Set();
  for (const { seq, request } of feed) {
    if (seen.has(request.id)) continue;
    seen.add(request.id);
    if (request.state === "needs_info" || request.needsHuman) rows.add(seq);
  }
  return rows;
}

/** @param {string} state */
export function stateClass(state) {
  return state.replace(/_/g, "-");
}

// ---------------------------------------------------------------------------------------------------------------
// Retries.
// ---------------------------------------------------------------------------------------------------------------

/** The delays after a failed wait: 1 second, then 2, 4, 8, 16 and 30. */
export const RETRY_SECONDS = [1, 2, 4, 8, 16, 30];

/**
 * How long to wait after this many failures in a row, in milliseconds: the delay of its step with up to 20 percent
 * of random spread, from 10 percent under it to 10 percent over, within 1 to 30 seconds.
 * @param {number} failures From 1.
 * @param {() => number} [random]
 */
export function retryDelay(failures, random = Math.random) {
  const step = RETRY_SECONDS[Math.min(Math.max(failures, 1), RETRY_SECONDS.length) - 1] ?? 30;
  const spread = step * 1000 * (0.9 + 0.2 * random());
  return Math.round(Math.min(30_000, Math.max(1_000, spread)));
}

// ---------------------------------------------------------------------------------------------------------------
// The state, and what a wait's answer changes in it.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Applies a wait's answer to the state: the new events at the top of the feed, each once, 50 at most; the requests
 * it names by id, a terminal one, which left the hall, dropped, and a reassigned one under its new key on its new
 * line; every team, the lines and the people and agents at work as the answer gives them; and the cursor. It asks
 * for a read of the state when the answer says so, or names a team the state does not have.
 * @param {HallState} state
 * @param {HallChange} change
 * @returns {{ state: HallState, reread: boolean, added: HallEvent[] }}
 */
export function mergeChange(state, change) {
  if (change.reload) return { state, reread: true, added: [] };
  const known = new Set(state.teams.map(({ id }) => id));
  const named = [
    ...change.teams.map(({ id }) => id),
    ...change.lines.flatMap(({ from, to }) => [from.id, to.id]),
    ...change.requestLines.flatMap(({ from, to }) => [from.id, to.id]),
    ...change.events.flatMap(({ request }) => [request.from.id, request.to.id]),
  ];
  const reread = named.some((id) => !known.has(id));
  const requests = new Map(state.requestLines.map((request) => [request.id, request]));
  /** @type {Map<string, RequestRef>} */
  const current = new Map();
  for (const request of change.requestLines) {
    const { terminal, ...line } = request;
    current.set(request.id, line);
    if (terminal === true) requests.delete(request.id);
    else requests.set(request.id, line);
  }
  const requestLines = [...requests.values()].sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt) || (a.id < b.id ? -1 : 1)).slice(0, REQUEST_LINES);
  const seen = new Set(state.feed.map(({ seq }) => seq));
  const added = change.events.filter(({ seq }) => !seen.has(seq));
  /** @param {HallEvent} event */
  const refreshed = (event) => {
    const now = current.get(event.request.id);
    if (now === undefined) return event;
    const { id, key, state: requestState, from, to, needsHuman, untrusted } = now;
    return { ...event, request: { id, key, state: requestState, from, to, needsHuman, untrusted } };
  };
  const feed = [...[...added].reverse(), ...state.feed]
    .map(refreshed)
    .sort((a, b) => b.seq - a.seq)
    .slice(0, FEED_SIZE);
  return {
    state: { now: change.now, cursor: Math.max(state.cursor, change.cursor), teams: change.teams, lines: change.lines, requestLines, atWork: change.atWork, feed },
    reread,
    added,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The map: the ring of team nodes, the lines between them, and where the people and agents at work sit.
// ---------------------------------------------------------------------------------------------------------------

/** A large node, with the team's name, key, lamps and counts in words, for up to 8 teams; its height leaves room for the counts on two lines. */
export const LARGE_NODE = { width: 220, height: 92 };
/** A compact node, with the team's key, lamps and counts, for 9 to 20 teams. */
export const COMPACT_NODE = { width: 124, height: 52 };
/** The space kept between nodes, and between a node and the map's edge. */
export const NODE_GAP = 8;
export const MAP_MARGIN = 12;
/** How many nodes the map draws at most: above that, the 19 most active teams and one node for the others. */
export const MAP_NODES = 20;

/**
 * @param {number} count
 * @returns {Size}
 */
export function nodeSize(count) {
  return count <= 8 ? LARGE_NODE : COMPACT_NODE;
}

/**
 * The nodes the map draws: every team, in the order of their keys, up to 20; above that, the 19 with the most live
 * requests, ties by key, the team the hall is narrowed to and the teams on its lines first, and one node that counts
 * the others' live requests. Each team's node, by its id.
 * @param {Team[]} teams
 * @param {Line[]} lines
 * @param {string | undefined} narrowedTo The id of the team the hall is narrowed to.
 * @returns {{ nodes: { id: string, key: string, name: string, counts: Counts, doneLastDay: number, others: number }[], nodeOf: Map<string, string> }}
 */
export function mapNodes(teams, lines, narrowedTo) {
  const byKey = [...teams].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  /** @type {Map<string, string>} */
  const nodeOf = new Map();
  /** @param {Team} team */
  const nodeFor = (team) => ({ id: team.id, key: team.key, name: team.untrusted.name, counts: team.counts, doneLastDay: team.doneLastDay, others: 0 });
  if (byKey.length <= MAP_NODES) {
    for (const team of byKey) nodeOf.set(team.id, team.id);
    return { nodes: byKey.map(nodeFor), nodeOf };
  }
  const involved = new Set(narrowedTo === undefined ? [] : [narrowedTo, ...lines.flatMap(({ from, to }) => [from.id, to.id])]);
  const ranked = [...byKey].sort(
    (a, b) => Number(involved.has(b.id)) - Number(involved.has(a.id)) || liveTotal(b.counts) - liveTotal(a.counts) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const shown = new Set(ranked.slice(0, MAP_NODES - 1).map(({ id }) => id));
  const rest = byKey.filter(({ id }) => !shown.has(id));
  /** @type {Counts} */
  const counts = { open: 0, claimed: 0, in_progress: 0, needs_info: 0 };
  let done = 0;
  for (const team of rest) {
    for (const state of LIVE_STATES) counts[state] += team.counts[state];
    done += team.doneLastDay;
  }
  const others = { id: "others", key: `+${rest.length}`, name: `+${rest.length} teams`, counts, doneLastDay: done, others: rest.length };
  for (const team of byKey) nodeOf.set(team.id, shown.has(team.id) ? team.id : "others");
  return { nodes: [...byKey.filter(({ id }) => shown.has(id)).map(nodeFor), others], nodeOf };
}

/**
 * Whether two nodes of this size, by their middles, overlap, with the space between nodes kept.
 * @param {Point} a
 * @param {Point} b
 * @param {Size} size
 */
export function overlap(a, b, size) {
  return Math.abs(a.x - b.x) < size.width + NODE_GAP && Math.abs(a.y - b.y) < size.height + NODE_GAP;
}

/**
 * Points along a ring around the box's middle, a rounded rectangle whose roundness `power` sets (2 is an ellipse),
 * from the top, clockwise.
 * @param {number} rx
 * @param {number} ry
 * @param {number} power
 * @returns {Point[]}
 */
function ringPoints(rx, ry, power) {
  const samples = 1440;
  /** @type {Point[]} */
  const points = [];
  for (let index = 0; index < samples; index += 1) {
    const angle = -Math.PI / 2 + (index / samples) * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    points.push({ x: rx * Math.sign(cos) * Math.abs(cos) ** (2 / power), y: ry * Math.sign(sin) * Math.abs(sin) ** (2 / power) });
  }
  return points;
}

/**
 * How far apart two nodes' middles are, in the room a node needs: across it in width or along it in height,
 * whichever is more. At 1 or more, the two do not overlap.
 * @param {Point} a
 * @param {Point} b
 * @param {Size} room
 */
function apart(a, b, room) {
  return Math.max(Math.abs(a.x - b.x) / room.width, Math.abs(a.y - b.y) / room.height);
}

/**
 * `count` points along the ring from its top, each the first that lies `spacing` or more from the one before, the last
 * as far from the first; undefined when they do not fit.
 * @param {Point[]} points
 * @param {number} spacing
 * @param {number} count
 * @param {Size} room
 * @returns {Point[] | undefined}
 */
function placeAlong(points, spacing, count, room) {
  const first = points[0];
  if (first === undefined) return undefined;
  const placed = [first];
  let index = 0;
  for (let node = 1; node < count; node += 1) {
    const last = /** @type {Point} */ (placed.at(-1));
    do {
      index += 1;
      if (index >= points.length) return undefined;
    } while (apart(/** @type {Point} */ (points[index]), last, room) < spacing);
    placed.push(/** @type {Point} */ (points[index]));
  }
  return apart(/** @type {Point} */ (placed.at(-1)), first, room) >= spacing ? placed : undefined;
}

/**
 * Where each of `count` nodes sits, by its middle, in the order of their keys from the top, clockwise: on a ring
 * around the map's box, a rounded rectangle as large as the box allows, spaced as evenly and as widely as it holds
 * them, so that no two nodes overlap whenever the box has room for them. The spacing counts the room a node needs
 * across and along it, so wide nodes spread along the top and bottom and low ones stack at the sides.
 * @param {number} count
 * @param {Size} box
 * @returns {{ size: Size, centers: Point[] }}
 */
export function ringLayout(count, box) {
  const size = nodeSize(count);
  const middle = { x: box.width / 2, y: box.height / 2 };
  if (count === 0) return { size, centers: [] };
  if (count === 1) return { size, centers: [middle] };
  const room = { width: size.width + NODE_GAP, height: size.height + NODE_GAP };
  const rx = Math.max(0, box.width / 2 - size.width / 2 - MAP_MARGIN);
  const ry = Math.max(0, box.height / 2 - size.height / 2 - MAP_MARGIN);
  /** @type {{ spacing: number, centers: Point[] } | undefined} */
  let best;
  for (const power of [2.6, 3.2, 4, 6, 10]) {
    const points = ringPoints(rx, ry, power);
    let placed = placeAlong(points, 1, count, room);
    if (placed === undefined) continue;
    let low = 1;
    let high = 4;
    for (let step = 0; step < 24; step += 1) {
      const spacing = (low + high) / 2;
      const tried = placeAlong(points, spacing, count, room);
      if (tried === undefined) high = spacing;
      else {
        low = spacing;
        placed = tried;
      }
    }
    if (best === undefined || low > best.spacing) best = { spacing: low, centers: placed };
  }
  // A box too small for the nodes to keep apart gets them evenly spaced on its largest ellipse.
  const centers = best?.centers ?? ringPoints(rx, ry, 2).filter((_, index) => index % Math.max(1, Math.floor(1440 / count)) === 0).slice(0, count);
  return { size, centers: centers.map(({ x, y }) => ({ x: middle.x + x, y: middle.y + y })) };
}

/**
 * The path of a line from one node's middle to another's: a curve through the ring's middle, pulled towards it, and
 * bent to the left of its direction when the other way runs a line too, so the two curve apart.
 * @param {Point} from
 * @param {Point} to
 * @param {Point} middle
 * @param {boolean} both Whether a line runs the other way between the same teams.
 */
export function cordPath(from, to, middle, both) {
  return `M ${round(from.x)} ${round(from.y)} Q ${round(cordControl(from, to, middle, both).x)} ${round(cordControl(from, to, middle, both).y)} ${round(to.x)} ${round(to.y)}`;
}

/**
 * The control point of a line's curve.
 * @param {Point} from
 * @param {Point} to
 * @param {Point} middle
 * @param {boolean} both
 */
export function cordControl(from, to, middle, both) {
  const half = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const pulled = { x: half.x + (middle.x - half.x) * 0.55, y: half.y + (middle.y - half.y) * 0.55 };
  if (!both) return pulled;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  // The left of the direction from `from` to `to`: the other way's left is this one's right.
  const bend = Math.min(48, length * 0.18);
  return { x: pulled.x + (dy / length) * bend, y: pulled.y - (dx / length) * bend };
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 10) / 10;
}

/**
 * A line's width: 2 pixels for one request, a pixel more for each further one, 6 at most.
 * @param {Counts} counts
 */
export function cordWidth(counts) {
  return Math.min(6, 1 + liveTotal(counts));
}

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** How wide a chip of a person or an agent at work may be. */
export const CHIP_WIDTH = 240;
/** The space a chip keeps from the nodes and the other chips. */
export const CHIP_GAP = 6;

/** @param {Rect} a @param {Rect} b */
function intersects(a, b) {
  return a.x < b.x + b.width + CHIP_GAP && b.x < a.x + a.width + CHIP_GAP && a.y < b.y + b.height + CHIP_GAP && b.y < a.y + a.height + CHIP_GAP;
}

/**
 * Where a chip of this size sits beside its node: towards the ring's middle from the node's edge, to either side
 * of that, beside the node along the ring, or up to two chips further in, the first place inside the box that covers
 * nothing taken; undefined when there is none.
 * @param {Size} chip
 * @param {{ center: Point, size: Size }} node
 * @param {Point} middle
 * @param {Size} box
 * @param {Rect[]} taken
 * @returns {Rect | undefined}
 */
export function placeChip(chip, node, middle, box, taken) {
  const dx = middle.x - node.center.x;
  const dy = middle.y - node.center.y;
  const length = Math.hypot(dx, dy);
  const inward = length < 1 ? { x: 0, y: 1 } : { x: dx / length, y: dy / length };
  const across = { x: -inward.y, y: inward.x };
  /** How far a box of this size reaches from its middle along a direction. @param {Size} size @param {Point} direction */
  const reachOf = (size, direction) =>
    Math.min(Math.abs(direction.x) < 1e-6 ? Infinity : size.width / 2 / Math.abs(direction.x), Math.abs(direction.y) < 1e-6 ? Infinity : size.height / 2 / Math.abs(direction.y));
  const edge = reachOf(node.size, inward) + reachOf(chip, inward) + CHIP_GAP;
  const beside = reachOf(node.size, across) + reachOf(chip, across) + CHIP_GAP;
  /** @type {[number, number][]} The places to try, as how far in and how far across from the node's middle. */
  const tries = [
    [edge, 0],
    [edge, chip.width / 2 + CHIP_GAP],
    [edge, -(chip.width / 2 + CHIP_GAP)],
    [0, beside],
    [0, -beside],
    [edge, chip.width + 2 * CHIP_GAP],
    [edge, -(chip.width + 2 * CHIP_GAP)],
    ...[1, 2].flatMap((step) => [0, 1, -1].map((side) => /** @type {[number, number]} */ ([edge + step * (chip.height + CHIP_GAP), side * (chip.width / 2 + CHIP_GAP)]))),
  ];
  for (const [along, sideways] of tries) {
    const x = node.center.x + inward.x * along + across.x * sideways - chip.width / 2;
    const y = node.center.y + inward.y * along + across.y * sideways - chip.height / 2;
    const spot = { x, y, width: chip.width, height: chip.height };
    if (x < 0 || y < 0 || x + chip.width > box.width || y + chip.height > box.height) continue;
    if (!taken.some((other) => intersects(spot, other))) return spot;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";

/**
 * An element with these classes and this text, or these children.
 * @param {string} tag
 * @param {string} [classes]
 * @param {string | (Node | string)[]} [content]
 */
function element(tag, classes, content) {
  const made = document.createElement(tag);
  if (classes !== undefined && classes !== "") made.className = classes;
  if (typeof content === "string") made.textContent = content;
  else if (content !== undefined) made.append(...content);
  return made;
}

/**
 * An SVG element with these attributes.
 * @param {string} tag
 * @param {Record<string, string | number>} [attributes]
 */
function svg(tag, attributes = {}) {
  const made = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, String(value));
  return made;
}

/**
 * A client: its name in a bdi, then its mark, apart.
 * @param {Client} client
 * @returns {(Node | string)[]}
 */
function clientNodes(client) {
  const { name, mark } = clientParts(client);
  /** @type {(Node | string)[]} */
  const nodes = [element("bdi", "client-name", name)];
  if (mark !== null) nodes.push(" ", element("span", "client-mark", mark));
  return nodes;
}

/**
 * Who acted: an agent with its client, a person in the web UI, or Tiehall, GitHub, Jira or the operator.
 * @param {Actor} actor
 * @returns {(Node | string)[]}
 */
function whoNodes(actor) {
  if (actor.kind === "agent") return actor.client === null ? [actorWords(actor)] : [`${actorWords(actor)} · `, ...clientNodes(actor.client)];
  if (actor.kind === "web") return [`${actorWords(actor)} in the web UI`];
  return [actorWords(actor)];
}

/** @param {string} state */
function lamp(state) {
  const made = element("span", `lamp ${stateClass(state)}`);
  made.setAttribute("aria-hidden", "true");
  return made;
}

/** @param {string} key @param {string} [href] */
function keyTag(key, href) {
  const made = element(href === undefined ? "span" : "a", "key", key);
  if (href !== undefined) made.setAttribute("href", href);
  return made;
}

/** @param {string} at @param {number} now */
function timeOf(at, now) {
  const made = element("time", undefined, relativeTime(at, now));
  made.setAttribute("datetime", at);
  return made;
}

function typingDots() {
  const made = element("span", "typing", [element("span"), element("span"), element("span")]);
  made.setAttribute("aria-hidden", "true");
  return made;
}

/** Runs the hall on its page. */
function start() {
  const body = document.body;
  const lampState = /** @type {HTMLElement} */ (document.getElementById("live-state"));
  const lampWords = /** @type {HTMLElement} */ (document.getElementById("live-words"));
  const pause = /** @type {HTMLButtonElement} */ (document.getElementById("pause-motion"));
  const atWorkList = /** @type {HTMLElement} */ (document.getElementById("at-work"));
  const atWorkEmpty = /** @type {HTMLElement} */ (document.getElementById("at-work-empty"));
  const feedList = /** @type {HTMLElement} */ (document.getElementById("feed"));
  const feedEmpty = /** @type {HTMLElement} */ (document.getElementById("feed-empty"));
  const teamList = /** @type {HTMLElement} */ (document.getElementById("team-list"));
  const lineRows = /** @type {HTMLElement} */ (document.getElementById("hall-lines"));
  const linesEmpty = /** @type {HTMLElement} */ (document.getElementById("lines-empty"));
  const requestRows = /** @type {HTMLElement} */ (document.getElementById("hall-requests"));
  const news = /** @type {HTMLElement} */ (document.getElementById("hall-news"));
  const map = /** @type {HTMLElement} */ (document.getElementById("hall-map"));
  const query = new URLSearchParams(location.search);
  const narrowing = new URLSearchParams();
  const team = query.get("team");
  if (team !== null && team !== "") narrowing.set("team", team);
  if (query.get("agents") === "1") narrowing.set("agents", "1");
  const wide = matchMedia("(min-width: 768px)");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  /** @type {HallState | undefined} */
  let state;
  /** The difference between the server's clock and the browser's. */
  let offset = 0;
  let failures = 0;
  let stopped = false;
  let paused = reduced.matches;
  /** @type {AbortController | undefined} */
  let waiting;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retry;
  /** @type {{ circle: SVGCircleElement, path: SVGPathElement, length: number, reverse: boolean, started: number }[]} */
  let dots = [];
  let frame = 0;
  let unspoken = 0;
  let spokeAt = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let speech;
  /** The map's paths by the pair of nodes they join, for the dots. */
  /** @type {Map<string, SVGPathElement>} */
  let cords = new Map();
  /** @type {Map<string, string>} */
  let nodeOf = new Map();

  const now = () => Date.now() + offset;

  /**
   * @param {"live" | "connecting" | "reconnecting" | "off"} kind
   * @param {string} words
   * @param {{ href: string, text: string }} [link]
   */
  function say(kind, words, link) {
    lampState.classList.remove("live", "connecting", "reconnecting", "off");
    lampState.classList.add(kind);
    lampWords.textContent = words;
    lampState.querySelector("a")?.remove();
    if (link !== undefined) {
      const anchor = element("a", undefined, link.text);
      anchor.setAttribute("href", link.href);
      lampState.append(" ", anchor);
    }
  }

  /** @param {boolean} on */
  function setPaused(on) {
    paused = on;
    pause.setAttribute("aria-pressed", String(on));
    body.classList.toggle("paused", on);
    if (on) {
      for (const dot of dots) dot.circle.remove();
      dots = [];
      cancelAnimationFrame(frame);
      for (const row of feedList.querySelectorAll(".new")) row.classList.remove("new");
    }
  }

  /** @param {number} count */
  function announce(count) {
    unspoken += count;
    if (unspoken === 0 || speech !== undefined) return;
    const wait = Math.max(0, spokeAt + ANNOUNCE_MS - Date.now());
    speech = setTimeout(() => {
      speech = undefined;
      spokeAt = Date.now();
      news.textContent = unspoken === 1 ? "1 new event on the line" : `${unspoken} new events on the line`;
      unspoken = 0;
    }, wait);
  }

  // ---- The lists, from the state ----

  /** @param {AtWork} entry */
  function worker(entry) {
    const agent = entry.actor.kind === "agent";
    const waitingOn = agent && entry.waiting;
    const initials = element("span", "initials", initialsOf(entry.actor.user?.login ?? ""));
    initials.setAttribute("aria-hidden", "true");
    const did = element("p", "worker-did", [`${entry.line} · `, timeOf(entry.at, now())]);
    if (agent && !waitingOn && now() - Date.parse(entry.at) < ACTIVE_MS) did.append(" ", typingDots());
    return element("li", `worker ${agent ? "agent" : "web"}${waitingOn ? " waiting" : ""}`, [
      initials,
      element("div", "worker-text", [
        element("p", "worker-who", whoNodes(entry.actor)),
        element("p", "worker-on", [element("span", "mono", entry.request.key), " ", element("bdi", undefined, entry.request.untrusted.title)]),
        did,
      ]),
    ]);
  }

  /** @param {HallEvent} event @param {boolean} fresh @param {boolean} waits Whether it is the newest row of a request that waits. */
  function feedRow(event, fresh, waits) {
    return element("li", `feed-row${waits ? " waits" : ""}${fresh && !paused ? " new" : ""}`, [
      element("p", "feed-meta", [keyTag(event.request.key, `/${event.request.key}`), " ", element("bdi", "feed-title", event.request.untrusted.title), " ", timeOf(event.at, now())]),
      element("p", "feed-line", event.line),
      element("p", "feed-who", whoNodes(event.actor)),
    ]);
  }

  /** @param {Counts} counts @param {number} done */
  function lamps(counts, done) {
    return [...LIVE_STATES.filter((each) => counts[each] > 0), ...(done > 0 ? ["done"] : [])].map(lamp);
  }

  /** @param {Team} each */
  function teamRow(each) {
    const live = liveTotal(each.counts) > 0;
    return element("li", `team-row${live ? "" : " dimmed"}${asking(each.counts) ? " asking" : ""}`, [
      element("p", "team-head", [element("bdi", "team-name", each.untrusted.name), " ", element("span", "team-key", each.key)]),
      element("p", "team-counts", [...lamps(each.counts, each.doneLastDay), element("span", undefined, countsWords(each.counts, each.doneLastDay))]),
    ]);
  }

  /** @param {Line} line */
  function lineRow(line) {
    return element("tr", undefined, [
      element("td", undefined, [keyTag(line.from.key)]),
      element("td", undefined, [keyTag(line.to.key)]),
      element("td", undefined, [element("span", "line-counts", [...lamps(line.counts, 0), element("span", undefined, countsWords(line.counts))])]),
    ]);
  }

  /** @param {RequestLine} request */
  function requestRow(request) {
    const cell = (/** @type {string} */ label, /** @type {(Node | string)[]} */ content, /** @type {string} */ classes = "") => {
      const made = element("td", classes, content);
      if (label !== "") made.setAttribute("data-label", label);
      return made;
    };
    const claimant = request.claimant === null ? "nobody" : request.claimant.bot ? `${request.claimant.login} (bot)` : request.claimant.login;
    /** @type {(Node | string)[]} */
    const chips = [element("span", `chip ${stateClass(request.state)}`, STATE_WORDS[request.state] ?? request.state)];
    if (request.needsHuman) chips.push(" ", element("span", "chip waits", "Waits for a person"));
    return element("tr", undefined, [
      cell("", [keyTag(request.key, `/${request.key}`)], "cell-key"),
      cell("Title", [request.untrusted.title], "cell-title"),
      cell("State", chips, "cell-state"),
      cell("Line", [keyTag(request.from.key), " to ", keyTag(request.to.key)]),
      cell("Claimed by", [claimant]),
      cell("Changed", [timeOf(request.changedAt, now())]),
    ]);
  }

  /** @param {Set<number>} fresh The events new since the last answer. */
  function renderLists(fresh) {
    if (state === undefined) return;
    atWorkList.replaceChildren(...state.atWork.map(worker));
    atWorkEmpty.hidden = state.atWork.length > 0;
    const waiting = waitingRows(state.feed);
    feedList.replaceChildren(...state.feed.map((event) => feedRow(event, fresh.has(event.seq), waiting.has(event.seq))));
    feedEmpty.hidden = state.feed.length > 0;
    teamList.replaceChildren(...state.teams.map(teamRow));
    lineRows.replaceChildren(...state.lines.map(lineRow));
    linesEmpty.hidden = state.lines.length > 0;
    requestRows.replaceChildren(...state.requestLines.map(requestRow));
  }

  /** Keeps the relative times current, from the latest answer's time. */
  function refreshTimes() {
    for (const time of document.querySelectorAll("main time[datetime]")) {
      const at = time.getAttribute("datetime");
      if (at !== null) time.textContent = relativeTime(at, now());
    }
  }

  // ---- The map ----

  /**
   * Draws the map, on a screen at least 768 CSS pixels wide, in the place the stylesheet lays out for it from the
   * page's first frame in a browser that runs scripts, so drawing it moves nothing on the page.
   */
  function renderMap() {
    if (state === undefined) return;
    if (!wide.matches) {
      map.hidden = true;
      map.replaceChildren();
      cords = new Map();
      return;
    }
    map.hidden = false;
    let canvas = map.querySelector("svg");
    if (canvas === null) {
      canvas = /** @type {SVGSVGElement} */ (svg("svg", { class: "map", focusable: "false" }));
      map.append(canvas, legend());
    }
    const box = { width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight) };
    canvas.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    const narrowedTeam = narrowing.get("team");
    const narrowedTo = state.teams.find(({ key }) => key === narrowedTeam)?.id;
    const shown = mapNodes(state.teams, state.lines, narrowedTo);
    nodeOf = shown.nodeOf;
    const { size, centers } = ringLayout(shown.nodes.length, box);
    /** @type {Map<string, Point>} */
    const placeOf = new Map(shown.nodes.map((node, index) => [node.id, centers[index] ?? { x: 0, y: 0 }]));
    const middle = { x: box.width / 2, y: box.height / 2 };
    const compact = shown.nodes.length > 8;
    const activeTeams = new Set(state.atWork.filter(({ at }) => now() - Date.parse(at) < ACTIVE_MS).map(({ team }) => team?.id ?? ""));

    // The lines, one per ordered pair of nodes, their counts summed for the teams the others node holds.
    /** @type {Map<string, { from: string, to: string, counts: Counts }>} */
    const pairs = new Map();
    for (const line of state.lines) {
      const from = nodeOf.get(line.from.id);
      const to = nodeOf.get(line.to.id);
      if (from === undefined || to === undefined || from === to) continue;
      const pair = pairs.get(`${from}>${to}`) ?? { from, to, counts: { open: 0, claimed: 0, in_progress: 0, needs_info: 0 } };
      for (const each of LIVE_STATES) pair.counts[each] += line.counts[each];
      pairs.set(`${from}>${to}`, pair);
    }
    const cordGroup = svg("g", { class: "cords" });
    cords = new Map();
    for (const [name, pair] of pairs) {
      const from = placeOf.get(pair.from);
      const to = placeOf.get(pair.to);
      if (from === undefined || to === undefined) continue;
      const path = /** @type {SVGPathElement} */ (
        svg("path", { d: cordPath(from, to, middle, pairs.has(`${pair.to}>${pair.from}`)), "stroke-width": cordWidth(pair.counts) })
      );
      path.setAttribute("class", `cord ${stateClass(pressingState(pair.counts))}${pair.counts.in_progress > 0 ? " flow" : ""}`);
      cordGroup.append(path);
      cords.set(name, path);
    }

    const nodeGroup = svg("g", { class: "nodes" });
    for (const node of shown.nodes) {
      const place = placeOf.get(node.id) ?? middle;
      const holder = svg("foreignObject", { x: round(place.x - size.width / 2), y: round(place.y - size.height / 2), width: size.width, height: size.height });
      const live = liveTotal(node.counts) > 0;
      const classes = [
        "node",
        ...(compact ? ["compact"] : []),
        ...(node.others > 0 ? ["others"] : []),
        ...(live ? [] : ["dimmed"]),
        ...(asking(node.counts) ? ["asking"] : []),
        ...(activeTeams.has(node.id) && !paused ? ["active"] : []),
      ];
      const counts = compact
        ? [...LIVE_STATES.filter((each) => node.counts[each] > 0).flatMap((each) => [lamp(each), element("span", "node-count", String(node.counts[each]))]), ...(live ? [] : [element("span", undefined, "–")])]
        : [...lamps(node.counts, node.doneLastDay), element("span", undefined, countsWords(node.counts, node.doneLastDay))];
      const head = compact
        ? [element("span", node.others > 0 ? "team-name" : "team-key", node.others > 0 ? node.name : node.key)]
        : [element("bdi", "team-name", node.name), " ", element("span", "team-key", node.key)];
      holder.append(element("div", classes.join(" "), [element("p", "node-head", head), element("p", "node-counts", counts)]));
      nodeGroup.append(holder);
    }

    // The people and agents at work, beside the target team's node of their request, towards the ring's middle,
    // each where it covers no node and no other chip, an agent that waits on its own question first and then the
    // most recent; one that finds no such place stays in the list alone.
    const chipGroup = svg("g", { class: "chips" });
    /** @type {{ holder: Element, chip: HTMLElement, target: Point }[]} */
    const chips = [];
    const onMap = state.atWork.filter(({ onMap }) => onMap).slice(0, CHIPS);
    for (const entry of [...onMap.filter(({ waiting }) => waiting), ...onMap.filter(({ waiting }) => !waiting)]) {
      const target = nodeOf.get(entry.request.to.id);
      const place = target === undefined ? undefined : placeOf.get(target);
      if (place === undefined) continue;
      const holder = svg("foreignObject", { x: 0, y: 0, width: CHIP_WIDTH, height: 80 });
      const agent = entry.actor.kind === "agent";
      const waitingOn = agent && entry.waiting;
      const initials = element("span", "initials", initialsOf(entry.actor.user?.login ?? ""));
      const did = element("span", "chip-did", entry.line);
      if (agent && !waitingOn && now() - Date.parse(entry.at) < ACTIVE_MS) did.append(" ", typingDots());
      const client = agent && entry.actor.client !== null ? clientNodes(entry.actor.client) : ["web"];
      const chip = element("div", `map-chip ${agent ? "agent" : "web"}${waitingOn ? " waiting" : ""}`, [
        initials,
        element("span", "chip-text", [element("span", "chip-what", [element("span", "mono", entry.request.key), " · ", ...client]), did]),
      ]);
      holder.append(chip);
      chipGroup.append(holder);
      chips.push({ holder, chip, target: place });
    }

    const dotGroup = svg("g", { class: "dots" });
    for (const dot of dots) dot.circle.remove();
    dots = [];
    canvas.replaceChildren(cordGroup, dotGroup, nodeGroup, chipGroup);
    /** @type {Rect[]} */
    const taken = shown.nodes.map((node) => {
      const place = placeOf.get(node.id) ?? middle;
      return { x: place.x - size.width / 2, y: place.y - size.height / 2, width: size.width, height: size.height };
    });
    for (const { holder, chip, target } of chips) {
      const chipSize = { width: Math.ceil(chip.offsetWidth) + 1, height: Math.ceil(chip.offsetHeight) + 1 };
      const spot = placeChip(chipSize, { center: target, size }, middle, box, taken);
      if (spot === undefined) {
        holder.remove();
        continue;
      }
      taken.push(spot);
      for (const [name, value] of Object.entries(spot)) holder.setAttribute(name, String(round(value)));
    }
  }

  /** The legend, which names each lamp color. */
  function legend() {
    const list = element("ul", "legend");
    /** @type {[string, string][]} */
    const named = [
      ["open", "open, unclaimed"],
      ["claimed", "claimed"],
      ["in_progress", "in progress"],
      ["needs_info", "needs info"],
      ["done", "done today"],
    ];
    for (const [state, words] of named) list.append(element("li", undefined, [lamp(state), words]));
    return list;
  }

  /** Sends a dot along the line of each new event's request, towards the team that did not act, 8 at most at once. @param {HallEvent[]} events */
  function sendDots(events) {
    if (paused || reduced.matches || document.visibilityState === "hidden" || map.hidden) return;
    for (const event of events) {
      if (dots.length >= DOTS) break;
      const from = nodeOf.get(event.request.from.id);
      const to = nodeOf.get(event.request.to.id);
      const path = cords.get(`${from}>${to}`);
      const group = map.querySelector("g.dots");
      if (path === undefined || group === null) continue;
      const circle = /** @type {SVGCircleElement} */ (svg("circle", { r: 5 }));
      circle.setAttribute("class", `dot ${stateClass(event.request.state)}`);
      const length = path.getTotalLength();
      const start = path.getPointAtLength(0);
      circle.setAttribute("cx", String(round(start.x)));
      circle.setAttribute("cy", String(round(start.y)));
      group.append(circle);
      // Towards the team that did not act: back to the requesting team when the target team acted.
      dots.push({ circle, path, length, reverse: event.team !== null && event.team.id === event.request.to.id, started: performance.now() });
    }
    if (dots.length > 0) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(moveDots);
    }
  }

  /** @param {number} time */
  function moveDots(time) {
    dots = dots.filter((dot) => {
      const progress = (time - dot.started) / DOT_MS;
      if (progress >= 1 || !dot.circle.isConnected) {
        dot.circle.remove();
        return false;
      }
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      const point = dot.path.getPointAtLength(dot.length * (dot.reverse ? 1 - eased : eased));
      dot.circle.setAttribute("cx", String(round(point.x)));
      dot.circle.setAttribute("cy", String(round(point.y)));
      return true;
    });
    if (dots.length > 0 && !paused) frame = requestAnimationFrame(moveDots);
  }

  // ---- Reading and waiting ----

  /** @param {Response} response */
  async function refusalTitle(response) {
    try {
      const problem = /** @type {{ title?: unknown }} */ (await response.json());
      return typeof problem.title === "string" ? problem.title : "Refused";
    } catch {
      return "Refused";
    }
  }

  function signedOut() {
    stop();
    say("off", "Signed out", { href: "/sign-in?return=%2Fhall", text: "Sign in again" });
  }

  function stop() {
    stopped = true;
    waiting?.abort();
    clearTimeout(retry);
  }

  /** @param {string} path */
  function urlOf(path) {
    const search = narrowing.toString();
    return search === "" ? path : `${path}${path.includes("?") ? "&" : "?"}${search}`;
  }

  /** Reads the state and draws it; false when the page stopped. */
  async function readState() {
    const response = await fetch(urlOf("/hall/state"), { headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" });
    if (response.status === 401) {
      signedOut();
      return false;
    }
    if (response.status === 403) {
      stop();
      say("off", await refusalTitle(response));
      return false;
    }
    if (!response.ok) throw new Error(`the state answered ${response.status}`);
    const read = /** @type {HallState} */ (await response.json());
    offset = Date.parse(read.now) - Date.now();
    const known = new Set(state?.feed.map(({ seq }) => seq) ?? read.feed.map(({ seq }) => seq));
    const fresh = state === undefined ? new Set() : new Set(read.feed.filter(({ seq }) => !known.has(seq)).map(({ seq }) => seq));
    state = read;
    renderLists(fresh);
    renderMap();
    return true;
  }

  /** Waits from the cursor, applies the answer and waits again; a failure is tried again after its delay. */
  async function waitOnce() {
    if (stopped || state === undefined || document.visibilityState === "hidden" || waiting !== undefined) return;
    const controller = new AbortController();
    waiting = controller;
    try {
      const response = await fetch(urlOf(`/hall/wait?after=${state.cursor}`), {
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (response.status === 401) {
        signedOut();
        return;
      }
      if (response.status === 403) {
        stop();
        say("off", await refusalTitle(response));
        return;
      }
      if (!response.ok) throw new Error(`the wait answered ${response.status}`);
      const change = /** @type {HallChange} */ (await response.json());
      failures = 0;
      say("live", "Live");
      offset = Date.parse(change.now) - Date.now();
      const merged = mergeChange(state, change);
      if (merged.reread) {
        waiting = undefined;
        if (!(await readState())) return;
      } else {
        state = merged.state;
        renderLists(new Set(merged.added.map(({ seq }) => seq)));
        renderMap();
        sendDots(merged.added);
      }
      announce(merged.reread ? 0 : merged.added.length);
      waiting = undefined;
      void waitOnce();
    } catch (error) {
      waiting = undefined;
      // A wait the page aborted, because it was hidden or it stopped, is no failure.
      if (controller.signal.aborted) return;
      failed(error);
    }
  }

  /** @param {unknown} _error */
  function failed(_error) {
    if (stopped) return;
    failures += 1;
    say("reconnecting", "Reconnecting");
    clearTimeout(retry);
    retry = setTimeout(recover, retryDelay(failures));
  }

  /** Reads the state again once the install answers, then waits. */
  async function recover() {
    if (stopped) return;
    if (document.visibilityState === "hidden") return;
    try {
      if (!(await readState())) return;
      failures = 0;
      say("live", "Live");
      void waitOnce();
    } catch (error) {
      failed(error);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      waiting?.abort();
      waiting = undefined;
      clearTimeout(retry);
      for (const dot of dots) dot.circle.remove();
      dots = [];
    } else if (!stopped) {
      if (state === undefined || failures > 0) void recover();
      else void waitOnce();
    }
  });

  pause.addEventListener("click", () => {
    setPaused(!paused);
    if (!paused) renderMap();
  });
  reduced.addEventListener("change", () => setPaused(reduced.matches || paused));
  let resizing = 0;
  const redraw = () => {
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(() => renderMap());
  };
  wide.addEventListener("change", redraw);
  addEventListener("resize", redraw);
  setInterval(() => {
    refreshTimes();
    if (state !== undefined && !map.hidden) renderMap();
  }, TICK_MS);

  body.classList.add("live");
  pause.hidden = false;
  setPaused(paused);
  say("connecting", "Connecting");
  void recover();
}

if (typeof document !== "undefined" && document.body?.classList.contains("hall") === true && document.getElementById("live-state") !== null) start();

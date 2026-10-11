import { readHallState } from "@tiehall/catalog";
import type { RequestState } from "@tiehall/core";
import type { z } from "zod";
import { actorWords, clientWords, relativeTime, STATE_WORDS, type EventActor } from "./event-lines.ts";
import { hallNarrowingOf } from "./hall-routes.ts";
import { escapeHtml, hallPagePolicy, htmlPage, PAGE_HEADERS, type PageLook } from "./html.ts";
import { keyTag, lampHtml, stateChip, WAITS_CHIP } from "./page-parts.ts";
import { HALL_PATH, initialsOf, NEW_REQUEST_LINK, type PageShell } from "./shell.ts";
import { createPageRoute, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The live hall's page (web-ui: The live hall; web-ui: What the live hall
// shows of the people and agents at work; web-ui: Light and dark themes follow
// the system; web-ui: Motion, and reduced motion; web-ui: The content
// security policy of each kind of page; web-ui: Pages are accessible;
// agent-safety: The web UI renders no raw HTML and no remote images;
// design.md, Design: The live hall; D57 (5), (6), (9), (11), (13)). /hall
// renders, in the app shell and in the dark theme whatever the system
// prefers, the toolbar: the heading; the live lamp, which says, until the
// hall's script runs, that the page updates only with scripts on; the Team and
// Agents only filters in a form a GET submits, so a narrowed hall is a link;
// Pause motion, hidden until the script shows it, so a page without scripts
// shows no button that does nothing; and the link that opens a request. Then,
// from hall.state, read as every page reads: the people and agents at work;
// the map's place, which the script fills on a wide screen; the feed "On the
// line"; every team with a lamp per live state and the counts in words; and
// the lines between teams with the requests on them. Every title, team name,
// login and client name is escaped text. A row of the feed about a request
// that waits on a question or a person has the notice colors and no lamp. The
// page carries the live hall's policy; a browser without a session is sent to
// sign in and back, and opening the page renews the session, as opening any
// page does.

type HallState = z.output<typeof readHallState.output>;
type Counts = HallState["teams"][number]["counts"];
type RequestRef = HallState["feed"][number]["request"];

/** The states that are not terminal, in the order a request goes through them, which the lamps and the counts follow. */
const LIVE_STATES = ["open", "claimed", "in_progress", "needs_info"] as const satisfies readonly RequestState[];

/** Who acted, in Tiehall's words: an agent with its client, a person in the web UI, or Tiehall, GitHub, Jira or the operator. */
export function whoWords(actor: EventActor): string {
  if (actor.kind === "agent") return actor.client === null ? actorWords(actor) : `${actorWords(actor)} · ${clientWords(actor.client)}`;
  if (actor.kind === "web") return `${actorWords(actor)} in the web UI`;
  return actorWords(actor);
}

/** A team's or a line's requests in words, such as "3 open · 1 needs info · 2 done in 24 h", or "Nothing live". */
export function countsWords(counts: Counts, doneLastDay = 0): string {
  const parts = LIVE_STATES.filter((state) => counts[state] > 0).map((state) => `${counts[state]} ${STATE_WORDS[state].toLowerCase()}`);
  if (doneLastDay > 0) parts.push(`${doneLastDay} done in 24 h`);
  return parts.length === 0 ? "Nothing live" : parts.join(" · ");
}

/** A lamp per live state with requests, and a done lamp when some were done in the last 24 hours, beside the words that say them. */
function lampsHtml(counts: Counts, doneLastDay = 0): string {
  return [...LIVE_STATES.filter((state) => counts[state] > 0), ...(doneLastDay > 0 ? ["done"] : [])].map((state) => lampHtml(state)).join("");
}

/** How long ago a moment was, from the answer's time, as the hall says it: "now", "40 s", "3 min", "2 h". */
function agoHtml(at: string, now: string): string {
  return `<time datetime="${escapeHtml(at)}">${escapeHtml(relativeTime(at, now))}</time>`;
}

/** Whether a request waits on a question or a person, which its feed rows show in the notice colors. */
function waits(request: Pick<RequestRef, "state" | "needsHuman">): boolean {
  return request.state === "needs_info" || request.needsHuman;
}

/** What a narrowed hall's empty lists say: about these requests, or about all of them. */
function emptyWords(narrowed: boolean) {
  return narrowed
    ? { atWork: "Nobody is at work on these requests now.", feed: "Nothing has happened on these lines yet.", lines: "No request runs between these teams now." }
    : { atWork: "Nobody is at work now.", feed: "Nothing has happened on the lines yet.", lines: "No request runs between teams now." };
}

/** A person or an agent at work: their initials, who they are with their client, the request's key and title, what they did last and how long ago. */
function workerHtml(entry: HallState["atWork"][number], now: string): string {
  const agent = entry.actor.kind === "agent";
  const waiting = agent && entry.waiting;
  const login = entry.actor.user?.login ?? "";
  // The dots of an agent at work pulse while its last event is under a minute old.
  const typing = agent && Date.parse(now) - Date.parse(entry.at) < 60_000 && !waiting ? ' <span class="typing" aria-hidden="true"><span></span><span></span><span></span></span>' : "";
  return [
    `          <li class="worker ${agent ? "agent" : "web"}${waiting ? " waiting" : ""}">`,
    `            <span class="initials" aria-hidden="true">${escapeHtml(initialsOf(login))}</span>`,
    '            <div class="worker-text">',
    `              <p class="worker-who">${escapeHtml(whoWords(entry.actor))}</p>`,
    `              <p class="worker-on"><span class="mono">${escapeHtml(entry.request.key)}</span> ${escapeHtml(entry.request.untrusted.title)}</p>`,
    `              <p class="worker-did">${escapeHtml(entry.line)} · ${agoHtml(entry.at, now)}${typing}</p>`,
    "            </div>",
    "          </li>",
  ].join("\n");
}

/** A row of the feed: the request's key and title and how long ago, what happened, and who did it. */
function feedRowHtml(event: HallState["feed"][number], now: string): string {
  return [
    `          <li class="feed-row${waits(event.request) ? " waits" : ""}">`,
    `            <p class="feed-meta">${keyTag(event.request.key, `/${event.request.key}`)} <span class="feed-title">${escapeHtml(event.request.untrusted.title)}</span> ${agoHtml(event.at, now)}</p>`,
    `            <p class="feed-line">${escapeHtml(event.line)}</p>`,
    `            <p class="feed-who">${escapeHtml(whoWords(event.actor))}</p>`,
    "          </li>",
  ].join("\n");
}

/** A team: its name and key, a lamp per live state and the counts in words; dimmed by its border when nothing of it is live. */
function teamRowHtml(team: HallState["teams"][number]): string {
  const live = LIVE_STATES.some((state) => team.counts[state] > 0);
  return [
    `          <li class="team-row${live ? "" : " dimmed"}">`,
    `            <p class="team-head"><span class="team-name">${escapeHtml(team.untrusted.name)}</span> <span class="team-key">${escapeHtml(team.key)}</span></p>`,
    `            <p class="team-counts">${lampsHtml(team.counts, team.doneLastDay)}<span>${escapeHtml(countsWords(team.counts, team.doneLastDay))}</span></p>`,
    "          </li>",
  ].join("\n");
}

/** A request on a line: its key, linked to its page, its title, its state chip and the chip of a request that waits for a person, its line and its claimant. */
function requestRowHtml(request: HallState["requestLines"][number], now: string): string {
  const claimant = request.claimant === null ? "nobody" : request.claimant.bot ? `${request.claimant.login} (bot)` : request.claimant.login;
  return [
    "            <tr>",
    `              <td class="cell-key">${keyTag(request.key, `/${request.key}`)}</td>`,
    `              <td class="cell-title" data-label="Title">${escapeHtml(request.untrusted.title)}</td>`,
    `              <td class="cell-state" data-label="State">${stateChip(request.state)}${request.needsHuman ? ` ${WAITS_CHIP}` : ""}</td>`,
    `              <td data-label="Line">${keyTag(request.from.key)} to ${keyTag(request.to.key)}</td>`,
    `              <td data-label="Claimed by">${escapeHtml(claimant)}</td>`,
    `              <td data-label="Changed">${agoHtml(request.changedAt, now)}</td>`,
    "            </tr>",
  ].join("\n");
}

/** The form that narrows the hall, which a GET submits, so a narrowed hall is a link: the Team select and Agents only. */
function filterHtml(state: HallState, narrowing: { team?: string; agents?: boolean }): string {
  const options = [
    `<option value=""${narrowing.team === undefined ? " selected" : ""}>All teams</option>`,
    ...state.teams.map(({ key, untrusted }) => `<option value="${escapeHtml(key)}"${key === narrowing.team ? " selected" : ""}>${escapeHtml(`${key} · ${untrusted.name}`)}</option>`),
  ].join("");
  return [
    `        <form class="hall-filter" method="get" action="${HALL_PATH}">`,
    '          <label for="hall-team">Team</label>',
    `          <select id="hall-team" name="team">${options}</select>`,
    `          <span class="check"><input type="checkbox" id="hall-agents" name="agents" value="1"${narrowing.agents === true ? " checked" : ""}><label for="hall-agents">Agents only</label></span>`,
    '          <button type="submit" class="secondary">Show</button>',
    "        </form>",
  ].join("\n");
}

/** The live hall's page, from hall.state, narrowed as its address says. */
export function hallPageHtml(state: HallState, narrowing: { team?: string; agents?: boolean }, shell: PageShell, look: PageLook = {}): string {
  const empty = emptyWords(narrowing.team !== undefined || narrowing.agents === true);
  const lines = state.lines.map(
    ({ from, to, counts }) =>
      `            <tr><td>${keyTag(from.key)}</td><td>${keyTag(to.key)}</td><td><span class="line-counts">${lampsHtml(counts)}<span>${escapeHtml(countsWords(counts))}</span></span></td></tr>`,
  );
  const main = [
    '      <div class="hall-toolbar">',
    '        <div class="hall-title">',
    "          <h1>Live hall</h1>",
    '          <p class="live-state off" id="live-state"><span class="live-lamp" aria-hidden="true"></span><span id="live-words">Not live: updates need JavaScript</span></p>',
    "        </div>",
    '        <div class="hall-actions">',
    filterHtml(state, narrowing),
    '          <button type="button" class="secondary" id="pause-motion" aria-pressed="false" hidden>Pause motion</button>',
    `          <a class="button" href="${NEW_REQUEST_LINK.href}">Open a request</a>`,
    "        </div>",
    "      </div>",
    '      <section class="hall-section at-work-section" aria-labelledby="at-work-heading">',
    '        <h2 id="at-work-heading">At work</h2>',
    '        <ul class="at-work" id="at-work">',
    ...state.atWork.map((entry) => workerHtml(entry, state.now)),
    "        </ul>",
    `        <p class="empty" id="at-work-empty"${state.atWork.length === 0 ? "" : " hidden"}>${escapeHtml(empty.atWork)}</p>`,
    "      </section>",
    '      <div class="hall-stage">',
    '        <div class="hall-map" id="hall-map" aria-hidden="true" hidden></div>',
    '        <section class="hall-feed" aria-labelledby="feed-heading">',
    '          <h2 id="feed-heading" class="label">On the line</h2>',
    '          <ol class="feed" id="feed">',
    ...state.feed.map((event) => feedRowHtml(event, state.now)),
    "          </ol>",
    `          <p class="empty" id="feed-empty"${state.feed.length === 0 ? "" : " hidden"}>${escapeHtml(empty.feed)}</p>`,
    "        </section>",
    "      </div>",
    '      <p class="visually-hidden" role="status" id="hall-news"></p>',
    '      <section class="hall-section teams-section" aria-labelledby="teams-heading">',
    '        <h2 id="teams-heading">Teams</h2>',
    '        <ul class="team-list" id="team-list">',
    ...state.teams.map(teamRowHtml),
    "        </ul>",
    "      </section>",
    '      <section class="hall-section lines-section" aria-labelledby="lines-heading">',
    '        <h2 id="lines-heading">Lines between teams</h2>',
    '        <div class="table-box">',
    '          <table class="hall-lines">',
    '            <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Requests that are not done</th></tr></thead>',
    '            <tbody id="hall-lines">',
    ...lines,
    "            </tbody>",
    "          </table>",
    "        </div>",
    `        <p class="empty" id="lines-empty"${state.lines.length === 0 ? "" : " hidden"}>${escapeHtml(empty.lines)}</p>`,
    "        <h3>Requests on the lines</h3>",
    '        <table class="requests stacked">',
    '          <thead><tr><th scope="col">Key</th><th scope="col">Title</th><th scope="col">State</th><th scope="col">Line</th><th scope="col">Claimed by</th><th scope="col">Changed</th></tr></thead>',
    '          <tbody id="hall-requests">',
    ...state.requestLines.map((request) => requestRowHtml(request, state.now)),
    "          </tbody>",
    "        </table>",
    "      </section>",
  ].join("\n");
  return htmlPage("Live hall", main, shell, { dark: true, bodyClass: "hall", ...look });
}

/** The live hall's page at /hall, which every member may open, for the signed-in user's web session. */
export function createHallRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: HALL_PATH,
    name: "live hall",
    async get(query, { read, shell }) {
      const narrowing = hallNarrowingOf(query);
      const state = await read<HallState>(readHallState.id, narrowing);
      return new Response(hallPageHtml(state, narrowing, shell), { headers: { ...PAGE_HEADERS, "content-security-policy": hallPagePolicy() } });
    },
  });
}

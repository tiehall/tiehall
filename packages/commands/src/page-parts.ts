import type { RequestState } from "@tiehall/core";
import { relativeTime, STATE_WORDS } from "./event-lines.ts";
import { escapeHtml } from "./html.ts";

// The pieces the web role's pages draw a request with, the same on every page
// (web-ui: A request's state looks the same everywhere; web-ui: Pages are
// accessible; design.md, Design: Request states; D57 (1), (8)): a state as a
// chip that names it in words, in the state's colors; a request that waits
// for a person with a second chip that says so; a lamp, which never stands
// alone, in its state's lamp color; a key in a mono tag; and a moment as how
// long ago it was, with the moment itself as the time element's date. The
// pages Next.js renders draw the same classes (apps/web/lib/request-page.tsx).

/** A state's class, as the stylesheet names its chip and its lamp, such as in-progress. */
export function stateClass(state: string): string {
  return state.replace(/_/g, "-");
}

/** A request's state as a chip that names it in words. */
export function stateChip(state: RequestState): string {
  return `<span class="chip ${stateClass(state)}">${escapeHtml(STATE_WORDS[state])}</span>`;
}

/** The chip of a request agents flagged needs_human, which waits for a person. */
export const WAITS_CHIP = '<span class="chip waits">Waits for a person</span>';

/** The states a lamp is drawn for; a request that ended otherwise has none. */
const LAMPED: ReadonlySet<string> = new Set(["open", "claimed", "in_progress", "needs_info", "done"]);

/** A lamp in a state's color, hidden from assistive technology, which reads the words beside it. */
export function lampHtml(state: string, blink = false): string {
  return `<span class="lamp ${LAMPED.has(state) ? stateClass(state) : "none"}${blink ? " blink" : ""}" aria-hidden="true"></span>`;
}

/** A request's or a team's key in a mono tag, as a link when it is given one. */
export function keyTag(key: string, href?: string): string {
  return href === undefined ? `<span class="key">${escapeHtml(key)}</span>` : `<a class="key" href="${escapeHtml(href)}">${escapeHtml(key)}</a>`;
}

/** How long ago a moment was, from now, as a time element whose date is the moment. */
export function agoHtml(at: string, now: string): string {
  const ago = relativeTime(at, now);
  return `<time datetime="${escapeHtml(at)}">${escapeHtml(ago === "now" ? "just now" : `${ago} ago`)}</time>`;
}

/** A section of a page drawn as a panel and named by its heading, which the page's outline and assistive technology find as a region. */
export function panelHtml(id: string, title: string, body: readonly string[], className?: string): string {
  return [
    `      <section class="panel${className === undefined ? "" : ` ${className}`}" aria-labelledby="${escapeHtml(id)}">`,
    `        <h2 id="${escapeHtml(id)}">${escapeHtml(title)}</h2>`,
    ...body,
    "      </section>",
  ].join("\n");
}

/** How long until a moment, from now, in words: "in 6 days", "in 5 hours", "in 12 minutes", or "soon". */
export function untilWords(at: string, now: string): string {
  const minutes = Math.floor((Date.parse(at) - Date.parse(now)) / 60_000);
  if (minutes < 1) return "soon";
  if (minutes < 60) return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
  return `in ${Math.floor(hours / 24)} days`;
}

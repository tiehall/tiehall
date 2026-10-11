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

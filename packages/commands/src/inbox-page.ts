import { readInboxUpdates } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { updateDescription } from "@tiehall/packet/tool-text";
import { escapeHtml, htmlPage } from "./html.ts";
import type { RequestView } from "./request-views.ts";
import type { UpdatesPage } from "./updates.ts";
import { createPageRoute, htmlAnswer, link, postForm, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The web inbox, at /inbox (requester-loop: The web inbox; requester-loop: The
// pull readers; requester-loop: What whats_new covers; design.md, Decisions
// this change rests on: D28 #62; D29 (5); design.md, Design rules: Requester
// loop). A member's web inbox holds the update feed: their updates after the
// web inbox's own cursor, oldest first, from whats_new's scope plus the events
// on the requests their teams requested, a page at a time. Each update is
// said in Tiehall's own words, with a link to its request's page and the
// request's title, which its requester wrote, as text. A form acknowledges the
// updates the page shows, up to the last of them, which moves the web inbox's
// cursor alone, as any pull reader's acknowledgement moves its own; it passes
// the web UI's write checks and leads back to the inbox. The page reads
// through execute(), as the member's web session, in a read-only transaction.

/** Where the web inbox lives. */
export const INBOX_PATH = "/inbox";

/** How many updates the feed shows at a time. */
export const INBOX_PAGE_SIZE = 50;

/** The row of one update: its number, its request, its team, when, what it says, and the request's title. */
function updateRow(update: UpdatesPage["events"][number], byId: ReadonlyMap<string, RequestView>): string {
  const title = byId.get(update.request.id)?.untrusted.title ?? "";
  const said = updateDescription(update, { ids: false }) ?? update.type;
  const cells = [
    escapeHtml(String(update.number)),
    link(`/${update.request.key}`, update.request.key),
    escapeHtml(update.request.targetTeam.key),
    escapeHtml(update.occurredAt),
    escapeHtml(said),
    escapeHtml(title),
  ];
  return `        <tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
}

/** The update feed's section: the updates, and the form that acknowledges them. */
function feedSection(feed: UpdatesPage, csrf: string): string {
  const last = feed.events.at(-1)?.number;
  if (last === undefined) return ["      <h2>Updates</h2>", "      <p>No new updates.</p>"].join("\n");
  const byId = new Map(feed["requests"].map((request) => [request.id, request]));
  const count = feed.events.length === 1 ? "1 update" : `${feed.events.length} updates`;
  return [
    "      <h2>Updates</h2>",
    `      <p>${escapeHtml(`${count} since you last acknowledged, oldest first.${feed.more ? " More follow once you acknowledge these." : ""}`)}</p>`,
    "      <table>",
    "        <tr><th>Update</th><th>Request</th><th>Team</th><th>When</th><th>What happened</th><th>Title</th></tr>",
    ...feed.events.map((update) => updateRow(update, byId)),
    "      </table>",
    postForm(INBOX_PATH, { action: "acknowledge", upTo: String(last) }, csrf, "Acknowledge these updates"),
  ].join("\n");
}

export function createInboxRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: INBOX_PATH,
    name: "inbox",
    async get(_query, { read, csrf }) {
      const feed = await read<UpdatesPage>(readInboxUpdates.id, { limit: INBOX_PAGE_SIZE });
      return htmlAnswer(htmlPage("Inbox", ["      <h1>Inbox</h1>", feedSection(feed, csrf)].join("\n")));
    },
    async post(form, { write }) {
      if (form.get("action") !== "acknowledge") throw new Refusal("invalid-input", "The form acknowledges the updates it shows.");
      const upTo = form.get("upTo") ?? "";
      if (!/^[1-9][0-9]{0,15}$/.test(upTo)) throw new Refusal("invalid-input", "The form names the last update it shows by its number.");
      await write(readInboxUpdates.id, { acknowledge: Number(upTo), limit: 1 });
      return seeOther(INBOX_PATH);
    },
  });
}

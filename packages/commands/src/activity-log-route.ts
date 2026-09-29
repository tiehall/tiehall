import { exportActivityLog, listActivityLog, type activityEvent } from "@tiehall/catalog";
import type { z } from "zod";
import { CONFIRM_PATH } from "./confirm-route.ts";
import { escapeHtml, htmlPage } from "./html.ts";
import { userName } from "./members.ts";
import { createPageRoute, htmlAnswer, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The activity log's page in the web UI, at /admin/activity-log
// (activity-log: The admin view; activity-log: Security events are shown to
// admins only; design.md, Self-hosting decisions: S14 and S15). A GET shows a
// signed-in admin the events activity_log.list returns for the filters in
// the query (from, to, actor, request, type, before), newest first, with a
// form to change the filters, a link to the older events and a link to the
// export's review page (activity-log: Exporting the activity log). Every event
// shows its number, time, class, type, the ids it carries, who caused it and
// the request it concerns, and a security event its IP address and user
// agent while they are kept; a refused sign-in's event also names the GitHub
// account that was refused, by the login it had and its numeric id, for as
// long as the event is kept (D50 (5)). The page runs no script, loads nothing and
// cannot be framed. It is served like every other page of the web UI
// (web-pages.ts): a browser without a session is sent to sign in first and
// comes back to the page (agent-surfaces: A browser without a session is sent
// to sign-in; design.md, Decisions this change rests on: D28 #66), and the
// page has no form to post. It reads through execute(), in a read-only
// transaction, so it takes the same path as every other operation and
// changes nothing: 403 for a member, 400 for a filter that fails the
// operation's schema, as RFC 9457 problems (public-api: One error model for
// Tiehall's own refusals).

/** What the page is built with, as every page of the web UI. */
export type ActivityLogRouteOptions = PageRouteOptions;

export type ActivityLogRoute = PageRoute;

/** Where the page lives. */
export const ACTIVITY_LOG_PATH = "/admin/activity-log";

/** How many events a page shows. */
const PAGE_SIZE = 100;

type ActivityEvent = z.output<typeof activityEvent>;

/** The filters a page's query names, as the operation's input; a value the schema refuses gets 400 from execute(). */
const FILTERS: readonly [query: string, input: string][] = [
  ["from", "from"],
  ["to", "to"],
  ["actor", "actorUserId"],
  ["request", "request"],
  ["type", "type"],
];

export function createActivityLogRoute(options: ActivityLogRouteOptions): ActivityLogRoute {
  return createPageRoute(options, {
    path: ACTIVITY_LOG_PATH,
    name: "activity log",
    async get(query, calls) {
      const input: Record<string, unknown> = { limit: PAGE_SIZE };
      for (const [name, field] of FILTERS) {
        const value = query.get(name)?.trim();
        if (value !== undefined && value !== "") input[field] = value;
      }
      const before = query.get("before")?.trim();
      if (before !== undefined && before !== "") input["before"] = /^\d+$/.test(before) ? Number(before) : before;
      const output = await calls.read<{ events: ActivityEvent[] }>(listActivityLog.id, input);
      return htmlAnswer(page(query, output.events));
    },
  });
}

/** The page: the filters as a form, the events as a table, and a link to the older ones. */
function page(query: URLSearchParams, events: ActivityEvent[]): string {
  const field = (name: string, label: string, placeholder: string) =>
    `        <label>${escapeHtml(label)} <input name="${name}" type="text" value="${escapeHtml(query.get(name) ?? "")}" placeholder="${escapeHtml(placeholder)}"></label>`;
  const rows = events.map(
    (event) => `        <tr>
          <td>${event.number}</td>
          <td><time datetime="${escapeHtml(event.occurredAt)}">${escapeHtml(event.occurredAt)}</time></td>
          <td>${escapeHtml(event.class)}</td>
          <td>${escapeHtml(event.type)}</td>
          <td>${escapeHtml(event.request?.key ?? "")}</td>
          <td>${escapeHtml(actorText(event))}</td>
          <td>${escapeHtml(dataText(event))}</td>
          <td>${escapeHtml(originText(event))}</td>
        </tr>`,
  );
  const last = events.at(-1);
  const older =
    events.length === PAGE_SIZE && last !== undefined
      ? `      <p><a href="${escapeHtml(olderLink(query, last.number))}">Older events</a></p>`
      : "";
  return htmlPage(
    "Activity log",
    [
      "      <h1>Activity log</h1>",
      "      <p>Every change to a request, and every security-relevant action, newest first. Security events show their IP address and user agent for 90 days.</p>",
      `      <p><a href="${escapeHtml(`${CONFIRM_PATH}${exportActivityLog.id}?input=${encodeURIComponent("{}")}`)}">Export the whole log as JSONL</a>, with a confirmation.</p>`,
      `      <form method="get" action="${ACTIVITY_LOG_PATH}">`,
      field("from", "From", "2026-10-01T00:00:00Z"),
      field("to", "To", "2026-10-01T23:59:59Z"),
      field("actor", "Actor (user id)", ""),
      field("request", "Request", "FE-142"),
      field("type", "Event type", "member.role_changed"),
      "        <button type=\"submit\">Filter</button>",
      "      </form>",
      "      <table>",
      "        <thead><tr><th>#</th><th>Time</th><th>Class</th><th>Type</th><th>Request</th><th>Actor</th><th>Data</th><th>Origin</th></tr></thead>",
      "        <tbody>",
      ...(rows.length === 0 ? ["        <tr><td colspan=\"8\">No events match.</td></tr>"] : rows),
      "        </tbody>",
      "      </table>",
      older,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
}

/** Who caused the event, in a few words: the user by their login, or the system, an integration or an operator command. */
function actorText({ actor }: ActivityEvent): string {
  switch (actor.kind) {
    case "operator":
      return `operator: ${actor.operatorCommand ?? ""}`;
    case "system":
    case "integration":
      return [actor.kind, actor.surface, actor.user === undefined ? undefined : userName(actor.user)].filter((part) => part !== undefined).join(" ");
    default:
      return `${actor.user === undefined ? "" : userName(actor.user)} (${actor.kind}${actor.surface === undefined ? "" : `, ${actor.surface}`})`;
  }
}

/** The ids and values the event carries, as name=value pairs, and, for a refused sign-in, the GitHub account that was refused. */
function dataText({ data, refusedAccount }: ActivityEvent): string {
  const pairs = Object.entries(data)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(" ");
  return refusedAccount === undefined ? pairs : `${pairs}; refused GitHub account ${refusedAccount.githubLogin}, id ${refusedAccount.githubAccountId}`;
}

function originText({ origin }: ActivityEvent): string {
  return origin === undefined ? "" : [origin.ipAddress, origin.userAgent].filter((part) => part !== undefined).join(" ");
}

/** The same filters, for the events before a number. */
function olderLink(query: URLSearchParams, before: number): string {
  const next = new URLSearchParams();
  for (const [name] of FILTERS) {
    const value = query.get(name);
    if (value !== null && value.trim() !== "") next.set(name, value);
  }
  next.set("before", String(before));
  return `${ACTIVITY_LOG_PATH}?${next.toString()}`;
}

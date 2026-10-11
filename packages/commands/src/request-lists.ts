import { listInbox, listOpenedRequests, listRequests } from "@tiehall/catalog";
import { REQUEST_STATES, Refusal, type RequestState } from "@tiehall/core";
import { escapeHtml, htmlPage } from "./html.ts";
import type { PageShell } from "./shell.ts";
import { NEW_REQUEST_PATH } from "./new-request.ts";
import type { RequestView } from "./request-views.ts";
import { createPageRoute, htmlAnswer, link, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The web UI's request lists, at /requests (requests: Every member sees every
// request; agent-surfaces: The MCP tools; design.md, Decisions this change
// rests on: D28 #3, #56). A member finds three lists there:
// - the requests addressed to their teams, the default, as list_inbox reads
//   them;
// - the requests they opened, from any of their teams, which an internal read
//   lists for the web UI and no agent surface offers;
// - every request of the install, as /api/v1 lists them, since every member
//   sees every request, whatever teams they belong to.
// Each list is newest first, may be narrowed to the requests in one state, and
// comes a page at a time, with links to the newer and the older requests. Each
// row links to the request's page at its URL, and says its title, as text its
// requester wrote, escaped, its state, the team it is addressed to, who opened
// it and from which team, who holds its claim, and, in Tiehall's words,
// whether it waits for a person because agents made so many writes on it. The
// page reads the lists through execute(), as the member's web session, in
// read-only transactions (web-pages.ts), and links to the form that opens a
// request. A list, a state or a page the page does not know gets 400.

/** Where the request lists live. */
export const REQUEST_LISTS_PATH = "/requests";

/** How many requests a page of a list shows, unless the route is given another number. */
export const REQUEST_LIST_PAGE_SIZE = 25;

/** The three lists, by the value of the `list` query parameter; the first is the default. */
const LISTS = {
  mine: { title: "Addressed to your teams", commandId: listInbox.id, empty: "No request is addressed to your teams." },
  opened: { title: "Opened by you", commandId: listOpenedRequests.id, empty: "You have opened no request." },
  all: { title: "All requests", commandId: listRequests.id, empty: "The install has no request yet." },
} as const;

type ListName = keyof typeof LISTS;

/** What a page of a list is: which list, in which state, and which page. */
interface ListQuery {
  list: ListName;
  state: RequestState | undefined;
  page: number;
}

function invalid(name: string, message: string): Refusal {
  return new Refusal("invalid-input", message, { issues: [{ path: [name], message }] });
}

/** The page of a list a query names; a list, a state or a page the page does not know is refused with 400. */
function listQueryOf(query: URLSearchParams): ListQuery {
  const list = query.get("list") ?? "mine";
  if (!Object.hasOwn(LISTS, list)) throw invalid("list", "The list is mine, opened or all.");
  const state = query.get("state") ?? "";
  if (state !== "" && !(REQUEST_STATES as readonly string[]).includes(state)) {
    throw invalid("state", `The state is one of ${REQUEST_STATES.join(", ")}.`);
  }
  const page = query.get("page") ?? "1";
  if (!/^[1-9][0-9]{0,5}$/.test(page)) throw invalid("page", "The page is a whole number from 1.");
  return { list: list as ListName, state: state === "" ? undefined : (state as RequestState), page: Number(page) };
}

/** The path of a page of a list, with only the query parameters that differ from the defaults. */
function listPath({ list, state, page }: ListQuery): string {
  const query = new URLSearchParams();
  if (list !== "mine") query.set("list", list);
  if (state !== undefined) query.set("state", state);
  if (page !== 1) query.set("page", String(page));
  const search = query.toString();
  return search === "" ? REQUEST_LISTS_PATH : `${REQUEST_LISTS_PATH}?${search}`;
}

/** A user as the lists name them: their GitHub login, marked when an admin flagged them as a bot. */
function person(user: { login: string; bot: boolean }): string {
  return user.bot ? `${user.login} (a bot user)` : user.login;
}

/** A request's row. */
function row(request: RequestView): string {
  const requester = request.requester.user === null ? `team ${request.requester.team.key}` : `${person(request.requester.user)} for ${request.requester.team.key}`;
  const cells = [
    `<a href="/${escapeHtml(request.key)}">${escapeHtml(request.key)}</a>`,
    escapeHtml(request.untrusted.title),
    escapeHtml(request.state),
    escapeHtml(request.targetTeam.key),
    escapeHtml(requester),
    escapeHtml(request.claimant === null ? "nobody" : person(request.claimant)),
    escapeHtml(request.createdAt),
    request.needsHuman ? "It waits for a person: agents' writes on it are refused until a member posts a message on it or confirms a proposal on it in the web UI." : "",
  ];
  return `        <tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
}

/** The links to the three lists, the one shown marked. */
function listsNav(shown: ListName): string {
  const links = (Object.keys(LISTS) as ListName[]).map((list) =>
    list === shown ? `<strong>${escapeHtml(LISTS[list].title)}</strong>` : link(listPath({ list, state: undefined, page: 1 }), LISTS[list].title),
  );
  return `      <nav>${links.join(" · ")}</nav>`;
}

/** The form that narrows the list to one state, which a GET submits: it changes nothing. */
function stateForm({ list, state }: ListQuery): string {
  const options = [
    `<option value=""${state === undefined ? " selected" : ""}>Any state</option>`,
    ...REQUEST_STATES.map((each) => `<option value="${each}"${each === state ? " selected" : ""}>${each}</option>`),
  ].join("");
  return [
    `      <form method="get" action="${REQUEST_LISTS_PATH}">`,
    ...(list === "mine" ? [] : [`        <input type="hidden" name="list" value="${escapeHtml(list)}">`]),
    `        <label for="state">State</label> <select id="state" name="state">${options}</select>`,
    '        <button type="submit">Show</button>',
    "      </form>",
  ].join("\n");
}

function listsPage(query: ListQuery, listed: readonly RequestView[], older: boolean, shell: PageShell): string {
  const { title, empty } = LISTS[query.list];
  const pages = [
    ...(query.page > 1 ? [link(listPath({ ...query, page: query.page - 1 }), "Newer requests")] : []),
    ...(older ? [link(listPath({ ...query, page: query.page + 1 }), "Older requests")] : []),
  ];
  return htmlPage(
    `Requests: ${title}`,
    [
      "      <h1>Requests</h1>",
      listsNav(query.list),
      `      <p>${link(NEW_REQUEST_PATH, "Open a request")}</p>`,
      `      <h2>${escapeHtml(title)}</h2>`,
      stateForm(query),
      ...(listed.length === 0
        ? [`      <p>${escapeHtml(query.state === undefined && query.page === 1 ? empty : "No request here.")}</p>`]
        : [
            "      <table>",
            "        <tr><th>Key</th><th>Title</th><th>State</th><th>To</th><th>Opened by</th><th>Claimed by</th><th>Opened at</th><th></th></tr>",
            ...listed.map(row),
            "      </table>",
          ]),
      ...(pages.length === 0 ? [] : [`      <p>${pages.join(" · ")}</p>`]),
    ].join("\n"),
    shell,
  );
}

export function createRequestListsRoute(options: PageRouteOptions, { pageSize = REQUEST_LIST_PAGE_SIZE }: { pageSize?: number } = {}): PageRoute {
  return createPageRoute(options, {
    path: REQUEST_LISTS_PATH,
    name: "request lists",
    async get(search, { read, shell }) {
      const query = listQueryOf(search);
      // One request more than a page shows, which says whether older ones follow.
      const input = { ...(query.state === undefined ? {} : { state: query.state }), limit: pageSize + 1, offset: (query.page - 1) * pageSize };
      const { "requests": found } = await read<{ "requests": RequestView[] }>(LISTS[query.list].commandId, input);
      return htmlAnswer(listsPage(query, found.slice(0, pageSize), found.length > pageSize, shell));
    },
  });
}

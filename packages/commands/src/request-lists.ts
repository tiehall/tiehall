import { listInbox, listOpenedRequests, listRequests } from "@tiehall/catalog";
import { REQUEST_STATES, Refusal, type RequestState } from "@tiehall/core";
import { STATE_WORDS } from "./event-lines.ts";
import { escapeHtml, htmlPage } from "./html.ts";
import { agoHtml, keyTag, stateChip, WAITS_CHIP } from "./page-parts.ts";
import type { PageShell } from "./shell.ts";
import { NEW_REQUEST_PATH } from "./new-request.ts";
import type { RequestView } from "./request-views.ts";
import { createPageRoute, htmlAnswer, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The web UI's request lists, at /requests (requests: Every member sees every
// request; agent-surfaces: The MCP tools; design.md, Decisions this change
// rests on: D28 #3, #56). A member finds three lists there:
// - the requests addressed to their teams, the default, as list_inbox reads
//   them, so those not finished unless a state is chosen
//   (decisions-from-groups-15-28: design.md, Decisions this change rests on:
//   D55 (28));
// - the requests they opened, from any of their teams, which an internal read
//   lists for the web UI and no agent surface offers;
// - every request of the install, as /api/v1 lists them, since every member
//   sees every request, whatever teams they belong to.
// Each list is newest first, may be narrowed to the requests in one state, and
// comes a page at a time, with links to the newer and the older requests. Each
// row links to the request's page at its URL, and says its title, as text its
// requester wrote, escaped, its state as a chip in words, the team it is
// addressed to, who opened it and from which team, who holds its claim, when it
// was opened, and, with a second chip, whether it waits for a person because
// agents made so many writes on it (web-ui: A request's state looks the same
// everywhere). A wide screen shows the list as a table, a narrow one each row
// as a card (web-ui: Pages work at phone width). The
// page reads the lists through execute(), as the member's web session, in
// read-only transactions (web-pages.ts), and links to the form that opens a
// request. A list, a state or a page the page does not know gets 400.

/** Where the request lists live. */
export const REQUEST_LISTS_PATH = "/requests";

/** How many requests a page of a list shows, unless the route is given another number. */
export const REQUEST_LIST_PAGE_SIZE = 25;

/** The three lists, by the value of the `list` query parameter; the first is the default. */
const LISTS = {
  mine: { title: "Addressed to your teams", commandId: listInbox.id, empty: "No unfinished request is addressed to your teams." },
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

/**
 * A request's row: its key, linked to its page, its title, its state as a
 * chip and, when it waits for a person, a second chip that says so, who opened
 * it from which team, the team it is addressed to, who holds its claim and
 * when it was opened. Each cell names its column too, so a narrow screen shows
 * the row as a card.
 */
function row(request: RequestView, now: string): string {
  const requester = request.requester.user === null ? `team ${request.requester.team.key}` : `${person(request.requester.user)} for ${request.requester.team.key}`;
  return [
    "        <tr>",
    `          <td class="cell-key">${keyTag(request.key, `/${request.key}`)}</td>`,
    `          <td class="cell-title" data-label="Title">${escapeHtml(request.untrusted.title)}</td>`,
    `          <td class="cell-state" data-label="State">${stateChip(request.state)}${request.needsHuman ? ` ${WAITS_CHIP}` : ""}</td>`,
    `          <td data-label="From">${escapeHtml(requester)}</td>`,
    `          <td data-label="To">${keyTag(request.targetTeam.key)}</td>`,
    `          <td data-label="Claimed by">${escapeHtml(request.claimant === null ? "nobody" : person(request.claimant))}</td>`,
    `          <td data-label="Opened">${agoHtml(request.createdAt, now)}</td>`,
    "        </tr>",
  ].join("\n");
}

/** The links to the three lists, the one shown marked as the current one. */
function listsNav(shown: ListName): string {
  const links = (Object.keys(LISTS) as ListName[]).map(
    (list) =>
      `<li><a href="${escapeHtml(listPath({ list, state: undefined, page: 1 }))}"${list === shown ? ' aria-current="page"' : ""}>${escapeHtml(LISTS[list].title)}</a></li>`,
  );
  return `      <nav class="tabs" aria-label="Lists"><ul>${links.join("")}</ul></nav>`;
}

/** The form that narrows the list to one state, which a GET submits: it changes nothing. */
function stateForm({ list, state }: ListQuery): string {
  const options = [
    // The list addressed to the member's teams reads list_inbox, which without a state leaves out finished requests.
    `<option value=""${state === undefined ? " selected" : ""}>${list === "mine" ? "Not finished" : "Any state"}</option>`,
    ...REQUEST_STATES.map((each) => `<option value="${each}"${each === state ? " selected" : ""}>${escapeHtml(STATE_WORDS[each])}</option>`),
  ].join("");
  return [
    `      <form class="filter" method="get" action="${REQUEST_LISTS_PATH}">`,
    ...(list === "mine" ? [] : [`        <input type="hidden" name="list" value="${escapeHtml(list)}">`]),
    `        <div class="field"><label for="state">State</label><select id="state" name="state">${options}</select></div>`,
    '        <button type="submit" class="secondary">Show</button>',
    "      </form>",
  ].join("\n");
}

function listsPage(query: ListQuery, listed: readonly RequestView[], older: boolean, shell: PageShell): string {
  const { title, empty } = LISTS[query.list];
  const now = new Date().toISOString();
  const pages = [
    ...(query.page > 1 ? [`<a class="button secondary" href="${escapeHtml(listPath({ ...query, page: query.page - 1 }))}">Newer requests</a>`] : []),
    ...(older ? [`<a class="button secondary" href="${escapeHtml(listPath({ ...query, page: query.page + 1 }))}">Older requests</a>`] : []),
  ];
  return htmlPage(
    `Requests: ${title}`,
    [
      '      <div class="page-head">',
      "        <h1>Requests</h1>",
      `        <a class="button" href="${NEW_REQUEST_PATH}">Open a request</a>`,
      "      </div>",
      listsNav(query.list),
      '      <div class="list-head">',
      `        <h2>${escapeHtml(title)}</h2>`,
      stateForm(query),
      "      </div>",
      ...(listed.length === 0
        ? [`      <p class="empty">${escapeHtml(query.state === undefined && query.page === 1 ? empty : "No request here.")}</p>`]
        : [
            '      <table class="requests stacked">',
            '        <thead><tr><th scope="col">Key</th><th scope="col">Title</th><th scope="col">State</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Claimed by</th><th scope="col">Opened</th></tr></thead>',
            "        <tbody>",
            ...listed.map((request) => row(request, now)),
            "        </tbody>",
            "      </table>",
          ]),
      ...(pages.length === 0 ? [] : [`      <nav class="pages" aria-label="Pages">${pages.join(" ")}</nav>`]),
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

import { readInboxUpdates, reconfirmConsumer, rejectProposal, standingList, type proposal } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { updateDescription } from "@tiehall/packet/tool-text";
import type { z } from "zod";
import { commitmentPhrase } from "./email.ts";
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
// the web UI's write checks and leads back to the inbox.
//
// Beside the feed, the standing list holds what stays listed whether or not
// the member acknowledged anything (requests: Where a proposal waits;
// requests: Receipts; design.md, Decisions this change rests on: D30 (4);
// design.md, Self-hosting decisions: S7): each proposal that waits for a
// confirmation they may give now, as inbox.standing_list decides at the
// moment of the read, said in Tiehall's words, with a link to its confirm
// page, where they review it and confirm it with the confirmation step, and a
// form that rejects it, which needs no confirmation step but passes the web
// UI's write checks; the receipts of their confirmations and undos, whose
// words show how a proposal that waited for the other side ended, each with
// its undo page while the commitment can still be undone; and the reminders
// that their personal access tokens expire soon; their teams' daily WARN
// digests, each with the potentially breaking changes it lists as text and a
// link to its provider pull request (contract-changes: Potentially breaking
// changes go to a daily digest); and the requests to re-confirm
// the declarations of their teams that they consume an API, each in Tiehall's
// words, with a link to the team's page and a form that re-confirms it, which
// needs no confirmation step but passes the web UI's write checks
// (contract-changes: Declarations are re-confirmed every 90 days). The confirm URL reaches the
// member here, in the web UI, and never an agent (agent-safety: The confirm
// URL never reaches the model). The page reads through execute(), as the
// member's web session, in read-only transactions.

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

type ProposalView = z.input<typeof proposal>;

/** What the standing list holds, as inbox.standing_list reads it. */
interface StandingList {
  waiting: ProposalView[];
  receipts: { id: string; text: string; undoUntil: string | null; proposal: ProposalView }[];
  reminders: { id: string; text: string }[];
  warnDigests: {
    team: { id: string; key: string };
    day: string;
    text: string;
    changeSets: { api: string; pullRequest: { repository: string; number: number; url: string }; untrusted: { changes: { id: string; operation: string }[] } }[];
  }[];
  reconfirmations: { api: { id: string; name: string }; team: { id: string; key: string }; text: string }[];
}

/** How a surface is named in the web UI's words. */
const THROUGH: Readonly<Record<string, string>> = {
  mcp: "through MCP",
  cli: "through the CLI",
  api: "through the API",
  web: "in the web UI",
  github: "from GitHub",
  jira: "from Jira",
};

/** A user as the web inbox names them: their GitHub login, marked when an admin flagged them as a bot. */
function person(user: { login: string; bot: boolean }): string {
  return user.bot ? `${user.login} (a bot user)` : user.login;
}

/** What a waiting proposal proposes and who made it, in Tiehall's words. */
function proposalSentence(view: ProposalView): string {
  const what =
    view.kind === "due_date" && view.change.dueDate !== undefined
      ? view.change.dueDate === null
        ? "remove its due date"
        : `set its due date to ${view.change.dueDate}`
      : view.kind === "reassign" && view.change.team !== undefined
        ? `reassign it to team ${view.change.team.key}`
        : commitmentPhrase(view.kind);
  const { proposedBy } = view;
  const through = proposedBy.surface === null ? "" : ` ${THROUGH[proposedBy.surface] ?? ""}`;
  const by =
    proposedBy.actorKind === "agent"
      ? `${person(proposedBy.user)}'s agent${through}`
      : proposedBy.actorKind === "integration"
        ? `${person(proposedBy.user)}${through}`
        : `${person(proposedBy.user)} in the web UI`;
  const confirmed = view.confirmations.received.map(({ user }) => person(user));
  const has = confirmed.length === 0 ? "" : ` ${confirmed.join(" and ")} confirmed it already.`;
  return `${view.request.key}: a proposal to ${what}, made by ${by}.${has} It expires at ${view.expiresAt}.`;
}

/** The standing list's sections: what waits for the member, their receipts and their reminders. */
function standingSection(list: StandingList, csrf: string): string {
  const waiting =
    list.waiting.length === 0
      ? ["      <p>Nothing waits for your confirmation.</p>"]
      : [
          '      <ul id="waiting">',
          ...list.waiting.map((view) =>
            [
              "        <li>",
              `          ${link(`/${view.request.key}`, view.request.key)}${escapeHtml(proposalSentence(view).slice(view.request.key.length))}`,
              `          ${link(`/confirm/${view.id}`, "Review and confirm")}`,
              postForm(INBOX_PATH, { action: "reject", proposal: view.id }, csrf, "Reject", "          "),
              "        </li>",
            ].join("\n"),
          ),
          "      </ul>",
        ];
  const receipts =
    list.receipts.length === 0
      ? ["      <p>No receipts yet.</p>"]
      : [
          '      <ul id="receipts">',
          ...list.receipts.map(({ text, undoUntil, proposal: view }) => {
            const undo = undoUntil === null ? "" : ` ${link(`/confirm/${view.id}/undo`, `Undo it until ${undoUntil}`)}`;
            return `        <li>${escapeHtml(text)}${undo}</li>`;
          }),
          "      </ul>",
        ];
  const reminders =
    list.reminders.length === 0 ? [] : ["      <h2>Reminders</h2>", '      <ul id="reminders">', ...list.reminders.map(({ text }) => `        <li>${escapeHtml(text)}</li>`), "      </ul>"];
  const reconfirmations =
    list.reconfirmations.length === 0
      ? []
      : [
          "      <h2>Declarations to re-confirm</h2>",
          '      <ul id="reconfirmations">',
          ...list.reconfirmations.map(({ api, team, text }) =>
            [
              "        <li>",
              `          ${escapeHtml(text)} ${link(`/${team.key}`, `The page of ${team.key}`)}`,
              postForm(INBOX_PATH, { action: "reconfirm", api: api.id, team: team.id }, csrf, `Re-confirm that ${team.key} consumes ${api.name}`, "          "),
              "        </li>",
            ].join("\n"),
          ),
          "      </ul>",
        ];
  // The changes come from the diff engine in the provider's CI: text, escaped, as everything people and other systems wrote.
  const warnDigests =
    list.warnDigests.length === 0
      ? []
      : [
          "      <h2>WARN digests</h2>",
          '      <ul id="warn-digests">',
          ...list.warnDigests.map(({ text, changeSets }) =>
            [
              "        <li>",
              `          <p>${escapeHtml(text)}</p>`,
              "          <ul>",
              ...changeSets.map(({ api, pullRequest, untrusted }) =>
                [
                  `            <li>${escapeHtml(`${api} in ${pullRequest.repository}#${pullRequest.number}`)} (<a href="${escapeHtml(pullRequest.url)}" rel="noreferrer">the provider pull request</a>):`,
                  `              <ul>${untrusted.changes.map(({ id, operation }) => `<li>${escapeHtml(`${id}: ${operation}`)}</li>`).join("")}</ul>`,
                  "            </li>",
                ].join("\n"),
              ),
              "          </ul>",
              "        </li>",
            ].join("\n"),
          ),
          "      </ul>",
        ];
  return ["      <h2>Waiting for your confirmation</h2>", ...waiting, "      <h2>Receipts</h2>", ...receipts, ...reminders, ...warnDigests, ...reconfirmations].join("\n");
}

export function createInboxRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: INBOX_PATH,
    name: "inbox",
    async get(_query, { read, csrf, shell }) {
      const list = await read<StandingList>(standingList.id, {});
      const feed = await read<UpdatesPage>(readInboxUpdates.id, { limit: INBOX_PAGE_SIZE });
      return htmlAnswer(htmlPage("Inbox", ["      <h1>Inbox</h1>", standingSection(list, csrf), feedSection(feed, csrf)].join("\n"), shell));
    },
    async post(form, { write }) {
      const action = form.get("action");
      if (action === "reject") {
        // A rejection ends the proposal without any effect, so it needs no confirmation step (agent-safety: Actions that
        // need the confirmation step); who may reject it, and when, proposals.reject decides.
        await write(rejectProposal.id, { proposal: form.get("proposal") ?? "" });
        return seeOther(INBOX_PATH);
      }
      if (action === "reconfirm") {
        // Re-confirming a declaration moves its last confirmation alone, so it needs no confirmation step; who may, apis.reconfirm_consumer decides.
        await write(reconfirmConsumer.id, { api: form.get("api") ?? "", team: form.get("team") ?? "" });
        return seeOther(INBOX_PATH);
      }
      if (action !== "acknowledge") throw new Refusal("invalid-input", "The form acknowledges the updates it shows, rejects a proposal, or re-confirms a declaration.");
      const upTo = form.get("upTo") ?? "";
      if (!/^[1-9][0-9]{0,15}$/.test(upTo)) throw new Refusal("invalid-input", "The form names the last update it shows by its number.");
      await write(readInboxUpdates.id, { acknowledge: Number(upTo), limit: 1 });
      return seeOther(INBOX_PATH);
    },
  });
}

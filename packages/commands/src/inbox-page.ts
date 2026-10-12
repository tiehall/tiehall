import { dismissWarnDigest, readInboxUpdates, reconfirmConsumer, rejectProposal, standingList, type proposal } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import type { z } from "zod";
import { commitmentPhrase } from "./email.ts";
import { eventLine } from "./event-lines.ts";
import { escapeHtml, htmlPage } from "./html.ts";
import { agoHtml, keyTag, leftWords, panelHtml, untilWords, utcHtml } from "./page-parts.ts";
import type { RequestView } from "./request-views.ts";
import type { UpdatesPage } from "./updates.ts";
import { createPageRoute, htmlAnswer, postForm, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The web inbox, at /inbox (requester-loop: The web inbox; requester-loop: The
// pull readers; requester-loop: What whats_new covers; design.md, Decisions
// this change rests on: D28 #62; D29 (5); design.md, Design rules: Requester
// loop; web-ui: The page shell and its navigation; web-ui: Motion, and
// reduced motion; design.md, Design: The page families; D57 (4), (6)). What
// waits for the member comes first, under the signal lamp, which blinks three
// times, each proposal as a card; then the updates, which slide in once; then
// the receipts, and the WARN digests and re-confirmation requests. A member's
// web inbox holds the update feed: their updates after the
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

/** The row of one update: its request's key, linked to its page, what happened in Tiehall's words, the request's title, its team and when; it slides in once. */
function updateRow(update: UpdatesPage["events"][number], byId: ReadonlyMap<string, RequestView>, now: string): string {
  const title = byId.get(update.request.id)?.untrusted.title ?? "";
  const said = eventLine(update.type, update.data);
  return [
    '        <li class="update slide-in">',
    `          ${keyTag(update.request.key, `/${update.request.key}`)}`,
    `          <p class="update-what">${escapeHtml(said)}<span class="update-title">${escapeHtml(title)}</span></p>`,
    `          <p class="update-meta">${escapeHtml(`Update ${update.number} · team ${update.request.targetTeam.key} · `)}${agoHtml(update.occurredAt, now)}</p>`,
    "        </li>",
  ].join("\n");
}

/** The update feed's panel: how many updates follow the cursor, each as a row, and the form that acknowledges them. */
function feedSection(feed: UpdatesPage, csrf: string, now: string): string {
  const last = feed.events.at(-1)?.number;
  if (last === undefined) return panelHtml("updates", "Updates", ['        <p class="empty">No new updates.</p>'], "updates");
  const byId = new Map(feed["requests"].map((request) => [request.id, request]));
  const count = feed.events.length === 1 ? "1 update" : `${feed.events.length} updates`;
  return panelHtml(
    "updates",
    "Updates",
    [
      '        <div class="panel-bar">',
      `          <p class="hint">${escapeHtml(`${count} since you last acknowledged, oldest first.${feed.more ? " More follow once you acknowledge these." : ""}`)}</p>`,
      postForm(INBOX_PATH, { action: "acknowledge", upTo: String(last) }, csrf, "Acknowledge these updates", "          ", "secondary"),
      "        </div>",
      '        <ol class="update-list">',
      ...feed.events.map((update) => updateRow(update, byId, now)),
      "        </ol>",
    ],
    "updates",
  );
}

type ProposalView = z.input<typeof proposal>;

/** What the standing list holds, as inbox.standing_list reads it. */
interface StandingList {
  waiting: ProposalView[];
  receipts: { id: string; text: string; undoUntil: string | null; proposal: ProposalView | null }[];
  reminders: { id: string; text: string }[];
  warnDigests: {
    team: { id: string; key: string };
    day: string;
    text: string;
    changeSets: { api: string; pullRequest: { repository: string; number: number; url: string }; warnChanges: number }[];
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

/** What a waiting proposal proposes, in Tiehall's words, such as "a proposal to decline it". */
function proposalWhat(view: ProposalView): string {
  const what =
    view.kind === "due_date" && view.change.dueDate !== undefined
      ? view.change.dueDate === null
        ? "remove its due date"
        : `set its due date to ${view.change.dueDate}`
      : view.kind === "reassign" && view.change.team !== undefined
        ? `reassign it to team ${view.change.team.key}`
        : commitmentPhrase(view.kind);
  return `a proposal to ${what}`;
}

/** Who made a waiting proposal, and who confirmed it already, in Tiehall's words. */
function proposalBy(view: ProposalView): string {
  const { proposedBy } = view;
  const through = proposedBy.surface === null ? "" : ` ${THROUGH[proposedBy.surface] ?? ""}`;
  const by =
    proposedBy.actorKind === "agent"
      ? `${person(proposedBy.user)}'s agent${through}`
      : proposedBy.actorKind === "integration"
        ? `${person(proposedBy.user)}${through}`
        : `${person(proposedBy.user)} in the web UI`;
  const confirmed = view.confirmations.received.map(({ user }) => person(user));
  return `Made by ${by}.${confirmed.length === 0 ? "" : ` ${confirmed.join(" and ")} confirmed it already.`}`;
}

/** Who may give the other side's confirmation, in Tiehall's words. */
function otherSide(rules: readonly string[], team: { key: string } | null): string {
  const words: Readonly<Record<string, string>> = {
    target_team: `a member of team ${team?.key ?? ""}`,
    requester_side: `the requesting user or a member of team ${team?.key ?? ""}`,
    claimant: "the claimant",
  };
  return rules.map((rule) => words[rule] ?? rule).join(" and ");
}

/** The confirmations a waiting proposal still needs, in order, the reader's as theirs. */
function proposalNeeds(view: ProposalView, readerId: string): string {
  const { needed, received } = view.confirmations;
  const names = needed
    .filter(({ step }) => !received.some((confirmation) => confirmation.step === step))
    .map(({ user, rules, team }) => (user === null ? otherSide(rules, team) : user.id === readerId ? "you" : person(user)));
  return names.length === 0 ? "It needs no other confirmation." : `It still needs the confirmation of ${names.join(", then ")}.`;
}

/**
 * One proposal that waits for the member, as a card: its request's key,
 * linked to the request's page, when it expires, what it proposes, who
 * proposed it, what it still needs, the link to its review page and the form
 * that rejects it.
 */
function waitingCard(view: ProposalView, csrf: string, readerId: string, now: string): string {
  const what = proposalWhat(view);
  return [
    '        <li class="card waiting-card">',
    `          <p class="card-top">${keyTag(view.request.key, `/${view.request.key}`)}<span class="muted">Expires <time datetime="${escapeHtml(view.expiresAt)}">${escapeHtml(untilWords(view.expiresAt, now))}</time></span></p>`,
    `          <h3>${escapeHtml(`${what.charAt(0).toUpperCase()}${what.slice(1)}`)}</h3>`,
    `          <p>${escapeHtml(proposalBy(view))}</p>`,
    `          <p class="hint">${escapeHtml(proposalNeeds(view, readerId))} It expires on ${utcHtml(view.expiresAt)}.</p>`,
    '          <div class="card-actions">',
    `            <a class="button" href="/confirm/${escapeHtml(view.id)}">Review and confirm</a>`,
    postForm(INBOX_PATH, { action: "reject", proposal: view.id }, csrf, "Reject", "            ", "secondary"),
    "          </div>",
    "        </li>",
  ].join("\n");
}

/** The check mark beside a receipt, which only illustrates it. */
const RECEIPT_MARK =
  '<svg class="receipt-mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M5 12l4 4 10-10"/></svg>';

/** What waits for the member, first on the page: a panel with the signal lamp and the number in words, and a card for each proposal. */
function waitingSection(list: StandingList, csrf: string, readerId: string, now: string): string {
  const count = list.waiting.length;
  return [
    '      <section class="waiting" aria-labelledby="waiting-heading">',
    '        <div class="section-head">',
    ...(count === 0 ? [] : ['          <span class="lamp needs-info blink" aria-hidden="true"></span>']),
    '          <h2 id="waiting-heading">Waiting for you</h2>',
    `          <span class="muted">${escapeHtml(count === 0 ? "nothing waits" : `${count} waiting`)}</span>`,
    "        </div>",
    ...(count === 0
      ? ['        <p class="empty">Nothing waits for your confirmation.</p>']
      : ['        <ul class="cards waiting-cards" id="waiting">', ...list.waiting.map((view) => waitingCard(view, csrf, readerId, now)), "        </ul>"]),
    "      </section>",
  ].join("\n");
}

/** The standing list's other panels: the member's receipts, their reminders, their teams' WARN digests and the declarations to re-confirm. */
function standingSections(list: StandingList, csrf: string, now: string): string[] {
  const receipts = panelHtml(
    "receipts-heading",
    "Receipts",
    list.receipts.length === 0
      ? ['        <p class="empty">No receipts yet.</p>']
      : [
          '        <ul class="receipts" id="receipts">',
          ...list.receipts.map(({ text, undoUntil, proposal: view }) => {
            // Only a commitment's receipt has an undo page; an action's receipt has no proposal.
            const undo =
              undoUntil === null || view === null
                ? ""
                : ` <a class="button secondary" href="/confirm/${escapeHtml(view.id)}/undo">Undo · <time datetime="${escapeHtml(undoUntil)}">${escapeHtml(leftWords(undoUntil, now))}</time></a>`;
            return `          <li class="receipt">${RECEIPT_MARK}<p>${escapeHtml(text)}</p>${undo}</li>`;
          }),
          "        </ul>",
        ],
  );
  const reminders =
    list.reminders.length === 0
      ? []
      : [panelHtml("reminders-heading", "Reminders", ['        <ul class="plain-list" id="reminders">', ...list.reminders.map(({ text }) => `          <li>${escapeHtml(text)}</li>`), "        </ul>"])];
  // Each API's count of WARN-level changes, its name and its pull request, never the changes' text, which the provider's
  // CI wrote; a form dismisses the digest from the reader's own list (decisions-from-groups-15-28, D55 (69), (70)).
  const warnDigests =
    list.warnDigests.length === 0
      ? []
      : [
          panelHtml("warn-digests-heading", "WARN digests", [
            '        <ul class="plain-list" id="warn-digests">',
            ...list.warnDigests.map(({ team, day, text, changeSets }) =>
              [
                "          <li>",
                `            <p>${escapeHtml(text)}</p>`,
                "            <ul>",
                ...changeSets.map(({ api, pullRequest, warnChanges }) =>
                  `              <li>${escapeHtml(`${api} in ${pullRequest.repository}#${pullRequest.number}: ${warnChanges} potentially breaking change${warnChanges === 1 ? "" : "s"}`)} (<a href="${escapeHtml(pullRequest.url)}" rel="noreferrer">the provider pull request</a>)</li>`,
                ),
                "            </ul>",
                postForm(INBOX_PATH, { action: "dismiss_warn_digest", team: team.id, day }, csrf, `Dismiss ${team.key}'s WARN digest of ${day}`, "            ", "secondary"),
                "          </li>",
              ].join("\n"),
            ),
            "        </ul>",
          ]),
        ];
  const reconfirmations =
    list.reconfirmations.length === 0
      ? []
      : [
          panelHtml("reconfirmations-heading", "Declarations to re-confirm", [
            '        <ul class="plain-list" id="reconfirmations">',
            ...list.reconfirmations.map(({ api, team, text }) =>
              [
                "          <li>",
                `            <p>${escapeHtml(text)} ${keyTag(team.key, `/${team.key}`)}</p>`,
                postForm(INBOX_PATH, { action: "reconfirm", api: api.id, team: team.id }, csrf, `Re-confirm that ${team.key} consumes ${api.name}`, "            ", "secondary"),
                "          </li>",
              ].join("\n"),
            ),
            "        </ul>",
          ]),
        ];
  return [receipts, ...reminders, ...warnDigests, ...reconfirmations];
}

export function createInboxRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: INBOX_PATH,
    name: "inbox",
    async get(_query, { read, csrf, shell, caller }) {
      const list = await read<StandingList>(standingList.id, {});
      const feed = await read<UpdatesPage>(readInboxUpdates.id, { limit: INBOX_PAGE_SIZE });
      const now = new Date().toISOString();
      const main = ["      <h1>Inbox</h1>", waitingSection(list, csrf, caller.userId, now), feedSection(feed, csrf, now), ...standingSections(list, csrf, now)];
      return htmlAnswer(htmlPage("Inbox", main.join("\n"), shell));
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
      if (action === "dismiss_warn_digest") {
        // Dismissing a WARN digest changes only the reader's own list, so it needs no confirmation step.
        await write(dismissWarnDigest.id, { team: form.get("team") ?? "", day: form.get("day") ?? "" });
        return seeOther(INBOX_PATH);
      }
      if (action !== "acknowledge") {
        throw new Refusal("invalid-input", "The form acknowledges the updates it shows, rejects a proposal, re-confirms a declaration, or dismisses a WARN digest.");
      }
      const upTo = form.get("upTo") ?? "";
      if (!/^[1-9][0-9]{0,15}$/.test(upTo)) throw new Refusal("invalid-input", "The form names the last update it shows by its number.");
      await write(readInboxUpdates.id, { acknowledge: Number(upTo), limit: 1 });
      return seeOther(INBOX_PATH);
    },
  });
}

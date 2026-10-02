import { createHash, randomUUID } from "node:crypto";
import { formatRequestKey, isTerminalState, REQUEST_STATES, type RequestState } from "@tiehall/core";
import { events, eventSequence, mirrors, requests, teams, trackerMappings, type Database } from "@tiehall/db";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ServerText } from "./email.ts";
import { createGitHubIssues } from "./github-issues.ts";
import { createLogger, type Logger } from "./log.ts";
import { mirrorRequest } from "./mirror-jobs.ts";
import { mirrorSummary, mirrorTitle, questionComment, stateComment, stateLabel, type MirrorSummary } from "./mirror-texts.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob, WorkerServices } from "./worker.ts";

// The tracker mirrors (tracker-mirrors: A mirror is a projection of the
// request; tracker-mirrors: Mirror writes are idempotent and never echo;
// tracker-mirrors: Mirror issues are created on claim by default; design.md,
// Design rules: Tracker mirrors; design.md, Technical decisions: T16). Tiehall
// is the source of truth for a request, and a tracker issue is a projection
// of it. This module knows no tracker: each tracker has an adapter, which
// creates, finds, changes and reads issues in its own terms (GitHub Issues
// now, Jira Cloud later, and others after v1), and the module decides what to
// write, so every tracker mirrors by the same rules.
//
// The mirror job (mirror-jobs.ts) is level-triggered: it carries only the
// request's id, reads the request as it is when it runs, and makes the issue
// show it. A job that runs late, twice or out of order is harmless, and many
// changes that land before a job runs cost one write. The jobs of one request
// run one at a time, so no two of them write its issue together.
// - Which issue: the one in the place its target team's mapping names (for
//   GitHub, the intake repository). A request gets one once it has been
//   claimed, or from its opening when the team mirrors on open, unless it has
//   ended; a team with no mapping gets none, and an issue whose team's
//   mapping no longer names its place is left as it is.
// - Creating it: the job writes the mirror's row, with a random marker, and
//   commits it before it asks the tracker to create the issue, which carries
//   the marker. When the create fails after the tracker made the issue, such
//   as when the tracker's answer never arrives, the job's retry finds the row
//   with no issue yet, asks the tracker for an issue that carries the marker,
//   and takes that one: a retried create never makes a second issue.
// - Updating it: the row keeps digests of the title and body Tiehall last
//   wrote, the state label it last set, and whether it left the issue open
//   or closed, and why; the job writes only what differs from them, so when
//   nothing the mirror shows has changed, it writes nothing at all. A request
//   that is done closes its issue as completed, one that is declined or
//   withdrawn closes it as not planned, and a decline undone reopens it.
// - Comments (tracker-mirrors: One comment per state change and per question
//   notice): each write that changed the request's state, or posted a
//   question on it, adds one comment Tiehall writes, naming the new state or
//   saying that a question waits, with the request's link, never the
//   question's text. The job reads the request's events after the last one
//   its comments cover, and tells one write from the next by their
//   transaction's time, which every event of a write shares; so a blocking
//   question and the move to needs_info it causes are one comment, and
//   changes that land before a job runs still get one comment each, in
//   order. Each comment, like a create, has a marker written before the call
//   and carried by the comment, so a retried comment is found, not made
//   twice.
// - Echoes: a change Tiehall makes in the tracker comes back as a webhook
//   delivery, a poll or a reconciliation, like a change a person makes. The
//   row keeps what the issue shows as far as Tiehall knows, and, while a write
//   is under way, what that write will leave it showing; a change read from
//   the tracker that shows either is Tiehall's own, and is dropped
//   (trackerChanges()).
// Nothing a person wrote in Tiehall reaches the issue but the request's
// title: its summary and label are server text (mirror-texts.ts).

/** The trackers v1 mirrors into. */
export const TRACKERS = ["github", "jira"] as const;
export type Tracker = (typeof TRACKERS)[number];

/** What a mirror issue shows of its request, as the job makes it from the request now. */
export interface MirrorProjection {
  /** The issue's title: the request's key and title. */
  title: string;
  /** The body Tiehall writes: which request it mirrors, and its link. */
  summary: MirrorSummary;
  /** The label that names the request's state. */
  label: ServerText;
  /** The request's state, which the label names. */
  state: RequestState;
  /** Whether the issue is open: until the request ends. */
  open: boolean;
  /** Why the issue is closed: completed for a request that is done, not planned for one declined or withdrawn; null while open. */
  closeReason: "completed" | "not_planned" | null;
}

/** Why a tracker says a closed issue was closed. */
export type CloseReason = "completed" | "not_planned" | "duplicate";

/** An account in the tracker, by the tracker's own id and the name it shows. */
export interface TrackerAccount {
  id: string;
  login: string;
}

/** What an issue shows that Tiehall reads back: whether it is open, why it was closed, and whom it is assigned to. */
export interface IssueState {
  open: boolean;
  /** Why it was closed, for a closed issue; null for an open one. */
  closeReason: CloseReason | null;
  /** Its assignees, in the tracker's order. */
  assignees: readonly TrackerAccount[];
}

/** An issue as the tracker shows it now, with who closed it, for a closed issue whose tracker says. */
export interface IssueNow extends IssueState {
  closedBy: TrackerAccount | null;
}

/** What a mirror job changes on an issue: only the parts given. */
export interface IssueUpdate {
  title?: string;
  summary?: MirrorSummary;
  /** The state label to add, and the one Tiehall set before, which it takes off. */
  label?: { add: ServerText; remove: ServerText | null };
  /** Whether the issue is open, and why it is closed. */
  state?: { open: boolean; closeReason: "completed" | "not_planned" | null };
}

/**
 * A tracker, as the mirror job reaches it. Every call acts as Tiehall's own
 * account in the tracker, and a failure throws, which fails the job, so the
 * queue tries it again.
 */
export interface TrackerAdapter {
  readonly tracker: Tracker;
  /** The issue in this place that a create carrying this marker made, if any, looking among the issues made since then. */
  findCreated(target: string, marker: string, since: Date): Promise<string | undefined>;
  /** Creates the issue, carrying the marker, and returns the tracker's reference of it. */
  createIssue(target: string, projection: MirrorProjection, marker: string): Promise<string>;
  /** Changes what Tiehall shows on the issue, whose body keeps carrying the mirror's marker. */
  updateIssue(target: string, issue: string, marker: string, update: IssueUpdate): Promise<void>;
  /** The issue as the tracker shows it now; undefined when the tracker no longer has it. */
  readIssue(target: string, issue: string): Promise<IssueNow | undefined>;
  /** Adds a comment to the issue, carrying the marker. */
  addComment(target: string, issue: string, text: ServerText, marker: string): Promise<void>;
  /** Whether the issue has a comment carrying this marker, looking among the comments made since then. */
  findComment(target: string, issue: string, marker: string, since: Date): Promise<boolean>;
}

/** What Tiehall last wrote to a mirror issue: digests of its title and body, its state label, and whether it left it open or closed, and why. */
export interface Pushed {
  title: string;
  body: string;
  label: string;
  open: boolean;
  closeReason: "completed" | "not_planned" | null;
}

/** The comment under way on a mirror issue: the last event it covers, the state it names, its marker, and when it started. */
export interface PendingComment {
  through: number;
  state: RequestState;
  marker: string;
  at: string;
}

/** A mirror's row, as the job reads it. */
export interface MirrorRow {
  id: string;
  requestId: string;
  teamId: string;
  tracker: Tracker;
  target: string;
  issue: string | null;
  marker: string;
  createdAt: Date;
  pushed: Pushed | null;
  trackerState: IssueState | null;
  expectedState: Pick<IssueState, "open" | "closeReason"> | null;
  commentedThrough: number;
  shownState: RequestState | null;
  pendingComment: PendingComment | null;
}

/** A team's mapping, as the job reads it: the tracker, the place, and whether it mirrors on open. */
export interface MirrorMapping {
  tracker: Tracker;
  target: string;
  mirrorOnOpen: boolean;
}

/** A request, as its mirror shows it. */
interface MirroredRequest {
  id: string;
  key: string;
  title: string;
  state: RequestState;
  /** Whether it has been claimed: it is claimed now, or was claimed once and released. */
  claimed: boolean;
  targetTeamId: string;
  targetKey: string;
  requestingKey: string;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The body Tiehall writes, as one text, for its digest. */
function bodyText(summary: MirrorSummary): string {
  return [...summary.paragraphs, summary.link].join("\n");
}

/** What a mirror issue shows of the request, from the request as it is now. */
export function projectionOf(request: MirroredRequest, installUrl: string): MirrorProjection {
  return {
    title: mirrorTitle(request.key, request.title),
    summary: mirrorSummary({ installUrl, key: request.key, targetTeam: request.targetKey, requestingTeam: request.requestingKey }),
    label: stateLabel(request.state),
    state: request.state,
    open: !isTerminalState(request.state),
    closeReason: request.state === "done" ? "completed" : isTerminalState(request.state) ? "not_planned" : null,
  };
}

/** The record of what a write of this projection leaves on the issue. */
export function pushedOf(projection: MirrorProjection): Pushed {
  return {
    title: digest(projection.title),
    body: digest(bodyText(projection.summary)),
    label: projection.label,
    open: projection.open,
    closeReason: projection.closeReason,
  };
}

/** What differs between what Tiehall last wrote and the projection now; undefined when nothing does. */
export function updateOf(pushed: Pushed | null, projection: MirrorProjection): IssueUpdate | undefined {
  const now = pushedOf(projection);
  const update: IssueUpdate = {};
  if (pushed?.title !== now.title) update.title = projection.title;
  if (pushed?.body !== now.body) update.summary = projection.summary;
  if (pushed?.label !== now.label) update.label = { add: projection.label, remove: (pushed?.label as ServerText | undefined) ?? null };
  if (pushed?.open !== now.open || pushed.closeReason !== now.closeReason) update.state = { open: projection.open, closeReason: projection.closeReason };
  return Object.keys(update).length === 0 ? undefined : update;
}

/** A change made in the tracker to a mirror issue, which Tiehall records. */
export type TrackerChange =
  | { kind: "closed"; reason: CloseReason }
  | { kind: "reopened" }
  | { kind: "assignees_changed"; assignees: readonly TrackerAccount[] };

function sameState(a: Pick<IssueState, "open" | "closeReason">, b: Pick<IssueState, "open" | "closeReason">): boolean {
  return a.open === b.open && (a.open || a.closeReason === b.closeReason);
}

function sameAssignees(a: readonly TrackerAccount[], b: readonly TrackerAccount[]): boolean {
  const ids = new Set(a.map(({ id }) => id));
  return a.length === b.length && b.every(({ id }) => ids.has(id));
}

/**
 * The changes made in the tracker that an issue read now shows, against what
 * Tiehall knows the issue shows and what a write of its own under way will
 * leave it showing. A read that shows what Tiehall wrote, or is writing, is
 * Tiehall's own change coming back, an echo, and gives none; so does a read
 * that shows nothing new.
 */
export function trackerChanges(known: IssueState, expected: Pick<IssueState, "open" | "closeReason"> | null, now: IssueState): TrackerChange[] {
  const changes: TrackerChange[] = [];
  const own = expected !== null && sameState(now, expected);
  if (!own && !sameState(now, known)) changes.push(now.open ? { kind: "reopened" } : { kind: "closed", reason: now.closeReason ?? "completed" });
  if (!sameAssignees(now.assignees, known.assignees)) changes.push({ kind: "assignees_changed", assignees: now.assignees });
  return changes;
}

/** A mirror's row as stored, typed. */
function mirrorRowOf(row: typeof mirrors.$inferSelect): MirrorRow {
  return {
    id: row.id,
    requestId: row.requestId,
    teamId: row.teamId,
    tracker: row.tracker as Tracker,
    target: row.target,
    issue: row.issue,
    marker: row.marker,
    createdAt: row.createdAt,
    pushed: row.pushed as Pushed | null,
    trackerState: row.trackerState as IssueState | null,
    expectedState: row.expectedState as MirrorRow["expectedState"],
    commentedThrough: row.commentedThrough,
    shownState: row.shownState as RequestState | null,
    pendingComment: row.pendingComment as PendingComment | null,
  };
}

/** An event of the request, as the comments read it: its number, type and data, and its transaction's time, which groups one write's events. */
export interface RequestEvent {
  number: number;
  type: string;
  data: Readonly<Record<string, unknown>>;
  /** The time of the transaction that recorded it, exactly as stored: every event of one write has the same. */
  at: string;
}

/** What one write did to a mirrored request, as its comment tells it. */
export interface WriteSeen {
  /** The number of the write's last event, which the mirror's comments then cover. */
  through: number;
  /** The request's state after the write. */
  state: RequestState;
  /** Whether the write changed the request's state. */
  changed: boolean;
  /** Whether the write posted a question. */
  question: boolean;
}

/** The state an event leaves the request in, from the state before it; the state before for an event that changes none. */
function stateAfter(event: RequestEvent, before: RequestState): RequestState {
  switch (event.type) {
    case "request.claimed":
      return "claimed";
    case "request.started":
      return "in_progress";
    case "request.released":
      // A release while the request waits on questions keeps it waiting.
      return before === "needs_info" ? "needs_info" : "open";
    case "request.state_changed":
      return (REQUEST_STATES as readonly string[]).includes(String(event.data["state"])) ? (event.data["state"] as RequestState) : before;
    default:
      return before;
  }
}

/**
 * What each write after the ones a mirror's comments cover did to its
 * request, in order, from the request's events: one entry per write, whose
 * events share their transaction's time, with the state it left the request
 * in, whether it changed the state, and whether it posted a question.
 */
export function writesOf(events: readonly RequestEvent[], shown: RequestState): WriteSeen[] {
  const writes: WriteSeen[] = [];
  let state = shown;
  for (let index = 0; index < events.length; ) {
    const at = events[index]?.at;
    const before = state;
    let question = false;
    let through = 0;
    for (; index < events.length && events[index]?.at === at; index += 1) {
      const event = events[index]!;
      state = stateAfter(event, state);
      if (event.type === "request.message_posted" && event.data["kind"] === "question") question = true;
      through = event.number;
    }
    writes.push({ through, state, changed: state !== before, question });
  }
  return writes;
}

/** What the job reads first: the request, its target team's mapping, its mirror in the place that mapping names, and its events since the comments. */
interface MirrorPlan {
  request: MirroredRequest;
  mapping: MirrorMapping | undefined;
  mirror: MirrorRow | undefined;
  /** The number of the install's last event when the job read, which every event of the request it read is at or before. */
  latest: number;
  /** The request's events after the ones the mirror's comments cover, up to the latest, oldest first. */
  events: RequestEvent[];
}

/** The request, its target team's mapping, its mirror in the place that mapping names, and its events since, as the job reads them now. */
async function planOf(context: OrgContext, requestId: string): Promise<MirrorPlan | undefined> {
  const { tx, orgId } = context;
  // The last event number first: every committed event of the request is at or before it, as the sequence's row is
  // held until its writer commits, so the events read below up to it are all the request has, and none is skipped.
  const [sequence] = await tx.select({ lastNumber: eventSequence.lastNumber }).from(eventSequence).where(eq(eventSequence.orgId, orgId));
  const latest = sequence?.lastNumber ?? 0;
  const target = alias(teams, "target_team");
  const requesting = alias(teams, "requesting_team");
  const [row] = await tx
    .select({ request: requests, targetKey: target.key, requestingKey: requesting.key })
    .from(requests)
    .innerJoin(target, and(eq(target.orgId, requests.orgId), eq(target.id, requests.targetTeamId)))
    .innerJoin(requesting, and(eq(requesting.orgId, requests.orgId), eq(requesting.id, requests.requestingTeamId)))
    .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));
  if (row === undefined) return undefined;
  const request: MirroredRequest = {
    id: row.request.id,
    key: formatRequestKey(row.targetKey, row.request.number),
    title: row.request.title,
    state: row.request.state as RequestState,
    claimed: row.request.claimantUserId !== null || row.request.claimedAt !== null,
    targetTeamId: row.request.targetTeamId,
    targetKey: row.targetKey,
    requestingKey: row.requestingKey,
  };
  const [mapped] = await tx
    .select({ tracker: trackerMappings.tracker, target: trackerMappings.target, mirrorOnOpen: trackerMappings.mirrorOnOpen })
    .from(trackerMappings)
    .where(and(eq(trackerMappings.orgId, orgId), eq(trackerMappings.teamId, request.targetTeamId)));
  const mapping = mapped === undefined ? undefined : { tracker: mapped.tracker as Tracker, target: mapped.target, mirrorOnOpen: mapped.mirrorOnOpen };
  if (mapping === undefined) return { request, mapping, mirror: undefined, latest, events: [] };
  const [found] = await tx
    .select()
    .from(mirrors)
    .where(
      and(
        eq(mirrors.orgId, orgId),
        eq(mirrors.requestId, requestId),
        eq(mirrors.teamId, request.targetTeamId),
        eq(mirrors.tracker, mapping.tracker),
        eq(mirrors.target, mapping.target),
      ),
    );
  const mirror = found === undefined ? undefined : mirrorRowOf(found);
  if (mirror?.issue === null || mirror?.issue === undefined || mirror.shownState === null) return { request, mapping, mirror, latest, events: [] };
  const rows = await tx
    .select({ number: events.number, type: events.type, data: events.data, at: sql<string>`${events.occurredAt}::text` })
    .from(events)
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.class, "domain"),
        gt(events.number, mirror.commentedThrough),
        lte(events.number, latest),
        sql`${events.data} ->> 'requestId' = ${requestId}`,
      ),
    )
    .orderBy(asc(events.number));
  return { request, mapping, mirror, latest, events: rows.map((event) => ({ ...event, data: event.data as Record<string, unknown> })) };
}

/** The trackers' adapters the job writes through, by tracker; a tracker with none is not written to. */
export type TrackerAdapters = Partial<Record<Tracker, TrackerAdapter>>;

export interface MirrorServices {
  /** The app's database, as the app role. */
  database: Database;
  adapters: TrackerAdapters;
  /** The install's URL (TIEHALL_URL), which the request's link starts with. */
  installUrl: string;
  logger?: Logger;
}

/** How far back from a create's or a comment's start a retry looks for what it may have made, for clocks that differ. */
const CREATE_LOOKBACK_MS = 10 * 60_000;

/** Stores what a mirror job learned or did, on the mirror's row, in a short transaction of its own. */
async function saveMirror(database: Database, mirrorId: string, changes: Partial<typeof mirrors.$inferInsert>): Promise<void> {
  await withOrg(database, async ({ tx, orgId }) => {
    await tx.update(mirrors).set(changes).where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)));
  });
}

/** The comment a write gets, in Tiehall's words; undefined for a write that changed no state and asked nothing. */
function commentOf(write: WriteSeen, key: string, link: ServerText): ServerText | undefined {
  if (write.question) return questionComment({ key, link, ...(write.changed ? { state: write.state } : {}) });
  return write.changed ? stateComment({ key, state: write.state, link }) : undefined;
}

/**
 * Brings the request's mirror issue up to date with the request as it is
 * now: creates it, once, when the request should have one; adds one comment
 * for each write that changed its state or asked a question since the
 * comments it has; and writes what changed since Tiehall last wrote it, or
 * nothing.
 */
export async function syncMirror(services: MirrorServices, requestId: string): Promise<void> {
  const logger = (services.logger ?? createLogger()).child({ job: mirrorRequest.name, requestId });
  const plan = await withOrg(services.database, (context) => planOf(context, requestId), { readOnly: true });
  if (plan?.mapping === undefined) return;
  const { request, mapping } = plan;
  const adapter = services.adapters[mapping.tracker];
  if (adapter === undefined) {
    logger.warn("mirror: no adapter for the team's tracker, so nothing is written", { tracker: mapping.tracker });
    return;
  }
  const projection = projectionOf(request, services.installUrl);
  let mirror = plan.mirror;
  let fresh = false;
  if (mirror === undefined) {
    // A request gets its mirror issue once claimed, or from its opening when the team mirrors on open, unless it has ended.
    if (isTerminalState(request.state) || !(request.claimed || mapping.mirrorOnOpen)) return;
    mirror = await withOrg(services.database, async ({ tx, orgId }) => {
      await tx
        .insert(mirrors)
        .values({ orgId, requestId, teamId: request.targetTeamId, tracker: mapping.tracker, target: mapping.target })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(mirrors)
        .where(
          and(
            eq(mirrors.orgId, orgId),
            eq(mirrors.requestId, requestId),
            eq(mirrors.teamId, request.targetTeamId),
            eq(mirrors.tracker, mapping.tracker),
            eq(mirrors.target, mapping.target),
          ),
        );
      if (row === undefined) throw new Error("The mirror's row was not found after it was written.");
      return mirrorRowOf(row);
    });
    fresh = true;
  }

  if (mirror.issue === null) {
    // The row and its marker are committed: a create retried after the tracker made the issue finds it by the marker.
    const found = fresh ? undefined : await adapter.findCreated(mirror.target, mirror.marker, new Date(mirror.createdAt.getTime() - CREATE_LOOKBACK_MS));
    const issue = found ?? (await adapter.createIssue(mirror.target, projection, mirror.marker));
    const known: IssueState = { open: true, closeReason: null, assignees: [] };
    // The issue shows the request as it was read, so its comments start after every event that read covered.
    await withOrg(services.database, async ({ tx, orgId }) => {
      await tx
        .update(mirrors)
        .set({ issue, issueCreatedAt: sql`now()`, pushed: pushedOf(projection), trackerState: known, commentedThrough: plan.latest, shownState: request.state })
        .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirror.id), isNull(mirrors.issue)));
    });
    logger.info(found === undefined ? "mirror: created the mirror issue" : "mirror: found the mirror issue a create made before", { mirrorId: mirror.id });
    return;
  }
  const issue = mirror.issue;
  const { id: mirrorId, target, marker } = mirror;

  if (mirror.shownState === null) {
    // A mirror made before its comments were kept: they start from the request as it is now.
    await saveMirror(services.database, mirrorId, { commentedThrough: plan.latest, shownState: request.state });
  }
  // One comment per write that changed the request's state or asked a question, in order.
  let written = false;
  for (const write of writesOf(plan.events, mirror.shownState ?? request.state)) {
    const text = commentOf(write, request.key, projection.summary.link);
    if (text !== undefined) {
      const pending = mirror.pendingComment?.through === write.through ? mirror.pendingComment : undefined;
      const made = pending !== undefined && (await adapter.findComment(target, issue, pending.marker, new Date(Date.parse(pending.at) - CREATE_LOOKBACK_MS)));
      if (!made) {
        const comment: PendingComment = pending ?? { through: write.through, state: write.state, marker: randomUUID(), at: new Date().toISOString() };
        await saveMirror(services.database, mirrorId, { pendingComment: comment });
        await adapter.addComment(target, issue, text, comment.marker);
      }
      written = true;
    }
    await saveMirror(services.database, mirrorId, { commentedThrough: write.through, shownState: write.state, pendingComment: null });
  }

  const update = updateOf(mirror.pushed, projection);
  // Nothing the mirror shows has changed since Tiehall last wrote it: nothing more is written.
  if (update === undefined) {
    if (written) logger.info("mirror: commented on the mirror issue", { mirrorId });
    return;
  }
  // A change of the issue's state, read back meanwhile, is this write's own.
  if (update.state !== undefined) await saveMirror(services.database, mirrorId, { expectedState: update.state });
  await adapter.updateIssue(target, issue, marker, update);
  const known: IssueState = mirror.trackerState ?? { open: true, closeReason: null, assignees: [] };
  await saveMirror(services.database, mirrorId, {
    pushed: pushedOf(projection),
    ...(update.state === undefined ? {} : { trackerState: { ...known, ...update.state }, expectedState: null }),
  });
  logger.info("mirror: updated the mirror issue", { mirrorId });
}

/** The trackers' adapters the worker writes through: GitHub Issues, as the install's App, once an App is stored. */
export async function adaptersOf(services: Pick<WorkerServices, "database" | "github">): Promise<TrackerAdapters> {
  const app = await services.github?.app();
  return app === undefined ? {} : { github: createGitHubIssues({ app, database: services.database }) };
}

/** The worker's mirror job: brings one request's mirror issue up to date. */
export const mirrorRequests: WorkerJob<{ requestId: string }> = {
  type: mirrorRequest,
  concurrency: 4,
  async handle(job, services) {
    if (services.installUrl === undefined) throw new Error("The worker gives this job no install URL to link the request with.");
    try {
      await syncMirror({ database: services.database, adapters: await adaptersOf(services), installUrl: services.installUrl }, job.data.requestId);
    } catch (error) {
      // Before setup completes there is no request to mirror.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};

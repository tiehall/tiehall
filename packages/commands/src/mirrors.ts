import { createHash, randomUUID } from "node:crypto";
import { formatRequestKey, isTerminalState, REQUEST_STATES, type RequestState } from "@tiehall/core";
import { apis, contractChangeRequests, contractChangeSets, events, eventSequence, mirrors, requests, teams, trackerMappings, type Database } from "@tiehall/db";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { installLink, type ServerText } from "./email.ts";
import { createGitHubIssues } from "./github-issues.ts";
import { createLogger, type Logger } from "./log.ts";
import { clearMirrorFailure, recordMirrorFailure } from "./mirror-failures.ts";
import { mirrorRequest } from "./mirror-jobs.ts";
import { awayComment, backComment, mirrorSummary, mirrorTitle, questionComment, stateComment, stateLabel, type MirrorSummary } from "./mirror-texts.ts";
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
// - Which issue: the one its target team's mapping made, in the place it
//   names (for GitHub, the intake repository), for the request's key in that
//   team. A request gets one once it reached the team's point after the
//   mapping was made: a claim there, or, when the team mirrors on open, its
//   opening or its move into the team; nothing is filled in for a request
//   that reached it before, and none is made for one that has ended
//   (decisions-from-groups-15-28: design.md, Decisions this change rests on:
//   D55 (75)). A team with no mapping gets none. "After" is by commit: the
//   event of the claim, opening or move is numbered after the last event the
//   mapping recorded when it was made (tracker-mappings.ts), which is exactly
//   when the write that recorded it saw the mapping and sent the mirror job;
//   for a mapping made before it recorded one, its time is compared instead.
// - Whose issue: each issue keeps the mapping that made it, and Tiehall
//   writes to it only while that mapping holds. A removed mapping's issues
//   are left as people leave them, a reassignment's notice included, and a
//   later mapping of the team, even to the same place, makes issues of its
//   own. A mirror made before mirrors kept their mapping belongs to its
//   team's mapping of the same place that was made before it. Every write to
//   an issue first checks that its mapping holds, so a mapping removed while
//   a job runs stops the job's writes after the one under way.
// - Reassignment (tracker-mirrors: Reassignment moves the mirror): a request
//   reassigned to another team gets a key there, and with it a mirror in
//   that team's tracker under that team's rule; it is open and unclaimed
//   there, so a team that mirrors on claim waits for a claim made since the
//   reassignment. The issue it left behind gets the comments of the writes
//   before the one that took the request away, then one notice of the
//   reassignment, or of its undoing when that took the request away, and is
//   closed as not planned; it then follows the request no more, and Tiehall
//   leaves it as people leave it. A mirror whose create was under way when
//   the reassignment took the request away is looked for by its marker: the
//   issue the tracker made is left the same way, and when it made none,
//   there is nothing to leave. An undone reassignment gives the request its
//   old key back, and so its old issue, which gets one notice of the undo
//   and is reopened with the label of the restored state. A reassignment and
//   its undo that both land before a job runs leave nothing on the old
//   issue. A later reassignment back to the old team, which is no undo,
//   gives the request a new key there, and so a new issue.
// - Creating it: the job writes the mirror's row, with a random marker and a
//   record of what the create writes (an open issue that shows the request as
//   the job read it, whose comments start after the events that read
//   covered), and commits it before it asks the tracker to create the issue,
//   which carries the marker. When the create fails after the tracker made
//   the issue, such as when the tracker's answer never arrives, the job's
//   retry finds the row with no issue yet, asks the tracker for an issue that
//   carries the marker, and takes that one: a retried create never makes a
//   second issue. The issue it finds shows what the row recorded, so the
//   retry brings it up to date from there as any update does, with a comment
//   for each write since and the label and state of the request now, which
//   closes it when the request ended meanwhile. A retry that finds none makes
//   the issue from the request as it is now, or none for a request that no
//   longer gets one, such as one that ended meanwhile.
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
//   (trackerChanges()). A write of the issue's state changes only the state
//   of what Tiehall knows, so assignees read meanwhile stay, and it counts on
//   the row as it begins and as it ends: a read taken before either and
//   recorded after may show the issue as it was before the write, so its
//   state is not compared, and a later read shows it (tracker-changes.ts).
// - Shipped (contract-changes: Merging the provider PR marks the change
//   shipped): when the provider pull request of a contract-change request's
//   change set merges, the event that records it wakes the job, and the
//   summary says the change shipped, naming the pull request; that changes
//   no state, so it adds no comment.
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
  /** The request's number in the team when the mirror was made; null for a mirror made before reassignments moved mirrors. */
  number: number | null;
  /** Whether a reassignment left the issue behind, so it follows the request no more. */
  away: boolean;
  /** The id of the mapping that made it; null for a mirror made before mirrors kept it, or under a mapping with no id. */
  mappingId: string | null;
  /** Whether the mapping that made it holds still: only then does Tiehall write to its issue. */
  mapped: boolean;
}

/** A team's mapping, as the job reads it: its id, the tracker, the place, whether it mirrors on open, and when it was made. */
export interface MirrorMapping {
  /** Null for a mapping made before mirrors kept the mapping that made them. */
  id: string | null;
  tracker: Tracker;
  target: string;
  mirrorOnOpen: boolean;
  /** When it was made, exactly as stored. */
  createdAt: string;
  /** The number of the org's last event when it was made; null for a mapping made before the number was kept. */
  madeAfterEvent: number | null;
}

/** A request, as its mirror shows it. */
interface MirroredRequest {
  id: string;
  key: string;
  /** Its number in its target team. */
  number: number;
  title: string;
  state: RequestState;
  targetTeamId: string;
  targetKey: string;
  requestingKey: string;
  /** For a contract-change request whose provider pull request merged: that pull request, which shipped the change it follows. */
  shipped: { repository: string; number: number } | undefined;
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
    summary: mirrorSummary({ installUrl, key: request.key, targetTeam: request.targetKey, requestingTeam: request.requestingKey, shipped: request.shipped }),
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

/** What an issue Tiehall made shows, as far as it knows, until it reads it back: open, and assigned to nobody. */
const AS_MADE: IssueState = { open: true, closeReason: null, assignees: [] };

/**
 * What the mirror's row records before it asks the tracker to create the
 * issue: what the create writes, an open issue that shows this projection,
 * and that its comments start after every event the job read. A retry that
 * finds the issue the create made takes it from here, so it brings the issue
 * up to date from what it shows, not from what the request shows now.
 */
function createdOf(projection: MirrorProjection, plan: Pick<MirrorPlan, "latest">): { pushed: Pushed; commentedThrough: number; shownState: RequestState } {
  return { pushed: { ...pushedOf(projection), open: true, closeReason: null }, commentedThrough: plan.latest, shownState: projection.state };
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

/** A mirror's row as stored, typed, with whether the mapping that made it holds still. */
function mirrorRowOf(row: typeof mirrors.$inferSelect, mapped: boolean): MirrorRow {
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
    number: row.number,
    away: row.away,
    mappingId: row.mappingId,
    mapped,
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

/** A reassignment a write made: the team it moved the request to, and the one it moved it from. */
export interface MoveSeen {
  teamId: string;
  previousTeamId: string;
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
  /** The reassignments it made, or undid: at most one. */
  moves: MoveSeen[];
  /** Whether it undid a commitment, such as a reassignment. */
  undone: boolean;
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
    let undone = false;
    const moves: MoveSeen[] = [];
    let through = 0;
    for (; index < events.length && events[index]?.at === at; index += 1) {
      const event = events[index]!;
      state = stateAfter(event, state);
      if (event.type === "request.message_posted" && event.data["kind"] === "question") question = true;
      if (event.type === "proposal.undone") undone = true;
      if (event.type === "request.reassigned" && typeof event.data["teamId"] === "string" && typeof event.data["previousTeamId"] === "string") {
        moves.push({ teamId: event.data["teamId"], previousTeamId: event.data["previousTeamId"] });
      }
      through = event.number;
    }
    writes.push({ through, state, changed: state !== before, question, moves, undone });
  }
  return writes;
}

/**
 * What the job reads first: the request, its target team's mapping, its
 * mirror in the place that mapping names for its key there, the mirror issues
 * a reassignment left behind that have not had their notice yet, and the
 * request's events since the earliest of their comments.
 */
interface MirrorPlan {
  request: MirroredRequest;
  mapping: MirrorMapping | undefined;
  /**
   * Whether the request reached its team's point since the team's mapping was
   * made: a claim there that it holds now, or that came after its last
   * reassignment, or, when the team mirrors on open, its opening or its move
   * into the team. False when the team maps no tracker.
   */
  reached: boolean;
  mirror: MirrorRow | undefined;
  /** The mirror issues of the request in other teams, or under another key of its team, that still follow it, made or with their create under way: a reassignment left them. */
  leftBehind: MirrorRow[];
  /** The number of the install's last event when the job read, which every event of the request it read is at or before. */
  latest: number;
  /** The request's events after the ones the mirrors' comments cover, up to the latest, oldest first. */
  events: RequestEvent[];
  /** The keys of the teams the mirrors and the events name, by id. */
  teamKeys: ReadonlyMap<string, string>;
}

/**
 * A mirror joined with the mapping that made it, while that mapping holds:
 * its team's mapping whose id it keeps, or, for a mirror that keeps none, its
 * team's mapping of the same place that was made before it.
 */
export function madeBy(): SQL | undefined {
  return and(
    eq(trackerMappings.orgId, mirrors.orgId),
    eq(trackerMappings.teamId, mirrors.teamId),
    eq(trackerMappings.tracker, mirrors.tracker),
    eq(trackerMappings.target, mirrors.target),
    or(eq(trackerMappings.id, mirrors.mappingId), and(isNull(mirrors.mappingId), lte(trackerMappings.createdAt, mirrors.createdAt))),
  );
}

/** The team's mapping the job read, if it holds still: by its id, or, for one with no id, by when it was made. */
function isMapping(mapping: MirrorMapping): SQL | undefined {
  return mapping.id === null
    ? and(isNull(trackerMappings.id), sql`${trackerMappings.createdAt} = ${mapping.createdAt}::timestamptz`)
    : eq(trackerMappings.id, mapping.id);
}

/** Thrown before a write to an issue whose mapping was removed while the job ran: the job writes nothing more to it. */
class MappingRemoved extends Error {
  override name = "MappingRemoved";
  readonly mirrorId: string;
  constructor(mirrorId: string) {
    super("The mapping that made this mirror was removed, so Tiehall writes nothing more to its issue.");
    this.mirrorId = mirrorId;
  }
}

/** Throws MappingRemoved unless the mapping that made the mirror holds still: every write to its issue asks first. */
async function assertMapped(database: Database, mirrorId: string): Promise<void> {
  const held = await withOrg(
    database,
    async ({ tx, orgId }) => {
      const [row] = await tx
        .select({ id: mirrors.id })
        .from(mirrors)
        .innerJoin(trackerMappings, madeBy())
        .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)));
      return row !== undefined;
    },
    { readOnly: true },
  );
  if (!held) throw new MappingRemoved(mirrorId);
}

/** Whether the mirror row is in the place a mapping names, for this key of the request in this team. */
function isCurrent(row: MirrorRow, request: MirroredRequest, mapping: MirrorMapping): boolean {
  return (
    row.teamId === request.targetTeamId &&
    row.tracker === mapping.tracker &&
    row.target === mapping.target &&
    (row.number === null || row.number === request.number)
  );
}

/** Whether a reassignment left the mirror row behind: its issue is of another team, or of an earlier key of the request in its team. */
function isLeftBehind(row: MirrorRow, request: MirroredRequest): boolean {
  return row.teamId !== request.targetTeamId || (row.number !== null && row.number !== request.number);
}

/** The request, its target team's mapping, its mirrors, and its events since, as the job reads them now. */
async function planOf(context: OrgContext, requestId: string): Promise<MirrorPlan | undefined> {
  const { tx, orgId } = context;
  // The last event number first: every committed event of the request is at or before it, as the sequence's row is
  // held until its writer commits, so the events read below up to it are all the request has, and none is skipped.
  const [sequence] = await tx.select({ lastNumber: eventSequence.lastNumber }).from(eventSequence).where(eq(eventSequence.orgId, orgId));
  const latest = sequence?.lastNumber ?? 0;
  const target = alias(teams, "target_team");
  const requesting = alias(teams, "requesting_team");
  // The request with its target team's mapping, read together: the mapping's time is kept exactly as stored, as a
  // mapping made before it kept the number of its last event has the request's events compared with its time.
  const [row] = await tx
    .select({
      request: requests,
      targetKey: target.key,
      requestingKey: requesting.key,
      mappingId: trackerMappings.id,
      tracker: trackerMappings.tracker,
      place: trackerMappings.target,
      mirrorOnOpen: trackerMappings.mirrorOnOpen,
      mappedAt: sql<string | null>`${trackerMappings.createdAt}::text`,
      madeAfterEvent: trackerMappings.madeAfterEvent,
    })
    .from(requests)
    .innerJoin(target, and(eq(target.orgId, requests.orgId), eq(target.id, requests.targetTeamId)))
    .innerJoin(requesting, and(eq(requesting.orgId, requests.orgId), eq(requesting.id, requests.requestingTeamId)))
    .leftJoin(trackerMappings, and(eq(trackerMappings.orgId, requests.orgId), eq(trackerMappings.teamId, requests.targetTeamId)))
    .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));
  if (row === undefined) return undefined;
  const mapping: MirrorMapping | undefined =
    row.tracker === null || row.place === null || row.mirrorOnOpen === null || row.mappedAt === null
      ? undefined
      : {
          id: row.mappingId,
          tracker: row.tracker as Tracker,
          target: row.place,
          mirrorOnOpen: row.mirrorOnOpen,
          createdAt: row.mappedAt,
          madeAfterEvent: row.madeAfterEvent,
        };
  // The opening, claims and reassignments of the request, and which of them came after the mapping was made: those
  // numbered after the mapping's last event, whose writes committed after it and saw it, or, for a mapping that kept
  // no number, those that occurred after its time.
  const afterMapping =
    mapping === undefined
      ? sql`false`
      : mapping.madeAfterEvent === null
        ? sql`${events.occurredAt} > ${mapping.createdAt}::timestamptz`
        : sql`${events.number} > ${mapping.madeAfterEvent}`;
  const claimant = row.request.claimantUserId;
  const [marks] = await tx
    .select({
      openedSince: sql<boolean | null>`bool_or(${events.type} = 'request.opened' AND ${afterMapping})`,
      reassigned: sql<string | null>`max(${events.number}) FILTER (WHERE ${events.type} = 'request.reassigned')`,
      reassignedSince: sql<string | null>`max(${events.number}) FILTER (WHERE ${events.type} = 'request.reassigned' AND ${afterMapping})`,
      claimedSince: sql<string | null>`max(${events.number}) FILTER (WHERE ${events.type} = 'request.claimed' AND ${afterMapping})`,
      claimantSince: sql<boolean | null>`bool_or(${events.type} = 'request.claimed' AND ${events.data} ->> 'userId' = ${claimant} AND ${afterMapping})`,
    })
    .from(events)
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.class, "domain"),
        inArray(events.type, ["request.opened", "request.claimed", "request.reassigned"]),
        sql`${events.data} ->> 'requestId' = ${requestId}`,
      ),
    );
  // A contract-change request's provider change, once its pull request merged (contract-changes: Merging the provider PR marks the change shipped).
  const [provider] = await tx
    .select({ repository: apis.repositoryFullName, number: contractChangeSets.pullRequestNumber })
    .from(contractChangeRequests)
    .innerJoin(contractChangeSets, and(eq(contractChangeSets.orgId, contractChangeRequests.orgId), eq(contractChangeSets.id, contractChangeRequests.changeSetId)))
    .innerJoin(apis, and(eq(apis.orgId, contractChangeSets.orgId), eq(apis.id, contractChangeSets.apiId)))
    .where(and(eq(contractChangeRequests.orgId, orgId), eq(contractChangeRequests.requestId, requestId), isNotNull(contractChangeSets.providerMergedAt)));
  const numberOf = (value: string | null | undefined) => (value === null || value === undefined ? undefined : Number(value));
  const lastMove = numberOf(marks?.reassigned);
  const claimSince = numberOf(marks?.claimedSince);
  // A claim counts for the team the request is with when the request holds it now, its claimant's own, or when it came
  // after the request's last reassignment, as a claim since released; and it counts for the mapping only when it came
  // after the mapping was made. The request came into its team by its opening, or by its last reassignment, which moved
  // it there.
  const claimed = (claimant !== null && marks?.claimantSince === true) || (claimSince !== undefined && (lastMove === undefined || claimSince > lastMove));
  const arrived = lastMove === undefined ? marks?.openedSince === true : numberOf(marks?.reassignedSince) === lastMove;
  const reached = mapping !== undefined && (claimed || (mapping.mirrorOnOpen && arrived));
  const request: MirroredRequest = {
    id: row.request.id,
    key: formatRequestKey(row.targetKey, row.request.number),
    number: row.request.number,
    title: row.request.title,
    state: row.request.state as RequestState,
    targetTeamId: row.request.targetTeamId,
    targetKey: row.targetKey,
    requestingKey: row.requestingKey,
    shipped: provider === undefined ? undefined : { repository: provider.repository, number: provider.number },
  };
  // Each mirror of the request, with whether the mapping that made it holds still: a mirror whose mapping was removed
  // is written to no more, whatever the request does.
  const rows = (
    await tx
      .select({ mirror: mirrors, mapped: sql<boolean>`${trackerMappings.teamId} IS NOT NULL` })
      .from(mirrors)
      .leftJoin(trackerMappings, madeBy())
      .where(and(eq(mirrors.orgId, orgId), eq(mirrors.requestId, requestId)))
      .orderBy(asc(mirrors.createdAt))
  ).map(({ mirror, mapped }) => mirrorRowOf(mirror, mapped));
  // The mirror made for the request's key in this team comes before one made before mirrors had keys.
  const current = (candidate: MirrorRow) => mapping !== undefined && candidate.mapped && isCurrent(candidate, request, mapping);
  const mirror = rows.find((candidate) => current(candidate) && candidate.number !== null) ?? rows.find(current);
  // A mirror whose create is under way counts too: the tracker may have made its issue, which a retry looks for.
  const leftBehind = rows.filter(
    (candidate) =>
      candidate !== mirror && candidate.mapped && (candidate.issue !== null || candidate.shownState !== null) && !candidate.away && isLeftBehind(candidate, request),
  );
  // The events since the earliest comments of the mirrors that follow, or followed, the request until now.
  // A mirror whose create is under way has its comments' start recorded too, from the read its create carries.
  const reading = [...(mirror !== undefined && mirror.shownState !== null ? [mirror] : []), ...leftBehind];
  const since = reading.length === 0 ? undefined : Math.min(...reading.map(({ commentedThrough }) => commentedThrough));
  const read =
    since === undefined
      ? []
      : await tx
          .select({ number: events.number, type: events.type, data: events.data, at: sql<string>`${events.occurredAt}::text` })
          .from(events)
          .where(
            and(
              eq(events.orgId, orgId),
              eq(events.class, "domain"),
              gt(events.number, since),
              lte(events.number, latest),
              sql`${events.data} ->> 'requestId' = ${requestId}`,
            ),
          )
          .orderBy(asc(events.number));
  const requestEvents = read.map((event) => ({ ...event, data: event.data as Record<string, unknown> }));
  const teamIds = new Set<string>([request.targetTeamId, ...rows.map(({ teamId }) => teamId)]);
  for (const { data } of requestEvents) {
    for (const field of ["teamId", "previousTeamId"]) if (typeof data[field] === "string") teamIds.add(data[field] as string);
  }
  const keys = await tx
    .select({ id: teams.id, key: teams.key })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), inArray(teams.id, [...teamIds])));
  return { request, mapping, reached, mirror, leftBehind, latest, events: requestEvents, teamKeys: new Map(keys.map(({ id, key }) => [id, key])) };
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
 * Adds a comment Tiehall writes to the mirror issue for the write that ends at
 * this event, once: a comment started before and not known to have been made
 * is looked for by its marker first. Then the issue's comments cover the write.
 */
async function commentFor(
  services: MirrorServices,
  adapter: TrackerAdapter,
  mirror: MirrorRow & { issue: string },
  write: { through: number; state: RequestState },
  text: ServerText | undefined,
  covered: Partial<typeof mirrors.$inferInsert> = {},
): Promise<boolean> {
  if (text !== undefined) {
    const pending = mirror.pendingComment?.through === write.through ? mirror.pendingComment : undefined;
    const made = pending !== undefined && (await adapter.findComment(mirror.target, mirror.issue, pending.marker, new Date(Date.parse(pending.at) - CREATE_LOOKBACK_MS)));
    if (!made) {
      await assertMapped(services.database, mirror.id);
      const comment: PendingComment = pending ?? { through: write.through, state: write.state, marker: randomUUID(), at: new Date().toISOString() };
      await saveMirror(services.database, mirror.id, { pendingComment: comment });
      await adapter.addComment(mirror.target, mirror.issue, text, comment.marker);
    }
  }
  await saveMirror(services.database, mirror.id, { commentedThrough: write.through, shownState: write.state, pendingComment: null, ...covered });
  return text !== undefined;
}

/**
 * Writes a change of what the issue shows, with the issue's state Tiehall
 * expects back while it is under way, and records what it wrote. A write of
 * the issue's state is counted as it begins and as it ends, so a read of the
 * issue taken before either and recorded after is told apart.
 */
async function updateIssue(services: MirrorServices, adapter: TrackerAdapter, mirror: MirrorRow & { issue: string }, update: IssueUpdate, pushed: Pushed): Promise<void> {
  await assertMapped(services.database, mirror.id);
  const state = update.state;
  // A change of the issue's state, read back meanwhile, is this write's own.
  if (state !== undefined) {
    await withOrg(services.database, async ({ tx, orgId }) => {
      await tx
        .update(mirrors)
        .set({ expectedState: state, stateWrites: sql`${mirrors.stateWrites} + 1` })
        .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirror.id)));
    });
  }
  await adapter.updateIssue(mirror.target, mirror.issue, mirror.marker, update);
  await withOrg(services.database, async ({ tx, orgId }) => {
    await tx
      .update(mirrors)
      .set({
        pushed,
        // Only the state this write set changes what Tiehall knows of the issue: what it read back meanwhile, such as
        // the issue's new assignees, stays.
        ...(state === undefined
          ? {}
          : {
              trackerState: sql`coalesce(${mirrors.trackerState}, ${JSON.stringify(AS_MADE)}::jsonb) || ${JSON.stringify({ open: state.open, closeReason: state.closeReason })}::jsonb`,
              expectedState: null,
              stateWrites: sql`${mirrors.stateWrites} + 1`,
            }),
      })
      .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirror.id)));
  });
}

/**
 * Brings the request's mirror issues up to date with the request as it is
 * now: creates its mirror issue in its target team's tracker, once, when the
 * request should have one; adds one comment for each write that changed its
 * state or asked a question since the comments it has; writes what changed
 * since Tiehall last wrote it, or nothing; and leaves the issues a
 * reassignment took the request away from with a notice, closed as not
 * planned (tracker-mirrors: Reassignment moves the mirror).
 */
export async function syncMirror(services: MirrorServices, requestId: string): Promise<void> {
  const logger = (services.logger ?? createLogger()).child({ job: mirrorRequest.name, requestId });
  const plan = await withOrg(services.database, (context) => planOf(context, requestId), { readOnly: true });
  if (plan === undefined) return;
  const mapping = plan.mapping;
  if (mapping !== undefined) await whileMapped(logger, () => syncFollowing(services, plan, mapping, logger));
  for (const left of plan.leftBehind) await whileMapped(logger, () => leave(services, plan, left, logger));
}

/** Runs one mirror's writes, which stop before the first write after the mapping that made the mirror was removed. */
async function whileMapped(logger: Logger, writes: () => Promise<void>): Promise<void> {
  try {
    await writes();
  } catch (error) {
    if (!(error instanceof MappingRemoved)) throw error;
    logger.info("mirror: the mapping that made the mirror was removed while the job ran, so nothing more is written to its issue", { mirrorId: error.mirrorId });
  }
}

/** The mirror in the target team's tracker: created under the team's rule, then commented and updated to show the request now. */
async function syncFollowing(services: MirrorServices, plan: MirrorPlan, mapping: MirrorMapping, logger: Logger): Promise<void> {
  const { request } = plan;
  const requestId = request.id;
  const adapter = services.adapters[mapping.tracker];
  if (adapter === undefined) {
    logger.warn("mirror: no adapter for the team's tracker, so nothing is written", { tracker: mapping.tracker });
    return;
  }
  const projection = projectionOf(request, services.installUrl);
  // A request gets its mirror issue once it reached its team's point since the mapping was made, its claim there, or
  // its opening or its move there when the team mirrors on open, unless it has ended; a request reassigned to the team
  // is open and unclaimed in it.
  const wanted = !isTerminalState(request.state) && plan.reached;
  let mirror = plan.mirror;
  let fresh = false;
  if (mirror === undefined) {
    if (!wanted) return;
    const made = await withOrg(services.database, async ({ tx, orgId }) => {
      // The mirror keeps the mapping the job read, which must hold still: one removed since gets no mirror, and one made
      // since is another mapping.
      const [held] = await tx
        .select({ teamId: trackerMappings.teamId })
        .from(trackerMappings)
        .where(and(eq(trackerMappings.orgId, orgId), eq(trackerMappings.teamId, request.targetTeamId), isMapping(mapping)));
      if (held === undefined) return undefined;
      const [inserted] = await tx
        .insert(mirrors)
        .values({
          orgId,
          requestId,
          teamId: request.targetTeamId,
          number: request.number,
          tracker: mapping.tracker,
          target: mapping.target,
          mappingId: mapping.id,
          ...createdOf(projection, plan),
        })
        .onConflictDoNothing()
        .returning();
      fresh = inserted !== undefined;
      const [row] =
        inserted !== undefined || mapping.id === null
          ? [inserted]
          : await tx
              .select()
              .from(mirrors)
              .where(
                and(
                  eq(mirrors.orgId, orgId),
                  eq(mirrors.requestId, requestId),
                  eq(mirrors.teamId, request.targetTeamId),
                  eq(mirrors.number, request.number),
                  eq(mirrors.tracker, mapping.tracker),
                  eq(mirrors.target, mapping.target),
                  eq(mirrors.mappingId, mapping.id),
                ),
              );
      if (row === undefined) throw new Error("The mirror's row was not found after it was written.");
      return mirrorRowOf(row, true);
    });
    if (made === undefined) {
      logger.info("mirror: made no mirror issue, as the team's mapping was removed since the job read it");
      return;
    }
    mirror = made;
  }

  if (mirror.issue === null) {
    const pending = mirror;
    // The row and its marker are committed: a create retried after the tracker made the issue finds it by the marker.
    const found = fresh ? undefined : await adapter.findCreated(pending.target, pending.marker, new Date(pending.createdAt.getTime() - CREATE_LOOKBACK_MS));
    let issue = found;
    if (issue === undefined) {
      // No create made the issue: one that should be made is made from the request as it is now, after the row records
      // what it writes; a request that ended meanwhile gets none.
      if (!wanted) {
        logger.info("mirror: made no mirror issue, as the request no longer gets one", { mirrorId: mirror.id });
        return;
      }
      await assertMapped(services.database, mirror.id);
      if (!fresh) await saveMirror(services.database, mirror.id, createdOf(projection, plan));
      issue = await adapter.createIssue(mirror.target, projection, mirror.marker);
    }
    const madeIssue = issue;
    await withOrg(services.database, async ({ tx, orgId }) => {
      await tx
        .update(mirrors)
        .set({ issue: madeIssue, issueCreatedAt: sql`now()`, trackerState: AS_MADE, away: false })
        .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, pending.id), isNull(mirrors.issue)));
    });
    if (found === undefined) {
      // It shows the request as the job read it, so its comments start after every event that read covered.
      logger.info("mirror: created the mirror issue", { mirrorId: mirror.id });
      return;
    }
    // The issue a create made before shows the request as that create read it, which the row recorded: the comments of
    // the writes since, its label and its state follow, as for any issue whose request changed.
    logger.info("mirror: found the mirror issue a create made before", { mirrorId: mirror.id });
    mirror = { ...pending, issue: madeIssue, trackerState: AS_MADE, away: false };
  }
  const following = mirror as MirrorRow & { issue: string };
  const mirrorId = following.id;

  if (following.shownState === null) {
    // A mirror made before its comments were kept: they start from the request as it is now.
    await saveMirror(services.database, mirrorId, { commentedThrough: plan.latest, shownState: request.state });
  }
  const writes = writesOf(
    plan.events.filter(({ number }) => number > following.commentedThrough),
    following.shownState ?? request.state,
  );
  let written = false;
  let rest = writes;
  if (following.away) {
    // A reassignment had left the issue behind, and the request is back: one notice, for the write that brought it
    // back, and the comments go on from there.
    const at = writes.findLastIndex(({ moves }) => moves.some(({ teamId }) => teamId === following.teamId));
    const back = at === -1 ? undefined : writes[at];
    const from = back?.moves.find(({ teamId }) => teamId === following.teamId)?.previousTeamId;
    const text = backComment({
      key: request.key,
      from: from === undefined ? undefined : plan.teamKeys.get(from),
      state: request.state,
      link: projection.summary.link,
      undone: back?.undone === true,
    });
    written = await commentFor(services, adapter, following, back ?? { through: plan.latest, state: request.state }, text, { away: false });
    rest = at === -1 ? [] : writes.slice(at + 1);
  }
  // One comment per write that changed the request's state or asked a question, in order, while the request was with the
  // issue's team: a reassignment away and back before the job ran leaves nothing on the issue.
  let here = true;
  for (const write of rest) {
    let text: ServerText | undefined;
    if (write.moves.length > 0) here = write.moves.some(({ teamId }) => teamId === following.teamId);
    else if (here) text = commentOf(write, request.key, projection.summary.link);
    if (await commentFor(services, adapter, following, write, text)) written = true;
  }

  const update = updateOf(following.pushed, projection);
  // Nothing the mirror shows has changed since Tiehall last wrote it: nothing more is written.
  if (update === undefined) {
    if (written) logger.info("mirror: commented on the mirror issue", { mirrorId });
    return;
  }
  await updateIssue(services, adapter, following, update, pushedOf(projection));
  logger.info("mirror: updated the mirror issue", { mirrorId });
}

/**
 * A mirror issue a reassignment left behind (tracker-mirrors: Reassignment
 * moves the mirror): the comments of the writes before the one that took the
 * request away, a notice of that reassignment, or of its undoing when that
 * took the request away, then the issue closed as not planned. It follows the
 * request no more, until an undo brings the request back.
 */
async function leave(services: MirrorServices, plan: MirrorPlan, left: MirrorRow, logger: Logger): Promise<void> {
  const adapter = services.adapters[left.tracker];
  if (adapter === undefined) {
    logger.warn("mirror: no adapter for the tracker of a mirror a reassignment left, so nothing is written", { tracker: left.tracker });
    return;
  }
  let mirror: MirrorRow & { issue: string };
  if (left.issue === null) {
    // Its create was under way when the reassignment took the request away: the issue the tracker may have made is
    // looked for by its marker, and left as any other; when there is none, there is nothing to leave.
    const found = await adapter.findCreated(left.target, left.marker, new Date(left.createdAt.getTime() - CREATE_LOOKBACK_MS));
    if (found === undefined) {
      await saveMirror(services.database, left.id, { away: true });
      logger.info("mirror: a reassignment left a mirror whose create made no issue", { mirrorId: left.id });
      return;
    }
    await withOrg(services.database, async ({ tx, orgId }) => {
      await tx
        .update(mirrors)
        .set({ issue: found, issueCreatedAt: sql`now()`, trackerState: AS_MADE })
        .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, left.id), isNull(mirrors.issue)));
    });
    mirror = { ...left, issue: found, trackerState: AS_MADE };
  } else {
    mirror = left as MirrorRow & { issue: string };
  }
  const { request } = plan;
  const teamKey = plan.teamKeys.get(mirror.teamId);
  const mirroredKey = teamKey === undefined || mirror.number === null ? request.key : formatRequestKey(teamKey, mirror.number);
  const mirroredLink = installLink(services.installUrl, `/${mirroredKey}`);
  const writes = writesOf(
    plan.events.filter(({ number }) => number > mirror.commentedThrough),
    mirror.shownState ?? request.state,
  );
  const away = writes.findIndex(({ moves }) => moves.some(({ teamId, previousTeamId }) => previousTeamId === mirror.teamId && teamId !== mirror.teamId));
  for (const write of away === -1 ? [] : writes.slice(0, away)) await commentFor(services, adapter, mirror, write, commentOf(write, mirroredKey, mirroredLink));
  const text = awayComment({
    mirroredKey,
    key: request.key,
    team: request.targetKey,
    link: installLink(services.installUrl, `/${request.key}`),
    undone: away !== -1 && writes[away]!.undone,
  });
  await commentFor(services, adapter, mirror, away === -1 ? { through: plan.latest, state: request.state } : writes[away]!, text, { away: true });
  // It follows the request no more: its comments cover every event the job read.
  await saveMirror(services.database, mirror.id, { commentedThrough: plan.latest });
  if (mirror.pushed?.open === false && mirror.pushed.closeReason === "not_planned") return;
  const pushed: Pushed = { ...(mirror.pushed ?? { title: "", body: "", label: "" }), open: false, closeReason: "not_planned" };
  await updateIssue(services, adapter, mirror, { state: { open: false, closeReason: "not_planned" } }, pushed);
  logger.info("mirror: left a mirror issue behind the reassigned request", { mirrorId: mirror.id });
}

/** The trackers' adapters the worker writes through: GitHub Issues, as the install's App, once an App is stored. */
export async function adaptersOf(services: Pick<WorkerServices, "database" | "github">): Promise<TrackerAdapters> {
  const app = await services.github?.app();
  return app === undefined ? {} : { github: createGitHubIssues({ app, database: services.database }) };
}

/**
 * The worker's mirror job: brings one request's mirror issue up to date, and
 * then forgets a failed mirror job of the request, whose banner goes. A job
 * that used up its attempts reaches the dead-letter queue, which the worker
 * works to record it for its banner (mirror-failures.ts).
 */
export const mirrorRequests: WorkerJob<{ requestId: string }> = {
  type: mirrorRequest,
  concurrency: 4,
  async handle(job, services) {
    if (services.installUrl === undefined) throw new Error("The worker gives this job no install URL to link the request with.");
    try {
      await syncMirror(
        { database: services.database, adapters: await adaptersOf(services), installUrl: services.installUrl, ...(services.logger === undefined ? {} : { logger: services.logger }) },
        job.data.requestId,
      );
      await clearMirrorFailure(services.database, job.data.requestId);
    } catch (error) {
      // Before setup completes there is no request to mirror.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
  async deadLetter(job, { database, now }) {
    await recordMirrorFailure(database, job.data.requestId, now());
  },
};

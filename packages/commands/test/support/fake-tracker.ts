import type { IssueNow, IssueUpdate, MirrorProjection, Tracker, TrackerAccount, TrackerAdapter } from "../../src/index.ts";

// A fake tracker for the tests of the tracker-neutral mirror module: issues
// kept in memory, in places named as the team's mapping names them, written
// through the same adapter interface as GitHub Issues. It records every
// write call, lets a test make a call fail before or after the tracker
// applied it, as a tracker whose answer never arrives does, and lets a test
// change an issue as a person in the tracker would.

export interface FakeIssue {
  target: string;
  number: number;
  title: string;
  body: string;
  marker: string;
  labels: string[];
  open: boolean;
  closeReason: "completed" | "not_planned" | "duplicate" | null;
  assignees: TrackerAccount[];
  closedBy: TrackerAccount | null;
  createdAt: Date;
}

/** A call that fails: before the tracker applies it, or after, as one whose answer never arrives. */
export interface Failure {
  call: "createIssue" | "updateIssue";
  when: "before" | "after";
}

/** Issue numbers, counted across every fake tracker of a test file, so the mirrors one makes never share a number with another's. */
let lastNumber = 0;

export class FakeTracker implements TrackerAdapter {
  readonly tracker: Tracker;
  readonly issues: FakeIssue[] = [];
  /** Every write call, in order, by its name. */
  readonly writes: string[] = [];
  /** Every call, writes and reads, in order. */
  readonly calls: string[] = [];
  /** Runs at the start of each create, before the tracker makes the issue, such as to look at the database then. */
  beforeCreate: ((target: string, marker: string) => Promise<void>) | undefined;
  private readonly failures: Failure[] = [];

  constructor(tracker: Tracker = "github") {
    this.tracker = tracker;
  }

  /** Makes the next such call fail, before or after the tracker applies it. */
  failNext(failure: Failure): void {
    this.failures.push(failure);
  }

  private failure(call: Failure["call"], when: Failure["when"]): void {
    const index = this.failures.findIndex((failure) => failure.call === call && failure.when === when);
    if (index === -1) return;
    this.failures.splice(index, 1);
    throw new Error(`The fake tracker failed ${call} ${when} applying it.`);
  }

  issue(target: string, number: string | number): FakeIssue {
    const found = this.issues.find((issue) => issue.target === target && issue.number === Number(number));
    if (found === undefined) throw new Error(`The fake tracker has no issue ${number} in ${target}.`);
    return found;
  }

  async findCreated(target: string, marker: string, since: Date): Promise<string | undefined> {
    this.calls.push("findCreated");
    const found = this.issues.find((issue) => issue.target === target && issue.marker === marker && issue.createdAt >= since);
    return found === undefined ? undefined : String(found.number);
  }

  async createIssue(target: string, projection: MirrorProjection, marker: string): Promise<string> {
    this.calls.push("createIssue");
    this.writes.push("createIssue");
    await this.beforeCreate?.(target, marker);
    this.failure("createIssue", "before");
    const issue: FakeIssue = {
      target,
      number: (lastNumber += 1),
      title: projection.title,
      body: [...projection.summary.paragraphs, projection.summary.link].join("\n\n"),
      marker,
      labels: [projection.label],
      open: true,
      closeReason: null,
      assignees: [],
      closedBy: null,
      createdAt: new Date(),
    };
    this.issues.push(issue);
    this.failure("createIssue", "after");
    return String(issue.number);
  }

  async updateIssue(target: string, number: string, update: IssueUpdate): Promise<void> {
    this.calls.push("updateIssue");
    this.writes.push("updateIssue");
    this.failure("updateIssue", "before");
    const issue = this.issue(target, number);
    if (update.title !== undefined) issue.title = update.title;
    if (update.summary !== undefined) issue.body = [...update.summary.paragraphs, update.summary.link].join("\n\n");
    if (update.label !== undefined) {
      issue.labels = [...issue.labels.filter((label) => label !== update.label?.remove), update.label.add];
    }
    this.failure("updateIssue", "after");
  }

  async readIssue(target: string, number: string): Promise<IssueNow | undefined> {
    this.calls.push("readIssue");
    const issue = this.issues.find((each) => each.target === target && each.number === Number(number));
    if (issue === undefined) return undefined;
    return { open: issue.open, closeReason: issue.closeReason, assignees: [...issue.assignees], closedBy: issue.closedBy };
  }

  /** A person closes the issue in the tracker. */
  closeAsPerson(target: string, number: string | number, by: TrackerAccount, reason: FakeIssue["closeReason"] = "completed"): void {
    Object.assign(this.issue(target, number), { open: false, closeReason: reason, closedBy: by });
  }
}

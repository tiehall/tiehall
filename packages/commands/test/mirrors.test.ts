import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mirrorRequest, mirrorRequests, syncMirror, trackerChanges, WORKER_JOBS, writesOf, type IssueState, type RequestEvent } from "../src/index.ts";
import { FakeTracker } from "./support/fake-tracker.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// The tracker-neutral mirror module (tracker-mirrors: A mirror is a
// projection of the request; tracker-mirrors: Mirror writes are idempotent
// and never echo; design.md, Technical decisions: T6 and T16). A fake tracker
// stands in for GitHub Issues and Jira: the module decides what to write and
// when, and the tracker's adapter only writes it. The mirror job reads the
// request as it is when it runs, writes nothing when nothing the mirror shows
// changed, runs one at a time per request, writes the mirror's row with its
// marker before it asks the tracker to create the issue, so a retried create
// makes one issue, and drops the echoes of its own writes.

let install: TestInstall;
let tracker: FakeTracker;
let alice: string;
let bob: string;
let mobile: string;

const FE_INTAKE = "4242";

beforeAll(async () => {
  install = await startTestInstall();
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  mobile = await addTeam(install.owner, "MOBILE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe, mobile);
  // FE mirrors into a place of the fake tracker; MOBILE maps nothing.
  await install.owner.query(
    "INSERT INTO tracker_mappings (org_id, team_id, tracker, target, target_name) SELECT id, $1, 'github', $2, 'acme/fe-intake' FROM orgs",
    [fe, FE_INTAKE],
  );
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
  tracker = new FakeTracker();
});

const sync = (requestId: string) => syncMirror({ database: install.db, adapters: { github: tracker }, installUrl: URL_OF_INSTALL, logger: install.logger }, requestId);

async function feRequest(): Promise<{ key: string; id: string }> {
  return openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE", title: "Show the invoice total" });
}

async function mirrorRowOf(requestId: string): Promise<{ issue: string | null; marker: string; tracker: string; target: string } | undefined> {
  const { rows } = await install.owner.query("SELECT issue, marker, tracker, target FROM mirrors WHERE request_id = $1", [requestId]);
  return rows[0];
}

describe("the mirror job", () => {
  it("is sent, under the request's id as its key, by a claim of a request to a team that mirrors, and by no write before", async () => {
    const request = await feRequest();
    expect(install.sentJobs.filter(({ queue }) => queue === mirrorRequest.queue)).toEqual([]);

    await install.execute("requests.claim", sessionOf(bob), { key: request.key });

    expect(install.sentJobs.filter(({ queue }) => queue === mirrorRequest.queue)).toEqual([
      { queue: mirrorRequest.queue, data: { requestId: request.id }, singletonKey: request.id },
    ]);
  });

  it("is never sent for a request to a team that maps no tracker", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "MOBILE" });
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: request.key, state: "in_progress" });
    expect(install.sentJobs.filter(({ queue }) => queue === mirrorRequest.queue)).toEqual([]);
  });

  it("runs one request's jobs one at a time, and is one of the worker's jobs", () => {
    expect(mirrorRequest.settings.policy).toBe("key_strict_fifo");
    expect(WORKER_JOBS).toContain(mirrorRequests);
  });
});

describe("creating the mirror issue", () => {
  it("writes the mirror's row with its marker, and commits it, before it asks the tracker to create the issue, which carries that marker", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    let seen: { issue: string | null; marker: string } | undefined;
    tracker.beforeCreate = async () => {
      // Read on the owner's own connection: only a committed row is there.
      seen = await mirrorRowOf(request.id);
    };

    await sync(request.id);

    expect(seen).toEqual({ issue: null, marker: expect.any(String), tracker: "github", target: FE_INTAKE });
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.issues[0]?.marker).toBe(seen?.marker);
    expect(await mirrorRowOf(request.id)).toEqual({ issue: String(tracker.issues[0]?.number), marker: seen?.marker, tracker: "github", target: FE_INTAKE });
  });

  it("makes one issue when a create is retried after the tracker made the issue but its answer never arrived", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    tracker.failNext({ call: "createIssue", when: "after" });

    await expect(sync(request.id)).rejects.toThrow("The fake tracker failed createIssue after applying it.");
    expect(tracker.issues).toHaveLength(1);
    expect((await mirrorRowOf(request.id))?.issue).toBeNull();

    // The job runs again, as the queue retries it.
    await sync(request.id);

    expect(tracker.issues).toHaveLength(1);
    expect(tracker.writes).toEqual(["createIssue"]);
    expect((await mirrorRowOf(request.id))?.issue).toBe(String(tracker.issues[0]?.number));
  });

  it("creates the issue on a retry when the first create failed before the tracker made it", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    tracker.failNext({ call: "createIssue", when: "before" });

    await expect(sync(request.id)).rejects.toThrow();
    await sync(request.id);

    expect(tracker.issues).toHaveLength(1);
    expect(tracker.calls).toEqual(["createIssue", "findCreated", "createIssue"]);
  });

  it("carries the request's key and title, a summary and link Tiehall wrote, and the label of its state", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });

    await sync(request.id);

    const [issue] = tracker.issues;
    expect(issue?.title).toBe(`${request.key}: Show the invoice total`);
    expect(issue?.body).toContain(`${URL_OF_INSTALL}/${request.key}`);
    expect(issue?.body).toContain(`which team BE opened for team FE`);
    expect(issue?.labels).toEqual(["tiehall:claimed"]);
  });

  it("is not done for an open request of a team that mirrors on claim, nor for one that ended before it was mirrored", async () => {
    const open = await feRequest();
    await sync(open.id);
    expect(tracker.issues).toEqual([]);
    expect(await mirrorRowOf(open.id)).toBeUndefined();

    const withdrawn = await feRequest();
    await install.owner.query("UPDATE requests SET state = 'withdrawn', claimed_at = now() WHERE id = $1", [withdrawn.id]);
    await sync(withdrawn.id);
    expect(tracker.issues).toEqual([]);
  });
});

describe("updating the mirror issue", () => {
  it("reads the request as it is when the job runs, not as it was when the job was sent", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await install.execute("requests.set_status", sessionOf(bob), { key: request.key, state: "in_progress" });
    // Two jobs were sent, one by each write; the first to run sees the request as it is now.
    expect(install.sentJobs.filter(({ queue }) => queue === mirrorRequest.queue)).toHaveLength(2);

    await sync(request.id);

    expect(tracker.issues[0]?.labels).toEqual(["tiehall:in_progress"]);
    await sync(request.id);
    expect(tracker.writes).toEqual(["createIssue"]);
  });

  it("writes nothing when nothing the mirror shows has changed since it last wrote", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await sync(request.id);
    const before = [...tracker.calls];

    await sync(request.id);
    await sync(request.id);

    expect(tracker.writes).toEqual(["createIssue"]);
    expect(tracker.calls).toEqual(before);
  });

  it("writes what changed, once: a comment and the label of the request's new state", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await sync(request.id);
    await install.execute("requests.set_status", sessionOf(bob), { key: request.key, state: "in_progress" });

    await sync(request.id);
    await sync(request.id);

    expect(tracker.writes).toEqual(["createIssue", "addComment", "updateIssue"]);
    expect(tracker.issues[0]?.labels).toEqual(["tiehall:in_progress"]);
  });

  it("writes again on the next run when an update failed", async () => {
    const request = await feRequest();
    await install.execute("requests.claim", sessionOf(bob), { key: request.key });
    await sync(request.id);
    await install.execute("requests.set_status", sessionOf(bob), { key: request.key, state: "in_progress" });
    tracker.failNext({ call: "updateIssue", when: "before" });

    await expect(sync(request.id)).rejects.toThrow();
    await sync(request.id);

    expect(tracker.issues[0]?.labels).toEqual(["tiehall:in_progress"]);
  });
});

describe("changes read back from the tracker", () => {
  const known: IssueState = { open: true, closeReason: null, assignees: [] };
  const ayse = { id: "101", login: "ayse" };

  it("drop what Tiehall wrote itself, or is writing: an echo adds nothing", () => {
    expect(trackerChanges(known, null, known)).toEqual([]);
    const closing = { open: false, closeReason: "completed" as const };
    expect(trackerChanges(known, closing, { ...closing, assignees: [] })).toEqual([]);
    expect(trackerChanges({ ...closing, assignees: [] }, null, { ...closing, assignees: [] })).toEqual([]);
  });

  it("keep what a person changed in the tracker: a close, a reopen, a new assignee", () => {
    expect(trackerChanges(known, null, { open: false, closeReason: "not_planned", assignees: [] })).toEqual([{ kind: "closed", reason: "not_planned" }]);
    expect(trackerChanges({ open: false, closeReason: "completed", assignees: [] }, null, known)).toEqual([{ kind: "reopened" }]);
    expect(trackerChanges(known, null, { ...known, assignees: [ayse] })).toEqual([{ kind: "assignees_changed", assignees: [ayse] }]);
    expect(trackerChanges({ ...known, assignees: [ayse] }, null, { ...known, assignees: [ayse] })).toEqual([]);
  });

  it("keep a person's change that differs from what Tiehall is writing", () => {
    const closing = { open: false, closeReason: "completed" as const };
    expect(trackerChanges(known, closing, { open: false, closeReason: "not_planned", assignees: [] })).toEqual([{ kind: "closed", reason: "not_planned" }]);
  });
});

describe("the writes a mirror's comments tell", () => {
  const requestId = "00000000-0000-4000-8000-000000000001";
  const event = (number: number, at: string, type: string, data: Record<string, unknown> = {}): RequestEvent => ({ number, at, type, data: { requestId, ...data } });

  it("are told apart by their transaction's time: a blocking question and the move to needs_info it causes are one write", () => {
    expect(
      writesOf(
        [
          event(10, "t1", "request.started"),
          event(12, "t2", "request.message_posted", { kind: "question", blocking: true }),
          event(13, "t2", "request.state_changed", { state: "needs_info", previousState: "in_progress" }),
          event(15, "t3", "request.message_posted", { kind: "comment" }),
        ],
        "claimed",
      ),
    ).toEqual([
      { through: 10, state: "in_progress", changed: true, question: false, moves: [], undone: false },
      { through: 13, state: "needs_info", changed: true, question: true, moves: [], undone: false },
      { through: 15, state: "needs_info", changed: false, question: false, moves: [], undone: false },
    ]);
  });

  it("follow a release that keeps a request waiting on its questions, which changes no state", () => {
    expect(writesOf([event(20, "t1", "request.released"), event(22, "t2", "request.released")], "needs_info")).toEqual([
      { through: 20, state: "needs_info", changed: false, question: false, moves: [], undone: false },
      { through: 22, state: "needs_info", changed: false, question: false, moves: [], undone: false },
    ]);
    expect(writesOf([event(30, "t1", "request.released")], "in_progress")).toEqual([{ through: 30, state: "open", changed: true, question: false, moves: [], undone: false }]);
  });

  it("name the reassignment a write made, and whether it undid one", () => {
    const fe = "00000000-0000-4000-8000-0000000000fe";
    const mobile = "00000000-0000-4000-8000-0000000000ab";
    expect(
      writesOf(
        [
          event(40, "t1", "request.reassigned", { teamId: mobile, previousTeamId: fe }),
          event(41, "t1", "request.state_changed", { state: "open", previousState: "in_progress" }),
          event(44, "t2", "proposal.undone", { proposalId: requestId }),
          event(45, "t2", "request.reassigned", { teamId: fe, previousTeamId: mobile }),
          event(46, "t2", "request.state_changed", { state: "in_progress", previousState: "open" }),
        ],
        "in_progress",
      ),
    ).toEqual([
      { through: 41, state: "open", changed: true, question: false, moves: [{ teamId: mobile, previousTeamId: fe }], undone: false },
      { through: 46, state: "in_progress", changed: true, question: false, moves: [{ teamId: fe, previousTeamId: mobile }], undone: true },
    ]);
  });
});

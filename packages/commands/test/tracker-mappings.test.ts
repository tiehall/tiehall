import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTeamsRoute, csrfTokenFor, mirrorRequest, syncMirror, TEAMS_PATH, type WebSessionCaller } from "../src/index.ts";
import { providerOnStub } from "./support/contract.ts";
import { FakeTracker } from "./support/fake-tracker.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { holdRow, untilWaiting } from "./support/locks.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi } from "./support/requests.ts";

// Mapping teams to an intake repository (tracker-mirrors: Each team maps to
// one tracker; tracker-mirrors: Mirror issues are created on claim by
// default). Admins map a team to an intake repository in the web UI, on the
// teams page; the repository must be covered by a connected installation of
// the install's GitHub App, and a team maps one tracker only. A team that maps
// none gets no mirror issue. A new mapping mirrors on claim: a request's
// mirror issue waits for its claim unless an admin turns mirroring on open on.
// A member who is not an admin can change no mapping. The GitHub stub plays
// GitHub: acme/fe-intake and acme/mobile-intake are covered by the connected
// acme installation, acme/secret-intake is not. A fake tracker stands in for
// GitHub Issues, whose adapter task 24.3 builds.

let install: TestInstall;
let stub: GitHubStub;
let ada: WebSessionCaller;
let ayse: WebSessionCaller;
let alice: string;
let teams: Record<string, string>;
let feIntake: number;
let tracker: FakeTracker;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  await providerOnStub(install, stub, ["ayse"], { repositories: ["acme/fe-intake", "acme/mobile-intake", "acme/open-intake"], publicRepositories: ["acme/open-intake"] });
  stub.addRepo("acme/secret-intake");
  const covered = await install.owner.query<{ repository_id: string }>("SELECT repository_id FROM github_covered_repositories WHERE full_name = 'acme/fe-intake'");
  feIntake = Number(covered.rows[0]?.repository_id);
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  ayse = { kind: "web_session", userId: await addUser(install.owner, { login: "ayse" }), sessionId: randomUUID() };
  alice = await addUser(install.owner, { login: "alice" });
  teams = {};
  for (const key of ["BE", "FE", "MOBILE", "DATA", "OPS", "OPEN"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, alice, teams["BE"]!);
  await joinTeams(install.owner, ayse.userId, teams["FE"]!, teams["MOBILE"]!);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
  tracker = new FakeTracker();
});

const sync = (requestId: string) => syncMirror({ database: install.db, adapters: { github: tracker }, installUrl: URL_OF_INSTALL, logger: install.logger }, requestId);

async function mappingsOf(teamId: string): Promise<{ tracker: string; target: string; target_name: string; mirror_on_open: boolean }[]> {
  const { rows } = await install.owner.query("SELECT tracker, target, target_name, mirror_on_open FROM tracker_mappings WHERE team_id = $1", [teamId]);
  return rows;
}

const mirrorJobsOf = (requestId: string) => install.sentJobs.filter(({ queue, data }) => queue === mirrorRequest.queue && data["requestId"] === requestId);

/** Runs the mirror jobs the writes sent, in order, as the worker does, and takes them from the sent jobs. */
async function runSentMirrorJobs(): Promise<void> {
  const jobs = install.sentJobs.filter(({ queue }) => queue === mirrorRequest.queue);
  install.sentJobs.splice(0);
  for (const { data } of jobs) await sync(String(data["requestId"]));
}

describe("mapping a team to an intake repository", () => {
  it("sends FE's mirror issues to its intake repository, by GitHub's id of it", async () => {
    const mapping = await install.execute("mirrors.map_repository", ada, { teamId: teams["FE"], repository: "acme/fe-intake" });
    expect(mapping).toEqual({ teamId: teams["FE"], tracker: "github", place: "acme/fe-intake", mirrorOnOpen: false, doneProposals: false });
    expect(await mappingsOf(teams["FE"]!)).toEqual([{ tracker: "github", target: String(feIntake), target_name: "acme/fe-intake", mirror_on_open: false }]);

    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    await install.execute("requests.claim", ayse, { key: request.key });
    await sync(request.id);

    expect(tracker.issues.map(({ target }) => target)).toEqual([String(feIntake)]);
  });

  it("takes the repository's name in any case, and keeps it as GitHub writes it", async () => {
    await install.execute("mirrors.map_repository", ada, { teamId: teams["OPS"], repository: "ACME/Mobile-Intake" });
    expect((await mappingsOf(teams["OPS"]!))[0]?.target_name).toBe("acme/mobile-intake");
    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["OPS"] });
    expect(await mappingsOf(teams["OPS"]!)).toEqual([]);
  });

  it("refuses with 409 a repository that no connected installation covers, and maps nothing", async () => {
    for (const repository of ["acme/secret-intake", "acme/nowhere", "acme-labs/fe-intake"]) {
      await expect(install.execute("mirrors.map_repository", ada, { teamId: teams["DATA"], repository }), repository).rejects.toMatchObject({
        status: 409,
        reason: "conflict",
      });
    }
    expect(await mappingsOf(teams["DATA"]!)).toEqual([]);
  });

  it("refuses with 409 a second mapping for a team that maps a tracker already, and keeps the first", async () => {
    await expect(install.execute("mirrors.map_repository", ada, { teamId: teams["FE"], repository: "acme/mobile-intake" })).rejects.toMatchObject({
      status: 409,
      reason: "conflict",
    });
    expect((await mappingsOf(teams["FE"]!)).map(({ target_name }) => target_name)).toEqual(["acme/fe-intake"]);
  });

  it("refuses a team the install does not have with 404, and a malformed repository with 400", async () => {
    await expect(install.execute("mirrors.map_repository", ada, { teamId: randomUUID(), repository: "acme/fe-intake" })).rejects.toMatchObject({ status: 404 });
    await expect(install.execute("mirrors.map_repository", ada, { teamId: teams["DATA"], repository: "fe-intake" })).rejects.toMatchObject({ status: 400 });
    await expect(install.execute("mirrors.set_mirror_on_open", ada, { teamId: teams["DATA"], on: true })).rejects.toMatchObject({ status: 404 });
    await expect(install.execute("mirrors.remove_mapping", ada, { teamId: teams["DATA"] })).rejects.toMatchObject({ status: 404 });
  });
});

describe("a team that maps no tracker", () => {
  it("gets no mirror issue", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "MOBILE" });
    await install.execute("requests.claim", ayse, { key: request.key });

    expect(mirrorJobsOf(request.id)).toEqual([]);
    await sync(request.id);
    expect(tracker.issues).toEqual([]);
  });
});

describe("mirroring on open", () => {
  it("is off in a new mapping, so a request's mirror issue waits for its claim", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    expect(mirrorJobsOf(request.id)).toEqual([]);
    await sync(request.id);
    expect(tracker.issues).toEqual([]);

    await install.execute("requests.claim", ayse, { key: request.key });
    expect(mirrorJobsOf(request.id)).toHaveLength(1);
    await sync(request.id);
    expect(tracker.issues).toHaveLength(1);
  });

  it("makes a request's mirror issue at its opening once an admin turns it on, and waits for the claim again once turned off", async () => {
    expect(await install.execute("mirrors.set_mirror_on_open", ada, { teamId: teams["FE"], on: true })).toMatchObject({ mirrorOnOpen: true });
    const opened = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    expect(mirrorJobsOf(opened.id)).toHaveLength(1);
    await sync(opened.id);
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.issues[0]?.labels).toEqual(["tiehall:open"]);

    await install.execute("mirrors.set_mirror_on_open", ada, { teamId: teams["FE"], on: false });
    const waiting = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    expect(mirrorJobsOf(waiting.id)).toEqual([]);
  });
});

// A mirror is a projection kept from a point on: removing a team's mapping stops every write to the issues it made, and
// a new mapping opens issues only for the requests that reach the team's point after it, never for one claimed or ended
// before it (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (75)). Each mirror issue is
// tied to the mapping that made it, so a new mapping, even to the same place, never writes to an earlier one's issues.
describe("a mapping removed, and one made later", () => {
  beforeAll(async () => {
    for (const key of ["WEB", "APP", "NEWS", "SHOP", "MAIL", "HELP", "POST", "MOVE", "RACE", "PAST", "JIRA", "LATE", "SOON", "EARLY"]) {
      teams[key] = await addTeam(install.owner, key);
      await joinTeams(install.owner, ayse.userId, teams[key]!);
    }
  });

  it("writes nothing to the issues of a removed mapping for their request's later state changes and questions", async () => {
    await install.execute("mirrors.map_repository", ada, { teamId: teams["WEB"], repository: "acme/mobile-intake" });
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "WEB" });
    await install.execute("requests.claim", ayse, { key: request.key });
    await sync(request.id);
    expect(tracker.issues).toHaveLength(1);
    const before = { writes: [...tracker.writes], issue: structuredClone(tracker.issues[0]) };

    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["WEB"] });
    await install.execute("requests.set_status", ayse, { key: request.key, state: "in_progress" });
    await install.execute("messages.post", ayse, { key: request.key, kind: "question", body: "Which screens?" });
    await sync(request.id);

    expect(tracker.writes).toEqual(before.writes);
    expect(tracker.issues).toEqual([before.issue]);
  });

  it("makes no issue for a request claimed before it, and one for a request claimed after it", async () => {
    const before = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "APP" });
    await install.execute("requests.claim", ayse, { key: before.key });
    install.sentJobs.splice(0);

    await install.execute("mirrors.map_repository", ada, { teamId: teams["APP"], repository: "acme/mobile-intake" });
    const after = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "APP" });
    await install.execute("requests.claim", ayse, { key: after.key });
    await runSentMirrorJobs();

    expect(tracker.issues.map(({ title }) => title)).toEqual([expect.stringMatching(new RegExp(`^${after.key}: `))]);
  });

  it("makes no issue for a request claimed before it when a later write wakes the request's mirror job", async () => {
    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["APP"] });
    const before = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "APP" });
    await install.execute("requests.claim", ayse, { key: before.key });
    await install.execute("mirrors.map_repository", ada, { teamId: teams["APP"], repository: "acme/mobile-intake" });
    install.sentJobs.splice(0);

    await install.execute("requests.set_status", ayse, { key: before.key, state: "in_progress" });
    await runSentMirrorJobs();

    expect(tracker.issues).toEqual([]);
  });

  // A write and a mapping made at once: the write counts as after the mapping exactly when it commits after it, and so
  // sees the mapping and sends the mirror job, wherever its transaction began.
  it("makes an issue for a request whose claim began before it and committed after it, as the claim's write sent the mirror job", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "LATE" });
    install.sentJobs.splice(0);
    // Another write of the request holds its row, so the claim waits there, begun before the mapping, and commits after it.
    const held = await holdRow(install.databaseUrl, "SELECT id FROM requests WHERE id = $1 FOR UPDATE", [request.id]);
    const claiming = install.execute("requests.claim", ayse, { key: request.key });
    await untilWaiting(install.owner, 1);
    await install.execute("mirrors.map_repository", ada, { teamId: teams["LATE"], repository: "acme/mobile-intake" });
    await held.release();
    await claiming;

    expect(mirrorJobsOf(request.id)).toHaveLength(1);
    await runSentMirrorJobs();
    expect(tracker.issues.map(({ title, labels }) => ({ title, labels }))).toEqual([{ title: expect.stringMatching(new RegExp(`^${request.key}: `)), labels: ["tiehall:claimed"] }]);
  });

  it("makes an issue for a request whose opening began before it and committed after it, on a team that mirrors on open", async () => {
    // The team's first request makes its count of requests, which the next opening locks.
    await openRequestInTheWebUi(install, alice, { targetTeam: "SOON" });
    install.sentJobs.splice(0);
    // Another opening for the team holds its count, so this one waits there, begun before the mapping, and commits after it.
    const held = await holdRow(install.databaseUrl, "SELECT last_number FROM request_counters WHERE team_id = $1 FOR UPDATE", [teams["SOON"]]);
    const opening = openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "SOON" });
    await untilWaiting(install.owner, 1);
    await install.execute("mirrors.map_repository", ada, { teamId: teams["SOON"], repository: "acme/mobile-intake", mirrorOnOpen: true });
    await held.release();
    const request = await opening;

    expect(mirrorJobsOf(request.id)).toHaveLength(1);
    await runSentMirrorJobs();
    expect(tracker.issues.map(({ title, labels }) => ({ title, labels }))).toEqual([{ title: expect.stringMatching(new RegExp(`^${request.key}: `)), labels: ["tiehall:open"] }]);
  });

  it("makes no issue for a request whose claim committed before it, though they ran at once, as the claim's write could not see it", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "EARLY" });
    install.sentJobs.splice(0);
    // A write in flight holds the event counter: the claim waits for it first, then the mapping, once its row is in.
    const held = await holdRow(install.databaseUrl, "SELECT last_number FROM event_sequence FOR UPDATE");
    const claiming = install.execute("requests.claim", ayse, { key: request.key });
    await untilWaiting(install.owner, 1);
    let mapped = false;
    const mapping = install.execute("mirrors.map_repository", ada, { teamId: teams["EARLY"], repository: "acme/mobile-intake" }).finally(() => {
      mapped = true;
    });
    await untilWaiting(install.owner, 2, () => mapped);
    await held.release();
    await Promise.all([claiming, mapping]);

    expect(mirrorJobsOf(request.id)).toEqual([]);
    await install.execute("requests.set_status", ayse, { key: request.key, state: "in_progress" });
    await runSentMirrorJobs();
    expect(tracker.issues).toEqual([]);
  });

  it("makes no issue for a request opened before it, on a team that mirrors on open, when a later write wakes the request's mirror job", async () => {
    const before = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "NEWS" });
    await install.execute("mirrors.map_repository", ada, { teamId: teams["NEWS"], repository: "acme/mobile-intake" });
    await install.execute("mirrors.set_mirror_on_open", ada, { teamId: teams["NEWS"], on: true });
    install.sentJobs.splice(0);

    await install.execute("messages.post", ayse, { key: before.key, kind: "question", body: "Which screens?" });
    await runSentMirrorJobs();

    expect(tracker.issues).toEqual([]);
  });

  it("writes nothing to the issues of a removed mapping when their request is then reassigned", async () => {
    await install.execute("mirrors.map_repository", ada, { teamId: teams["SHOP"], repository: "acme/fe-intake" });
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "SHOP" });
    await install.execute("requests.claim", ayse, { key: request.key });
    await sync(request.id);
    expect(tracker.issues).toHaveLength(1);
    const before = { writes: [...tracker.writes], issue: structuredClone(tracker.issues[0]) };

    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["SHOP"] });
    const proposed = (await install.execute("proposals.propose", ayse, { kind: "reassign", key: request.key, team: "HELP" })) as { proposal: { id: string } };
    expect((await install.confirm(ayse, "proposals.confirm", { proposal: proposed.proposal.id })).status).toBe(200);
    await sync(request.id);

    expect(tracker.writes).toEqual(before.writes);
    expect(tracker.issues).toEqual([before.issue]);
  });

  it("writes nothing to the issues of a removed mapping once the team maps the same place again", async () => {
    await install.execute("mirrors.map_repository", ada, { teamId: teams["MAIL"], repository: "acme/fe-intake" });
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "MAIL" });
    await install.execute("requests.claim", ayse, { key: request.key });
    await sync(request.id);
    expect(tracker.issues).toHaveLength(1);
    const before = { writes: [...tracker.writes], issue: structuredClone(tracker.issues[0]) };

    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["MAIL"] });
    await install.execute("mirrors.map_repository", ada, { teamId: teams["MAIL"], repository: "acme/fe-intake" });
    install.sentJobs.splice(0);
    await install.execute("messages.post", ayse, { key: request.key, kind: "question", body: "Which screens?" });
    await runSentMirrorJobs();

    expect(tracker.writes).toEqual(before.writes);
    expect(tracker.issues).toEqual([before.issue]);
  });

  it("starts afresh under a new mapping to the same place: a request that reaches the team's point again gets a new issue, and the old one is left as it is", async () => {
    await install.execute("mirrors.map_repository", ada, { teamId: teams["POST"], repository: "acme/fe-intake" });
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "POST" });
    await install.execute("requests.claim", ayse, { key: request.key });
    await sync(request.id);
    const old = structuredClone(tracker.issues[0]);

    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["POST"] });
    await install.execute("mirrors.map_repository", ada, { teamId: teams["POST"], repository: "acme/fe-intake" });
    install.sentJobs.splice(0);
    await install.execute("requests.set_status", ayse, { key: request.key, state: "open" });
    await runSentMirrorJobs();
    expect(tracker.issues).toEqual([old]);

    await install.execute("requests.claim", ayse, { key: request.key });
    await runSentMirrorJobs();
    expect(tracker.writes).toEqual(["createIssue", "createIssue"]);
    expect(tracker.issues[0]).toEqual(old);
    expect(tracker.issues[1]).toMatchObject({ target: String(feIntake), title: old?.title, labels: ["tiehall:claimed"] });
    // Each issue is tied to the mapping that made it: the new one to the mapping now, the old one to none.
    const { rows } = await install.owner.query(
      `SELECT m.issue, m.mapping_id = t.id AS current FROM mirrors m LEFT JOIN tracker_mappings t ON t.org_id = m.org_id AND t.team_id = m.team_id
        WHERE m.request_id = $1 ORDER BY m.created_at`,
      [request.id],
    );
    expect(rows).toEqual([
      { issue: String(old?.number), current: false },
      { issue: String(tracker.issues[1]?.number), current: true },
    ]);
  });

  it("makes an issue for a request moved after it into a team that mirrors on open", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "HELP" });
    await install.execute("mirrors.map_repository", ada, { teamId: teams["MOVE"], repository: "acme/mobile-intake" });
    await install.execute("mirrors.set_mirror_on_open", ada, { teamId: teams["MOVE"], on: true });
    install.sentJobs.splice(0);

    const proposed = (await install.execute("proposals.propose", ayse, { kind: "reassign", key: request.key, team: "MOVE" })) as { proposal: { id: string } };
    expect((await install.confirm(ayse, "proposals.confirm", { proposal: proposed.proposal.id })).status).toBe(200);
    await runSentMirrorJobs();

    expect(tracker.issues.map(({ title, labels }) => ({ title, labels }))).toEqual([{ title: expect.stringMatching(/^MOVE-\d+: /), labels: ["tiehall:open"] }]);
  });

  it("writes nothing more to an issue once its mapping is removed while a mirror job writes it", async () => {
    await install.execute("mirrors.map_repository", ada, { teamId: teams["RACE"], repository: "acme/mobile-intake" });
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "RACE" });
    await install.execute("requests.claim", ayse, { key: request.key });
    await sync(request.id);
    await install.execute("requests.set_status", ayse, { key: request.key, state: "in_progress" });
    await install.execute("messages.post", ayse, { key: request.key, kind: "question", body: "Which screens?" });

    // The mapping goes while the job adds its first comment: that write was under way, and nothing follows it.
    tracker.beforeWrite = async () => {
      tracker.beforeWrite = undefined;
      await install.execute("mirrors.remove_mapping", ada, { teamId: teams["RACE"] });
    };
    await sync(request.id);
    expect(tracker.writes).toEqual(["createIssue", "addComment"]);
    await sync(request.id);
    expect(tracker.writes).toEqual(["createIssue", "addComment"]);
  });

  it("keeps writing to a mirror made before mirrors were tied to their mappings, until its team maps the place again", async () => {
    // As an install left them before mirrors were tied to their mappings: a mapping with no id and no event number, whose
    // time orders the request's events, and mirrors that name none.
    await install.execute("mirrors.map_repository", ada, { teamId: teams["PAST"], repository: "acme/mobile-intake" });
    await install.owner.query("UPDATE tracker_mappings SET id = NULL, made_after_event = NULL WHERE team_id = $1", [teams["PAST"]]);
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "PAST" });
    await install.execute("requests.claim", ayse, { key: request.key });
    await runSentMirrorJobs();
    expect(tracker.issues).toHaveLength(1);
    const { rows } = await install.owner.query("SELECT mapping_id FROM mirrors WHERE request_id = $1", [request.id]);
    expect(rows).toEqual([{ mapping_id: null }]);

    await install.execute("requests.set_status", ayse, { key: request.key, state: "in_progress" });
    await runSentMirrorJobs();
    expect(tracker.writes).toEqual(["createIssue", "addComment", "updateIssue"]);
    expect(tracker.issues[0]?.labels).toEqual(["tiehall:in_progress"]);

    const before = { writes: [...tracker.writes], issue: structuredClone(tracker.issues[0]) };
    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["PAST"] });
    await install.execute("mirrors.map_repository", ada, { teamId: teams["PAST"], repository: "acme/mobile-intake" });
    install.sentJobs.splice(0);
    await install.execute("messages.post", ayse, { key: request.key, kind: "question", body: "Which screens?" });
    await runSentMirrorJobs();
    expect(tracker.writes).toEqual(before.writes);
    expect(tracker.issues).toEqual([before.issue]);
  });

  it("ties a Jira mirror issue to its mapping as a GitHub one: a removed mapping's issue gets nothing, and a new mapping to the project starts afresh", async () => {
    const jira = new FakeTracker("jira");
    const syncJira = (requestId: string) => syncMirror({ database: install.db, adapters: { jira }, installUrl: URL_OF_INSTALL, logger: install.logger }, requestId);
    // The Jira mapping as a team's mapping to a project stores it, with the org's last event number, which group 25's
    // operations make in the web UI.
    const mapProject = () =>
      install.owner.query(
        `INSERT INTO tracker_mappings (org_id, team_id, tracker, target, target_name, made_after_event)
           SELECT t.org_id, t.id, 'jira', '10042', 'JIRA', s.last_number FROM teams t JOIN event_sequence s ON s.org_id = t.org_id WHERE t.id = $1`,
        [teams["JIRA"]],
      );
    await mapProject();
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "JIRA" });
    await install.execute("requests.claim", ayse, { key: request.key });
    await syncJira(request.id);
    expect(jira.issues).toHaveLength(1);
    const old = structuredClone(jira.issues[0]);

    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["JIRA"] });
    await install.execute("requests.set_status", ayse, { key: request.key, state: "in_progress" });
    await syncJira(request.id);
    await mapProject();
    await install.execute("messages.post", ayse, { key: request.key, kind: "question", body: "Which screens?" });
    await syncJira(request.id);
    expect(jira.writes).toEqual(["createIssue"]);

    await install.execute("requests.set_status", ayse, { key: request.key, state: "open" });
    await install.execute("requests.claim", ayse, { key: request.key });
    await syncJira(request.id);
    expect(jira.writes).toEqual(["createIssue", "createIssue"]);
    expect(jira.issues).toEqual([old, expect.objectContaining({ target: "10042", labels: ["tiehall:claimed"] })]);
  });

  it("makes no issue for a request that ended before it, even on a team that mirrors on open", async () => {
    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["APP"] });
    const ended = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "APP" });
    await install.execute("requests.claim", ayse, { key: ended.key });
    const done = (await install.execute("requests.set_status", ayse, { key: ended.key, state: "done" })) as { proposal: { id: string } };
    expect((await install.confirm(ayse, "proposals.confirm", { proposal: done.proposal.id })).status).toBe(200);

    await install.execute("mirrors.map_repository", ada, { teamId: teams["APP"], repository: "acme/mobile-intake" });
    await install.execute("mirrors.set_mirror_on_open", ada, { teamId: teams["APP"], on: true });
    await sync(ended.id);

    expect(tracker.issues).toEqual([]);
  });
});

describe("a member who is not an admin", () => {
  it("cannot map a team, change its switch, remove its mapping or list the mappings: 403, and nothing changes", async () => {
    await expect(install.execute("mirrors.map_repository", ayse, { teamId: teams["MOBILE"], repository: "acme/mobile-intake" })).rejects.toMatchObject({ status: 403 });
    await expect(install.execute("mirrors.map_repository", ayse, { teamId: teams["FE"], repository: "acme/mobile-intake" })).rejects.toMatchObject({ status: 403 });
    await expect(install.execute("mirrors.set_mirror_on_open", ayse, { teamId: teams["FE"], on: true })).rejects.toMatchObject({ status: 403 });
    await expect(install.execute("mirrors.remove_mapping", ayse, { teamId: teams["FE"] })).rejects.toMatchObject({ status: 403 });
    await expect(install.execute("mirrors.list_mappings", ayse, {}, { readOnly: true })).rejects.toMatchObject({ status: 403 });
    expect(await mappingsOf(teams["MOBILE"]!)).toEqual([]);
    expect(await mappingsOf(teams["FE"]!)).toEqual([{ tracker: "github", target: String(feIntake), target_name: "acme/fe-intake", mirror_on_open: false }]);
  });

  it("finds the mapping operations on no agent surface", async () => {
    const token = { kind: "personal_access_token" as const, userId: ada.userId, tokenId: randomUUID(), scopes: ["requests:read" as const, "requests:write" as const], surface: "api" as const };
    for (const [id, input] of [
      ["mirrors.list_mappings", {}],
      ["mirrors.map_repository", { teamId: teams["MOBILE"], repository: "acme/mobile-intake" }],
      ["mirrors.set_mirror_on_open", { teamId: teams["FE"], on: true }],
      ["mirrors.remove_mapping", { teamId: teams["FE"] }],
    ] as const) {
      await expect(install.execute(id, token, input), id).rejects.toMatchObject({ status: 404 });
    }
  });
});

describe("the teams page", () => {
  const page = (session: WebSessionCaller) =>
    createTeamsRoute({ execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
  const post = (session: WebSessionCaller, fields: Record<string, string>) =>
    page(session)(
      new Request(`${URL_OF_INSTALL}${TEAMS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ csrf: csrfTokenFor(install.authSecret, session.sessionId), ...fields }).toString(),
      }),
    );

  it("shows an admin each team's mapping, and for a team that maps none, a form with the covered repositories, mirroring on claim", async () => {
    const answer = await page(ada)(new Request(`${URL_OF_INSTALL}${TEAMS_PATH}`));
    expect(answer.status).toBe(200);
    const html = await answer.text();
    expect(html).toContain("acme/fe-intake");
    expect(html).toContain('<option value="acme/mobile-intake">acme/mobile-intake</option>');
    expect(html).not.toContain('value="acme/secret-intake"');
    expect(html).toMatch(/<input type="checkbox" name="mirrorOnOpen" value="true">/);
    expect(html).not.toMatch(/name="mirrorOnOpen" value="true" checked/);
  });

  it("maps a team from its form, and removes the mapping from its own", async () => {
    const mapped = await post(ada, { action: "map_repository", teamId: teams["MOBILE"]!, repository: "acme/mobile-intake" });
    expect(mapped.status).toBe(303);
    expect(await mappingsOf(teams["MOBILE"]!)).toEqual([expect.objectContaining({ target_name: "acme/mobile-intake", mirror_on_open: false })]);
    expect((await post(ada, { action: "set_mirror_on_open", teamId: teams["MOBILE"]!, on: "true" })).status).toBe(303);
    expect((await mappingsOf(teams["MOBILE"]!))[0]?.mirror_on_open).toBe(true);
    // The setting for tracker "Done" proposals, off in a new mapping, which the page offers to turn on.
    const html = await (await page(ada)(new Request(`${URL_OF_INSTALL}${TEAMS_PATH}`))).text();
    expect(html).toContain("Make a close of MOBILE&#39;s mirror issues by its members propose done");
    expect((await post(ada, { action: "set_done_proposals", teamId: teams["MOBILE"]!, on: "true" })).status).toBe(303);
    const { rows } = await install.owner.query("SELECT done_proposals FROM tracker_mappings WHERE team_id = $1", [teams["MOBILE"]]);
    expect(rows).toEqual([{ done_proposals: true }]);
    expect((await post(ayse, { action: "set_done_proposals", teamId: teams["MOBILE"]!, on: "false" })).status).toBe(403);
    expect((await post(ada, { action: "remove_mapping", teamId: teams["MOBILE"]! })).status).toBe(303);
    expect(await mappingsOf(teams["MOBILE"]!)).toEqual([]);
  });

  it("refuses a member's form with 403, and maps nothing", async () => {
    const refused = await post(ayse, { action: "map_repository", teamId: teams["MOBILE"]!, repository: "acme/mobile-intake" });
    expect(refused.status).toBe(403);
    expect(await mappingsOf(teams["MOBILE"]!)).toEqual([]);
  });

  // Mirror issues copy each request's title into the intake repository, so a public one shows the titles to anyone:
  // the page says which covered repositories GitHub reports public, and warns about a team's public intake repository.
  it("marks the covered repositories GitHub reports public, and warns that a public intake repository shows its team's titles to anyone", async () => {
    const { rows } = await install.owner.query("SELECT full_name, private FROM github_covered_repositories WHERE full_name LIKE 'acme/%-intake' ORDER BY full_name");
    expect(rows).toEqual([
      { full_name: "acme/fe-intake", private: true },
      { full_name: "acme/mobile-intake", private: true },
      { full_name: "acme/open-intake", private: false },
    ]);
    const before = await (await page(ada)(new Request(`${URL_OF_INSTALL}${TEAMS_PATH}`))).text();
    expect(before).toContain('<option value="acme/open-intake">acme/open-intake (public)</option>');
    expect(before).toContain('<option value="acme/mobile-intake">acme/mobile-intake</option>');
    expect((await post(ada, { action: "map_repository", teamId: teams["OPEN"]!, repository: "acme/open-intake" })).status).toBe(303);
    const after = (await (await page(ada)(new Request(`${URL_OF_INSTALL}${TEAMS_PATH}`))).text()).replace(/&#39;/g, "'");
    expect(after).toContain("acme/open-intake is public on GitHub: anyone can read the titles of OPEN's requests, which its mirror issues copy there.");
    expect(after).not.toContain("acme/fe-intake is public");
    expect((await post(ada, { action: "remove_mapping", teamId: teams["OPEN"]! })).status).toBe(303);
  });
});

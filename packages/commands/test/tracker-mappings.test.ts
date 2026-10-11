import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTeamsRoute, csrfTokenFor, mirrorRequest, syncMirror, TEAMS_PATH, type WebSessionCaller } from "../src/index.ts";
import { providerOnStub } from "./support/contract.ts";
import { FakeTracker } from "./support/fake-tracker.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
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
// before it (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (75)).
describe("a mapping removed, and one made later", () => {
  beforeAll(async () => {
    for (const key of ["WEB", "APP"]) {
      teams[key] = await addTeam(install.owner, key);
      await joinTeams(install.owner, ayse.userId, teams[key]!);
    }
  });

  it("stops every write to the mirror issues the removed mapping made", async () => {
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

  // An expected failure: the mirror job that a later write of a request claimed before the mapping sends makes its
  // issue, since the job counts any claim since the request's last reassignment, whenever it was made. D55 (75) reads
  // this as a rule the code keeps already, so no task of decisions-from-groups-15-28 changes it; the maintainer decides
  // how it is built.
  it.fails("makes no issue for a request claimed before it when a later write wakes the request's mirror job", async () => {
    await install.execute("mirrors.remove_mapping", ada, { teamId: teams["APP"] });
    const before = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "APP" });
    await install.execute("requests.claim", ayse, { key: before.key });
    await install.execute("mirrors.map_repository", ada, { teamId: teams["APP"], repository: "acme/mobile-intake" });
    install.sentJobs.splice(0);

    await install.execute("requests.set_status", ayse, { key: before.key, state: "in_progress" });
    await runSentMirrorJobs();

    expect(tracker.issues).toEqual([]);
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

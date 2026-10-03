import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub, type StubIssue } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitHubIssues, createInstallGitHub, processDelivery, syncMirror, type GitHubAppAccess, type WebSessionCaller } from "../src/index.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { storeDelivery } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequestInTheWebUi, sessionOf, tokenOf } from "./support/requests.ts";

// Reassignment moves the mirror (tracker-mirrors: Reassignment moves the
// mirror; tracker-mirrors: Mirror issues are created on claim by default).
// When a confirmed reassignment moves a mirrored request to another team, its
// GitHub mirror issue in the old team's intake repository gets a notice of the
// reassignment and is closed as not planned, and the request gets a new mirror
// issue, under its new key, in the new team's intake repository, under the new
// team's own rule: once someone claims it there, by default, or at once when
// the new team mirrors on open. Undoing the reassignment within its undo
// window restores the old mirror: the old issue is reopened, gets a notice of
// the undo and the label of the restored state, and the new team's issue gets
// a notice of the undo and is closed as not planned. A reassignment back to
// the old team later, which is no undo, gives the request a new key there, and
// so a new issue. FE maps acme/fe-intake and MOBILE maps acme/mobile-intake.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let ada: WebSessionCaller;
let alice: string;
let ayse: string;
let mo: string;
let mobile: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["ayse", "mo"], { hook: true, repositories: ["acme/fe-intake", "acme/mobile-intake"] });
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  alice = await addUser(install.owner, { login: "alice" });
  ayse = await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") });
  mo = await addUser(install.owner, { login: "mo", githubAccountId: provider.account("mo") });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  mobile = await addTeam(install.owner, "MOBILE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, ayse, fe);
  await joinTeams(install.owner, mo, mobile);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
  await install.execute("mirrors.map_repository", ada, { teamId: mobile, repository: "acme/mobile-intake" });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(async () => {
  install.sentJobs.splice(0);
  await install.execute("mirrors.set_mirror_on_open", ada, { teamId: mobile, on: false });
});

async function sync(requestId: string, through?: GitHubAppAccess): Promise<void> {
  const app = through ?? (await provider.github.app())!;
  await syncMirror({ database: install.db, adapters: { github: createGitHubIssues({ app, database: install.db }) }, installUrl: URL_OF_INSTALL, logger: install.logger }, requestId);
  await stub.settled();
}

/** A request Alice opens to FE, which Ayşe claims and starts, with its mirror issue in acme/fe-intake. */
async function mirroredRequest(): Promise<{ key: string; id: string; issue: StubIssue }> {
  const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
  await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
  await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "in_progress" });
  await sync(request.id);
  const [issue] = await issuesOf(request.id, "acme/fe-intake");
  return { ...request, issue: issue! };
}

/** The request's mirror issues in a repository, oldest first. */
async function issuesOf(requestId: string, repository: string): Promise<StubIssue[]> {
  const { rows } = await install.owner.query<{ issue: string }>(
    `SELECT m.issue FROM mirrors m JOIN github_covered_repositories r ON r.repository_id::text = m.target
      WHERE m.request_id = $1 AND r.full_name = $2 AND m.issue IS NOT NULL ORDER BY m.created_at`,
    [requestId, repository],
  );
  return rows.map(({ issue }) => stub.issue(repository, Number(issue)));
}

/** Ayşe proposes to reassign the request to MOBILE and confirms it; returns the proposal's id. */
async function reassignToMobile(key: string): Promise<string> {
  const proposed = await callApi(install, tokenOf(ayse), "POST", `/api/v1/requests/${key}/proposals`, { kind: "reassign", team: "MOBILE" });
  expect(proposed.status).toBe(202);
  expect((await install.confirm(sessionOf(ayse), "proposals.confirm", { proposal: proposed.body.proposal.id })).status).toBe(200);
  return proposed.body.proposal.id as string;
}

async function keyOf(requestId: string): Promise<string> {
  const { rows } = await install.owner.query<{ key: string }>("SELECT t.key || '-' || r.number AS key FROM requests r JOIN teams t ON t.id = r.target_team_id WHERE r.id = $1", [requestId]);
  return rows[0]!.key;
}

const commentsOf = (issue: StubIssue) => issue.comments.map(({ body }) => body.replace(/\n\n<!-- tiehall:mirror-comment [0-9a-f-]+ -->$/, ""));

describe("a confirmed reassignment of a mirrored request", () => {
  it("closes the old issue as not planned with a notice of it, and mirrors the request in MOBILE's repository once someone claims it there", async () => {
    const request = await mirroredRequest();
    const before = request.issue.comments.length;

    await reassignToMobile(request.key);
    await sync(request.id);

    const newKey = await keyOf(request.id);
    expect(newKey).toMatch(/^MOBILE-\d+$/);
    expect(request.issue.state).toBe("closed");
    expect(request.issue.stateReason).toBe("not_planned");
    expect(commentsOf(request.issue).slice(before)).toEqual([
      `${request.key} was reassigned to team MOBILE in Tiehall, as ${newKey}, and this issue no longer follows it: ${URL_OF_INSTALL}/${newKey}`,
    ]);
    // MOBILE mirrors on claim, and the request is open and unclaimed there.
    expect(await issuesOf(request.id, "acme/mobile-intake")).toEqual([]);

    await install.execute("requests.claim", sessionOf(mo), { key: newKey });
    await sync(request.id);

    const [created] = await issuesOf(request.id, "acme/mobile-intake");
    expect(created?.title).toBe(`${newKey}: Add a dark mode`);
    expect(created?.labels).toEqual(["tiehall:claimed"]);
    expect(created?.body).toContain(`${URL_OF_INSTALL}/${newKey}`);
    // The old issue follows the request no more: MOBILE's claim adds nothing to it.
    expect(commentsOf(request.issue).slice(before)).toHaveLength(1);
    expect(request.issue.state).toBe("closed");
  });

  it("mirrors the request at once in the repository of a new team that mirrors on open", async () => {
    await install.execute("mirrors.set_mirror_on_open", ada, { teamId: mobile, on: true });
    const request = await mirroredRequest();

    await reassignToMobile(request.key);
    await sync(request.id);

    const [created] = await issuesOf(request.id, "acme/mobile-intake");
    expect(created?.title).toBe(`${await keyOf(request.id)}: Add a dark mode`);
    expect(created?.state).toBe("open");
    expect(created?.labels).toEqual(["tiehall:open"]);
    expect(request.issue.stateReason).toBe("not_planned");
  });

  it("drops the echo of its own close of the old issue", async () => {
    const request = await mirroredRequest();
    const from = stub.deliveries(provider.app).length;
    await reassignToMobile(request.key);
    await sync(request.id);

    for (const delivery of stub.deliveries(provider.app).slice(from)) {
      if (delivery.event !== "issues") continue;
      await processDelivery({ database: install.db, github: provider.github, execute: install.execute }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));
    }

    const { rows } = await install.owner.query("SELECT 1 FROM events WHERE type = 'request.tracker_changed' AND data ->> 'requestId' = $1", [request.id]);
    expect(rows).toEqual([]);
  });
});

describe("undoing the reassignment", () => {
  it("reopens the old issue with a notice and the restored state's label, and closes the new team's issue as not planned with a notice", async () => {
    await install.execute("mirrors.set_mirror_on_open", ada, { teamId: mobile, on: true });
    const request = await mirroredRequest();
    const proposal = await reassignToMobile(request.key);
    await sync(request.id);
    const newKey = await keyOf(request.id);
    const [created] = await issuesOf(request.id, "acme/mobile-intake");
    const fromOld = request.issue.comments.length;
    const fromNew = created!.comments.length;

    expect((await install.confirm(sessionOf(ayse), "proposals.undo", { proposal })).status).toBe(200);
    await sync(request.id);

    expect(await keyOf(request.id)).toBe(request.key);
    expect(request.issue.state).toBe("open");
    expect(request.issue.labels).toEqual(["tiehall:in_progress"]);
    expect(commentsOf(request.issue).slice(fromOld)).toEqual([
      `The reassignment of ${request.key} to team MOBILE was undone in Tiehall: this issue follows ${request.key} again, which is in_progress: ${URL_OF_INSTALL}/${request.key}`,
    ]);
    expect(created?.state).toBe("closed");
    expect(created?.stateReason).toBe("not_planned");
    expect(commentsOf(created!).slice(fromNew)).toEqual([
      `The reassignment that made this request ${newKey} was undone in Tiehall: it is ${request.key} again, with team FE, and this issue no longer follows it: ${URL_OF_INSTALL}/${request.key}`,
    ]);
    // Still one mirror issue in each repository.
    expect(await issuesOf(request.id, "acme/fe-intake")).toHaveLength(1);
    expect(await issuesOf(request.id, "acme/mobile-intake")).toHaveLength(1);
  });

  it("closes with a notice the new team's issue whose create GitHub made but whose answer never reached Tiehall", async () => {
    await install.execute("mirrors.set_mirror_on_open", ada, { teamId: mobile, on: true });
    const request = await mirroredRequest();
    const proposal = await reassignToMobile(request.key);
    const newKey = await keyOf(request.id);
    // GitHub makes MOBILE's issue, but its answer never reaches Tiehall: the job fails and waits for its retry.
    let dropped = false;
    const losing: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!dropped && (init?.method ?? "GET") === "POST" && url.pathname.endsWith("/mobile-intake/issues")) {
        dropped = true;
        throw new TypeError("fetch failed: the connection was reset");
      }
      return response;
    };
    const lossy = createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: stub.apiUrl, fetch: losing, logger: install.logger });
    await expect(sync(request.id, (await lossy.app())!)).rejects.toThrow();

    // Before the retry, Ayşe undoes the reassignment.
    expect((await install.confirm(sessionOf(ayse), "proposals.undo", { proposal })).status).toBe(200);
    await sync(request.id);
    await sync(request.id);

    // Every issue of acme/mobile-intake, as GitHub lists them, not only those Tiehall knows.
    const app = (await provider.github.app())!;
    const { data } = await app.client
      .installation(stub.installations(provider.app)[0]!.id)
      .request("GET /repos/{owner}/{repo}/issues", { owner: "acme", repo: "mobile-intake", state: "all", per_page: 100 });
    const made = (data as { number: number; title: string }[]).filter(({ title }) => title.startsWith(`${newKey}:`));
    expect(made).toHaveLength(1);
    const issue = stub.issue("acme/mobile-intake", made[0]!.number);
    expect({ state: issue.state, stateReason: issue.stateReason }).toEqual({ state: "closed", stateReason: "not_planned" });
    expect(commentsOf(issue)).toEqual([
      `The reassignment that made this request ${newKey} was undone in Tiehall: it is ${request.key} again, with team FE, and this issue no longer follows it: ${URL_OF_INSTALL}/${request.key}`,
    ]);
    expect(await keyOf(request.id)).toBe(request.key);
    expect(request.issue.state).toBe("open");
  });

  it("leaves nothing in the new team's repository when its create failed before GitHub made the issue", async () => {
    await install.execute("mirrors.set_mirror_on_open", ada, { teamId: mobile, on: true });
    const request = await mirroredRequest();
    const proposal = await reassignToMobile(request.key);
    const newKey = await keyOf(request.id);
    const refusing: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/mobile-intake/issues")) throw new TypeError("fetch failed: the connection was refused");
      return fetch(input, init);
    };
    const refused = createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: stub.apiUrl, fetch: refusing, logger: install.logger });
    await expect(sync(request.id, (await refused.app())!)).rejects.toThrow();

    expect((await install.confirm(sessionOf(ayse), "proposals.undo", { proposal })).status).toBe(200);
    await sync(request.id);
    await sync(request.id);

    const app = (await provider.github.app())!;
    const { data } = await app.client
      .installation(stub.installations(provider.app)[0]!.id)
      .request("GET /repos/{owner}/{repo}/issues", { owner: "acme", repo: "mobile-intake", state: "all", per_page: 100 });
    expect((data as { title: string }[]).filter(({ title }) => title.startsWith(`${newKey}:`))).toEqual([]);
    const { rows } = await install.owner.query("SELECT issue, away FROM mirrors WHERE request_id = $1 AND team_id = $2", [request.id, mobile]);
    expect(rows).toEqual([{ issue: null, away: true }]);
  });

  it("restores the old mirror even when the job runs only after both the reassignment and its undo", async () => {
    const request = await mirroredRequest();
    const before = request.issue.comments.length;
    const proposal = await reassignToMobile(request.key);
    expect((await install.confirm(sessionOf(ayse), "proposals.undo", { proposal })).status).toBe(200);

    await sync(request.id);

    expect(request.issue.state).toBe("open");
    expect(request.issue.labels).toEqual(["tiehall:in_progress"]);
    // Nothing the old issue shows changed in the end, so it got no notice, and the request went nowhere it is mirrored.
    expect(commentsOf(request.issue).slice(before)).toEqual([]);
    expect(await issuesOf(request.id, "acme/mobile-intake")).toEqual([]);
  });
});

describe("a later reassignment back to the old team", () => {
  it("gives the request a new key there, and with it a new issue, while the old one stays closed", async () => {
    const request = await mirroredRequest();
    await reassignToMobile(request.key);
    await sync(request.id);
    const mobileKey = await keyOf(request.id);
    // The undo window passes; then MOBILE sends it back to FE.
    await install.owner.query("UPDATE applied_commitments SET applied_at = applied_at - interval '1 hour'");
    await install.execute("requests.claim", sessionOf(mo), { key: mobileKey });
    await sync(request.id);
    expect(await issuesOf(request.id, "acme/mobile-intake")).toHaveLength(1);
    const back = await callApi(install, tokenOf(mo), "POST", `/api/v1/requests/${mobileKey}/proposals`, { kind: "reassign", team: "FE" });
    expect(back.status).toBe(202);
    expect((await install.confirm(sessionOf(mo), "proposals.confirm", { proposal: back.body.proposal.id })).status).toBe(200);
    const feKey = await keyOf(request.id);
    expect(feKey).not.toBe(request.key);

    await install.execute("requests.claim", sessionOf(ayse), { key: feKey });
    await sync(request.id);

    const issues = await issuesOf(request.id, "acme/fe-intake");
    expect(issues.map(({ title, state }) => ({ title, state }))).toEqual([
      { title: `${request.key}: Add a dark mode`, state: "closed" },
      { title: `${feKey}: Add a dark mode`, state: "open" },
    ]);
    expect((await issuesOf(request.id, "acme/mobile-intake")).map(({ state, stateReason }) => ({ state, stateReason }))).toEqual([{ state: "closed", stateReason: "not_planned" }]);
  });
});

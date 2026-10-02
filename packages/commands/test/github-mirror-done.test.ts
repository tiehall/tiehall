import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitHubIssues, processDelivery, syncMirror, type WebSessionCaller } from "../src/index.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { storeDelivery } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// A tracker "Done" (tracker-mirrors: A tracker "Done" never closes a request
// by itself; github-layer-hardening: design.md, Technical decisions: T7). A
// GitHub mirror issue closed as completed is a tracker "Done", which never
// moves its request to done. With the team's setting for tracker "Done"
// proposals off, which it is until an admin turns it on, the close only adds
// a notice to the request's thread. With it on, a close by the GitHub account
// of a member of the request's target team becomes a done proposal for that
// member, who confirms it in the web UI, when the request's state allows
// done; a close on an open request, by someone outside the target team, by an
// account that is no member's, or by a member who was removed since, only
// adds a notice. A close as not planned is no "Done": it is recorded, and adds
// nothing else. The GitHub stub plays GitHub: Ayşe and Deniz are members of
// FE, Alice of BE, and Omar's GitHub account is no member's.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let ada: WebSessionCaller;
let alice: string;
let ayse: string;
let deniz: string;
let fe: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["alice", "ayse", "deniz", "omar"], { hook: true, repositories: ["acme/fe-intake"] });
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  alice = await addUser(install.owner, { login: "alice", githubAccountId: provider.account("alice") });
  ayse = await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") });
  deniz = await addUser(install.owner, { login: "deniz", githubAccountId: provider.account("deniz") });
  const be = await addTeam(install.owner, "BE");
  fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, ayse, fe);
  await joinTeams(install.owner, deniz, fe);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(async () => {
  install.sentJobs.splice(0);
  await install.execute("mirrors.set_done_proposals", ada, { teamId: fe, on: false });
  await install.execute("mirrors.set_mirror_on_open", ada, { teamId: fe, on: false });
});

async function sync(requestId: string): Promise<void> {
  const app = (await provider.github.app())!;
  await syncMirror({ database: install.db, adapters: { github: createGitHubIssues({ app, database: install.db }) }, installUrl: URL_OF_INSTALL, logger: install.logger }, requestId);
}

/** A request Alice opens to FE, which Ayşe claims and starts unless it stays open, with its mirror issue made. */
async function mirroredRequest(state: "open" | "in_progress" = "in_progress"): Promise<{ key: string; id: string; number: number }> {
  const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
  if (state === "in_progress") {
    await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
    await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "in_progress" });
  }
  await sync(request.id);
  await stub.settled();
  const { rows } = await install.owner.query<{ issue: string }>("SELECT issue FROM mirrors WHERE request_id = $1", [request.id]);
  return { ...request, number: Number(rows[0]?.issue) };
}

/** Someone closes the mirror issue on GitHub, and the worker processes GitHub's delivery of it. */
async function closedOnGitHub(number: number, by: string, reason: "completed" | "not_planned" = "completed"): Promise<void> {
  const from = stub.deliveries(provider.app).length;
  await stub.closeIssue("acme/fe-intake", number, { by, reason });
  await stub.settled();
  for (const delivery of stub.deliveries(provider.app).slice(from)) {
    if (delivery.event !== "issues") continue;
    await processDelivery({ database: install.db, github: provider.github, execute: install.execute }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));
  }
}

async function stateOf(id: string): Promise<string> {
  const { rows } = await install.owner.query<{ state: string }>("SELECT state FROM requests WHERE id = $1", [id]);
  return rows[0]!.state;
}

async function proposalsOf(id: string) {
  const { rows } = await install.owner.query(
    "SELECT id, kind, accountable_user_id, actor_kind, surface, state FROM proposals WHERE request_id = $1 ORDER BY created_at",
    [id],
  );
  return rows;
}

/** The notices Tiehall added to the request's thread, by their text. */
async function noticesOf(id: string): Promise<string[]> {
  const { rows } = await install.owner.query<{ body: string }>(
    `SELECT v.body FROM messages m JOIN message_versions v ON v.message_id = m.id
      WHERE m.request_id = $1 AND m.actor_kind = 'system' ORDER BY m.number`,
    [id],
  );
  return rows.map(({ body }) => body);
}

async function closesOf(id: string) {
  const { rows } = await install.owner.query(
    "SELECT data ->> 'change' AS change, data ->> 'reason' AS reason, actor_kind, surface, actor_user_id FROM events WHERE type = 'request.tracker_changed' AND data ->> 'requestId' = $1",
    [id],
  );
  return rows;
}

describe("the setting for tracker \"Done\" proposals", () => {
  it("is off in a new mapping, and only an admin turns it on, in the web UI", async () => {
    const { mappings } = (await install.execute("mirrors.list_mappings", ada, {}, { readOnly: true })) as { mappings: { teamId: string; doneProposals: boolean }[] };
    expect(mappings.find(({ teamId }) => teamId === fe)?.doneProposals).toBe(false);
    await expect(install.execute("mirrors.set_done_proposals", sessionOf(ayse), { teamId: fe, on: true })).rejects.toMatchObject({ status: 403 });
    expect(await install.execute("mirrors.set_done_proposals", ada, { teamId: fe, on: true })).toMatchObject({ teamId: fe, doneProposals: true });
  });
});

describe("with the setting off", () => {
  it("a close by a member of the target team only adds a notice", async () => {
    const request = await mirroredRequest();

    await closedOnGitHub(request.number, "ayse");

    expect(await stateOf(request.id)).toBe("in_progress");
    expect(await proposalsOf(request.id)).toEqual([]);
    expect(await noticesOf(request.id)).toEqual([
      `The GitHub mirror issue of ${request.key} was closed. A close in GitHub does not change the request: ${request.key} is still in_progress.`,
    ]);
    expect(await closesOf(request.id)).toEqual([{ change: "closed", reason: "completed", actor_kind: "integration", surface: "github", actor_user_id: ayse }]);
  });
});

describe("with the setting on", () => {
  beforeEach(async () => {
    await install.execute("mirrors.set_done_proposals", ada, { teamId: fe, on: true });
  });

  it("a close by a member of the target team becomes a done proposal for them, which they confirm in the web UI", async () => {
    const request = await mirroredRequest();

    await closedOnGitHub(request.number, "ayse");

    const proposals = await proposalsOf(request.id);
    expect(proposals).toEqual([{ id: expect.any(String), kind: "done", accountable_user_id: ayse, actor_kind: "integration", surface: "github", state: "pending" }]);
    expect(await stateOf(request.id)).toBe("in_progress");
    expect(await noticesOf(request.id)).toEqual([]);

    expect((await install.confirm(sessionOf(ayse), "proposals.confirm", { proposal: proposals[0].id })).status).toBe(200);
    expect(await stateOf(request.id)).toBe("done");
  });

  it("a close on an open request only adds a notice", async () => {
    await install.execute("mirrors.set_mirror_on_open", ada, { teamId: fe, on: true });
    const request = await mirroredRequest("open");

    await closedOnGitHub(request.number, "ayse");

    expect(await proposalsOf(request.id)).toEqual([]);
    expect(await stateOf(request.id)).toBe("open");
    expect(await noticesOf(request.id)).toEqual([
      `The GitHub mirror issue of ${request.key} was closed. A close in GitHub does not change the request: ${request.key} is still open.`,
    ]);
  });

  it("a close by someone outside the target team, such as its requester, only adds a notice", async () => {
    const request = await mirroredRequest();

    await closedOnGitHub(request.number, "alice");

    expect(await proposalsOf(request.id)).toEqual([]);
    expect(await stateOf(request.id)).toBe("in_progress");
    expect(await noticesOf(request.id)).toHaveLength(1);
  });

  it("a close by a GitHub account that is no member's only adds a notice, recorded for no user", async () => {
    const request = await mirroredRequest();

    await closedOnGitHub(request.number, "omar");

    expect(await proposalsOf(request.id)).toEqual([]);
    expect(await noticesOf(request.id)).toHaveLength(1);
    expect(await closesOf(request.id)).toEqual([{ change: "closed", reason: "completed", actor_kind: "integration", surface: "github", actor_user_id: null }]);
  });

  it("a close by a member of the target team who was removed since only adds a notice, recorded for no user", async () => {
    const request = await mirroredRequest();
    await install.owner.query("DELETE FROM members WHERE user_id = $1", [deniz]);

    await closedOnGitHub(request.number, "deniz");

    expect(await proposalsOf(request.id)).toEqual([]);
    expect(await noticesOf(request.id)).toHaveLength(1);
    expect(await closesOf(request.id)).toEqual([{ change: "closed", reason: "completed", actor_kind: "integration", surface: "github", actor_user_id: null }]);
  });

  it("a close as not planned is no Done: it is recorded, and adds no proposal and no notice", async () => {
    const request = await mirroredRequest();

    await closedOnGitHub(request.number, "ayse", "not_planned");

    expect(await proposalsOf(request.id)).toEqual([]);
    expect(await noticesOf(request.id)).toEqual([]);
    expect(await stateOf(request.id)).toBe("in_progress");
    expect(await closesOf(request.id)).toEqual([{ change: "closed", reason: "not_planned", actor_kind: "integration", surface: "github", actor_user_id: ayse }]);
  });
});

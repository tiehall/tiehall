import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitHubIssues, processDelivery, syncMirror, type WebSessionCaller } from "../src/index.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { storeDelivery } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// Changes made to a mirror issue on GitHub (tracker-mirrors: Inbound tracker
// changes are recorded, not applied; tracker-mirrors: Tracker comments are not
// imported). A close, a reopen and a change of the issue's assignees are each
// recorded on the request as an event of the integration, with the surface
// github, acting for the member whose GitHub account made the change, and
// Tiehall's record of the change names the GitHub accounts it was about; the
// request changes in nothing else: not its state, its thread or its
// proposals. An edit of the issue's title, and a comment on it, change
// nothing at all. The GitHub stub plays GitHub and logs its deliveries, which
// the test stores and processes as the worker does.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let alice: string;
let ayse: string;
let installationId: number;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["ayse", "omar"], { hook: true, repositories: ["acme/fe-intake"] });
  installationId = stub.installations(provider.app)[0]!.id;
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  alice = await addUser(install.owner, { login: "alice" });
  ayse = await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, ayse, fe);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
});

async function sync(requestId: string): Promise<void> {
  const app = (await provider.github.app())!;
  await syncMirror({ database: install.db, adapters: { github: createGitHubIssues({ app, database: install.db }) }, installUrl: URL_OF_INSTALL, logger: install.logger }, requestId);
}

/** A request Alice opens to FE, which Ayşe claims and starts, with its mirror issue made; its key, id and issue number. */
async function mirroredRequest(): Promise<{ key: string; id: string; number: number }> {
  const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
  await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
  await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "in_progress" });
  await sync(request.id);
  await stub.settled();
  const { rows } = await install.owner.query<{ issue: string }>("SELECT issue FROM mirrors WHERE request_id = $1", [request.id]);
  return { ...request, number: Number(rows[0]?.issue) };
}

/** Processes, as the worker does, the `issues` deliveries about the issue that `change` makes GitHub send. */
async function processChange(number: number, change: () => Promise<unknown>): Promise<void> {
  const from = stub.deliveries(provider.app).length;
  await change();
  await stub.settled();
  for (const delivery of stub.deliveries(provider.app).slice(from)) {
    if (delivery.event !== "issues" || (delivery.request.payload as { issue?: { number?: number } }).issue?.number !== number) continue;
    await processDelivery({ database: install.db, github: provider.github, execute: install.execute }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));
  }
}

/** The request's events of tracker changes, with their provenance, and Tiehall's records of the changes they name. */
async function trackerEventsOf(requestId: string) {
  const { rows } = await install.owner.query(
    `SELECT e.data, e.actor_kind, e.surface, e.actor_user_id, c.change, c.reason, c.actor, c.assignees
       FROM events e JOIN tracker_changes c ON c.id = (e.data ->> 'trackerChangeId')::uuid
      WHERE e.type = 'request.tracker_changed' AND e.data ->> 'requestId' = $1 ORDER BY e.number`,
    [requestId],
  );
  return rows;
}

async function requestOf(id: string): Promise<{ state: string; claimant_user_id: string | null; messages: number; proposals: number }> {
  const { rows } = await install.owner.query(
    `SELECT r.state, r.claimant_user_id, (SELECT count(*)::int FROM messages m WHERE m.request_id = r.id) AS messages,
            (SELECT count(*)::int FROM proposals p WHERE p.request_id = r.id) AS proposals
       FROM requests r WHERE r.id = $1`,
    [id],
  );
  return rows[0];
}

describe("a close of the mirror issue", () => {
  it("is recorded as the integration from GitHub, for the member who closed it, and changes nothing else", async () => {
    const request = await mirroredRequest();
    const before = await requestOf(request.id);

    await processChange(request.number, () => stub.closeIssue("acme/fe-intake", request.number, { by: "ayse", reason: "not_planned" }));

    const recorded = await trackerEventsOf(request.id);
    expect(recorded).toEqual([
      {
        data: { requestId: request.id, mirrorId: expect.any(String), trackerChangeId: expect.any(String), change: "closed", reason: "not_planned" },
        actor_kind: "integration",
        surface: "github",
        actor_user_id: ayse,
        change: "closed",
        reason: "not_planned",
        actor: { id: String(provider.account("ayse")), login: "ayse" },
        assignees: null,
      },
    ]);
    expect(await requestOf(request.id)).toEqual(before);
  });

  it("is recorded once however often GitHub delivers it", async () => {
    const request = await mirroredRequest();
    await processChange(request.number, async () => {
      await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse", reason: "not_planned" });
      // GitHub delivers the same change again, as a redelivery or a late delivery does.
      await stub.deliver(provider.app, "issues", {
        action: "closed",
        issue: { number: request.number },
        repository: { id: Number((await install.owner.query("SELECT target FROM mirrors WHERE request_id = $1", [request.id])).rows[0].target) },
        installation: { id: installationId },
        sender: { id: provider.account("ayse"), login: "ayse", type: "User" },
      }, { delivery: "drop" });
    });
    expect((await trackerEventsOf(request.id)).map(({ change }) => change)).toEqual(["closed"]);
  });
});

describe("a reopen of the mirror issue", () => {
  it("is recorded with the surface github, and the request's state does not change", async () => {
    const request = await mirroredRequest();
    await processChange(request.number, () => stub.closeIssue("acme/fe-intake", request.number, { by: "ayse", reason: "not_planned" }));

    await processChange(request.number, () => stub.reopenIssue("acme/fe-intake", request.number, { by: "ayse" }));

    const recorded = await trackerEventsOf(request.id);
    expect(recorded.map(({ data, actor_kind, surface, actor_user_id }) => ({ change: data.change, actor_kind, surface, actor_user_id }))).toEqual([
      { change: "closed", actor_kind: "integration", surface: "github", actor_user_id: ayse },
      { change: "reopened", actor_kind: "integration", surface: "github", actor_user_id: ayse },
    ]);
    expect((await requestOf(request.id)).state).toBe("in_progress");
  });
});

describe("a change of the mirror issue's assignees", () => {
  it("is recorded with the accounts it is assigned to now, and changes nothing else", async () => {
    const request = await mirroredRequest();
    const before = await requestOf(request.id);

    await processChange(request.number, () => stub.assignIssue("acme/fe-intake", request.number, { by: "ayse", assignees: ["ayse", "omar"] }));

    const recorded = await trackerEventsOf(request.id);
    expect(recorded.map(({ data, actor_kind, surface, assignees }) => ({ change: data.change, reason: data.reason, actor_kind, surface, assignees }))).toEqual([
      {
        change: "assignees_changed",
        reason: undefined,
        actor_kind: "integration",
        surface: "github",
        assignees: [
          { id: String(provider.account("ayse")), login: "ayse" },
          { id: String(provider.account("omar")), login: "omar" },
        ],
      },
    ]);
    expect(await requestOf(request.id)).toEqual(before);
  });
});

describe("who a change is recorded for", () => {
  it("is the account that changed the assignees of a closed issue, not the one that closed it", async () => {
    const request = await mirroredRequest();
    await processChange(request.number, () => stub.closeIssue("acme/fe-intake", request.number, { by: "ayse", reason: "not_planned" }));
    // Omar, whose GitHub account is no member's, changes the assignees of the closed issue.
    await processChange(request.number, () => stub.assignIssue("acme/fe-intake", request.number, { by: "omar", assignees: ["omar"] }));

    const recorded = await trackerEventsOf(request.id);
    expect(recorded.map(({ data, actor_user_id, actor }) => ({ change: data.change, actor_user_id, actor: actor?.login }))).toEqual([
      { change: "closed", actor_user_id: ayse, actor: "ayse" },
      { change: "assignees_changed", actor_user_id: null, actor: "omar" },
    ]);
  });

  it("is, for each change a delivery's read shows, the account that made that change", async () => {
    const request = await mirroredRequest();
    const from = stub.deliveries(provider.app).length;
    await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse", reason: "completed" });
    await stub.assignIssue("acme/fe-intake", request.number, { by: "omar", assignees: ["omar"] });
    await stub.settled();
    const deliveries = stub
      .deliveries(provider.app)
      .slice(from)
      .filter(({ event, request: { payload } }) => event === "issues" && (payload as { issue?: { number?: number } }).issue?.number === request.number);
    // GitHub does not promise the order of its deliveries: Omar's comes first, and its read shows Ayşe's close too.
    for (const delivery of deliveries.reverse()) {
      await processDelivery({ database: install.db, github: provider.github, execute: install.execute }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));
    }

    const recorded = await trackerEventsOf(request.id);
    expect(recorded.map(({ data, actor_user_id, actor }) => ({ change: data.change, actor_user_id, actor: actor?.login ?? null }))).toEqual([
      { change: "closed", actor_user_id: ayse, actor: "ayse" },
      { change: "assignees_changed", actor_user_id: null, actor: "omar" },
    ]);
  });
});

describe("what else changes on GitHub", () => {
  it("changes nothing: an edit of the issue's title, and a comment on it", async () => {
    const request = await mirroredRequest();
    const before = await requestOf(request.id);
    const { rows: titled } = await install.owner.query("SELECT title FROM requests WHERE id = $1", [request.id]);
    const app = (await provider.github.app())!;
    const repositoryId = Number((await install.owner.query("SELECT target FROM mirrors WHERE request_id = $1", [request.id])).rows[0].target);

    await processChange(request.number, async () => {
      await app.client
        .installation(installationId)
        .request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { owner: "acme", repo: "fe-intake", issue_number: request.number, title: "Someone's own title" });
      await app.client
        .installation(installationId)
        .request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner: "acme", repo: "fe-intake", issue_number: request.number, body: "Done on our side, I think." });
      // The App subscribes to no comment event; a delivery about the issue that GitHub sent anyway, such as a later edit, reads it as it is.
      await stub.deliver(provider.app, "issues", {
        action: "edited",
        issue: { number: request.number },
        repository: { id: repositoryId },
        installation: { id: installationId },
        sender: { id: provider.account("ayse"), login: "ayse", type: "User" },
      }, { delivery: "drop" });
    });

    expect(await trackerEventsOf(request.id)).toEqual([]);
    expect(await requestOf(request.id)).toEqual(before);
    expect((await install.owner.query("SELECT title FROM requests WHERE id = $1", [request.id])).rows).toEqual(titled);
  });
});

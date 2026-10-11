import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGitHubIssues,
  createInstallGitHub,
  processDelivery,
  processGitHubDelivery,
  reconcileGitHub,
  syncMirror,
  type InstallGitHub,
  type WebSessionCaller,
} from "../src/index.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { storeDelivery } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// The reconciliation of the mirror issues (tracker-mirrors: Reconciliation
// catches missed changes; design.md, Design rules: Tracker mirrors). Every 15
// minutes, in webhook mode as in polling mode, the GitHub reconciliation asks
// GitHub, with its `since` parameter, for the issues of each repository that
// holds mirror issues updated since its previous run, and hands each mirror
// issue among them to the processing a delivery about it goes to, as if its
// webhook had arrived. So a close whose delivery GitHub never brought is
// recorded on the next run, and a change that a delivery and the
// reconciliation both see is recorded once. The GitHub stub plays GitHub: the
// App's webhook points at an install GitHub cannot reach, so the stub logs each
// delivery, which a test stores and processes as the worker does, or not.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let alice: string;
let ayse: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["ayse", "omar"], { hook: true, repositories: ["acme/fe-intake", "acme/fe-notes"] });
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  alice = await addUser(install.owner, { login: "alice" });
  ayse = await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, ayse, fe);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
  // The first run: from here on, each run reads what changed since the one before.
  await reconcile();
  await processSent();
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
});

/** One run of the GitHub reconciliation, as the worker runs it every 15 minutes, reaching GitHub as the install's App. */
async function reconcile(github: InstallGitHub = provider.github, now: () => Date = () => new Date()): Promise<void> {
  await reconcileGitHub.handle(
    { id: randomUUID(), queue: reconcileGitHub.type.queue, data: {}, signal: new AbortController().signal },
    {
      database: install.db,
      now,
      github,
      execute: install.execute,
      jobs: { send: async (_tx, queue, data) => void install.sentJobs.push({ queue, data }) },
    },
  );
}

/** Processes, as the worker does, the changes whose processing jobs were sent; returns their delivery ids. */
async function processSent(): Promise<string[]> {
  const processed: string[] = [];
  for (const job of install.sentJobs.filter(({ queue }) => queue === processGitHubDelivery.type.queue)) {
    install.sentJobs.splice(install.sentJobs.indexOf(job), 1);
    const { deliveryId } = job.data as { deliveryId: string };
    await processDelivery({ database: install.db, github: provider.github, execute: install.execute }, deliveryId);
    processed.push(deliveryId);
  }
  return processed;
}

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
  install.sentJobs.splice(0);
  const { rows } = await install.owner.query<{ issue: string }>("SELECT issue FROM mirrors WHERE request_id = $1", [request.id]);
  return { ...request, number: Number(rows[0]?.issue) };
}

/** Stores and processes, as the worker does, the `issues` deliveries about the issue that GitHub logged since `from`. */
async function processDeliveries(number: number, from: number): Promise<void> {
  for (const delivery of stub.deliveries(provider.app).slice(from)) {
    if (delivery.event !== "issues" || (delivery.request.payload as { issue?: { number?: number } }).issue?.number !== number) continue;
    await processDelivery({ database: install.db, github: provider.github, execute: install.execute }, await storeDelivery(install, { ...delivery, guid: randomUUID() }));
  }
}

/** The request's events of tracker changes: the change, its reason, and whom it acted for. */
async function trackerEventsOf(requestId: string): Promise<{ change: string; reason: string | null; actor_kind: string; surface: string; actor_user_id: string | null }[]> {
  const { rows } = await install.owner.query(
    `SELECT data ->> 'change' AS change, data ->> 'reason' AS reason, actor_kind, surface, actor_user_id
       FROM events WHERE type = 'request.tracker_changed' AND data ->> 'requestId' = $1 ORDER BY number`,
    [requestId],
  );
  return rows;
}

/** The changes about this mirror issue whose processing jobs were sent, by their delivery ids. */
async function sentFor(number: number): Promise<string[]> {
  const sent = install.sentJobs.filter(({ queue }) => queue === processGitHubDelivery.type.queue).map(({ data }) => (data as { deliveryId: string }).deliveryId);
  const { rows } = await install.owner.query<{ delivery_id: string }>(
    "SELECT delivery_id FROM github_deliveries WHERE event = 'issues' AND (payload -> 'issue' ->> 'number')::int = $1 AND delivery_id = ANY($2)",
    [number, sent],
  );
  return rows.map(({ delivery_id }) => delivery_id);
}

/** The listings of acme/fe-intake's issues that GitHub got since `from`, with their query. */
function issueListings(from: number): URLSearchParams[] {
  return stub.received
    .slice(from)
    .filter(({ method, path }) => method === "GET" && path === "/repos/acme/fe-intake/issues")
    .map(({ query }) => new URLSearchParams(query));
}

describe("the reconciliation of the mirror issues", () => {
  it("records, on its next run, a close whose delivery never reached the install", async () => {
    const request = await mirroredRequest();
    await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse", reason: "completed" }, { delivery: "drop" });
    await stub.settled();

    await reconcile();
    expect(await sentFor(request.number)).toHaveLength(1);
    await processSent();

    expect(await trackerEventsOf(request.id)).toEqual([{ change: "closed", reason: "completed", actor_kind: "integration", surface: "github", actor_user_id: ayse }]);
    // As a delivery's processing does: the state stays, and with the setting off the thread gets a notice.
    const { rows } = await install.owner.query<{ state: string }>("SELECT state FROM requests WHERE id = $1", [request.id]);
    expect(rows).toEqual([{ state: "in_progress" }]);
  });

  // A change read by reconciliation acts for the Tiehall user of the account GitHub names as having made it, the
  // closed_by of a closed issue, while that user is a member, and for no user otherwise
  // (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (77)).
  it("records a close it finds for no user when the account GitHub names as its closer is no member's", async () => {
    const request = await mirroredRequest();
    // Omar has a GitHub account and no Tiehall user.
    await stub.closeIssue("acme/fe-intake", request.number, { by: "omar", reason: "completed" }, { delivery: "drop" });
    await stub.settled();

    await reconcile();
    await processSent();

    expect(await trackerEventsOf(request.id)).toEqual([{ change: "closed", reason: "completed", actor_kind: "integration", surface: "github", actor_user_id: null }]);
  });

  it("records a close it finds for no user when the member GitHub names as its closer was removed from the install", async () => {
    const request = await mirroredRequest();
    const zed = await addUser(install.owner, { login: "zed", githubAccountId: stub.addUser({ login: "zed" }).id });
    await install.owner.query("DELETE FROM members WHERE user_id = $1", [zed]);
    await stub.closeIssue("acme/fe-intake", request.number, { by: "zed", reason: "completed" }, { delivery: "drop" });
    await stub.settled();

    await reconcile();
    await processSent();

    expect(await trackerEventsOf(request.id)).toEqual([{ change: "closed", reason: "completed", actor_kind: "integration", surface: "github", actor_user_id: null }]);
  });

  it("records a change once, when its delivery is processed first and the next run finds it too", async () => {
    const request = await mirroredRequest();
    const from = stub.deliveries(provider.app).length;
    await stub.assignIssue("acme/fe-intake", request.number, { by: "ayse", assignees: ["omar"] });
    await stub.settled();
    await processDeliveries(request.number, from);

    await reconcile();
    await processSent();

    expect((await trackerEventsOf(request.id)).map(({ change }) => change)).toEqual(["assignees_changed"]);
  });

  it("records a change once, when the run finds it first and its delivery arrives later", async () => {
    const request = await mirroredRequest();
    const from = stub.deliveries(provider.app).length;
    await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse", reason: "not_planned" });
    await stub.settled();

    await reconcile();
    await processSent();
    await processDeliveries(request.number, from);

    expect((await trackerEventsOf(request.id)).map(({ change, reason }) => ({ change, reason }))).toEqual([{ change: "closed", reason: "not_planned" }]);
  });

  it("asks GitHub with its since parameter for the issues updated since shortly before the previous run", async () => {
    const first = new Date(Date.now() - 20 * 60_000);
    await reconcile(provider.github, () => first);
    const from = stub.received.length;

    await reconcile(provider.github, () => new Date(first.getTime() + 15 * 60_000));
    await processSent();

    const [listing, ...more] = issueListings(from);
    expect(more).toEqual([]);
    expect(listing?.get("state")).toBe("all");
    const since = Date.parse(listing?.get("since") ?? "");
    expect(since).toBeLessThanOrEqual(first.getTime());
    expect(since).toBeGreaterThanOrEqual(first.getTime() - 5 * 60_000);
  });

  it("reads only the repositories that hold mirror issues, and hands on only the mirror issues among what changed", async () => {
    const request = await mirroredRequest();
    const installation = (await provider.github.app())!.client.installation(stub.installations(provider.app)[0]!.id);
    // An issue someone opened in the intake repository, which mirrors no request, and one in another repository.
    const { data: other } = await installation.request("POST /repos/{owner}/{repo}/issues", { owner: "acme", repo: "fe-intake", title: "A question about the intake" });
    await installation.request("POST /repos/{owner}/{repo}/issues", { owner: "acme", repo: "fe-notes", title: "Notes" });
    await stub.closeIssue("acme/fe-intake", (other as { number: number }).number, { by: "omar" }, { delivery: "drop" });
    await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse" }, { delivery: "drop" });
    await stub.settled();
    const from = stub.received.length;

    await reconcile();

    expect(stub.received.slice(from).filter(({ path }) => path.startsWith("/repos/acme/fe-notes"))).toEqual([]);
    const { rows } = await install.owner.query<{ number: number }>(
      "SELECT (payload -> 'issue' ->> 'number')::int AS number FROM github_deliveries WHERE event = 'issues' AND delivery_id = ANY($1)",
      [install.sentJobs.map(({ data }) => (data as { deliveryId: string }).deliveryId)],
    );
    expect(rows).toEqual([{ number: request.number }]);
    await processSent();
    expect((await trackerEventsOf(request.id)).map(({ change }) => change)).toEqual(["closed"]);
  });

  it("hands a change on once however many runs find it", async () => {
    const request = await mirroredRequest();
    await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse" }, { delivery: "drop" });
    await stub.settled();

    await reconcile();
    await reconcile();

    expect(await sentFor(request.number)).toHaveLength(1);
    await processSent();
  });

  it("reads again from the previous run's time when GitHub failed a listing, so the next run finds what it missed", async () => {
    const request = await mirroredRequest();
    await reconcile();
    await processSent();
    await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse" }, { delivery: "drop" });
    await stub.settled();
    const failing: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/repos/acme/fe-intake/issues") return new Response(JSON.stringify({ message: "Server Error" }), { status: 502 });
      return fetch(input, init);
    };
    const down = createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: stub.apiUrl, fetch: failing, logger: install.logger });

    await expect(reconcile(down, () => new Date(Date.now() + 30 * 60_000))).rejects.toThrow();
    expect(await processSent()).toEqual([]);

    await reconcile();
    await processSent();
    expect((await trackerEventsOf(request.id)).map(({ change }) => change)).toEqual(["closed"]);
  });

  it("reads nothing of a repository that no connected installation covers now", async () => {
    await mirroredRequest();
    const [installation] = stub.installations(provider.app);
    await stub.suspend(installation!, { delivery: "none" });
    try {
      const from = stub.received.length;
      await reconcile();
      expect(issueListings(from)).toEqual([]);
      expect(install.sentJobs.filter(({ queue }) => queue === processGitHubDelivery.type.queue)).toEqual([]);
    } finally {
      await stub.unsuspend(installation!, { delivery: "none" });
      await reconcile();
      await processSent();
    }
  });
});

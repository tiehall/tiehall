import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGitHubIssues,
  createInstallGitHub,
  pollGitHub,
  processDelivery,
  processGitHubDelivery,
  reconcileGitHub,
  syncMirror,
  type InstallGitHub,
  type WebSessionCaller,
} from "../src/index.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// Polling mode reads the mirror issues too (tracker-mirrors: GitHub and Jira
// each run in webhook mode or polling mode; design.md, Self-hosting
// decisions: S9). While GitHub runs in polling mode, the poll that runs every
// 60 seconds reads, besides the pull requests, the issues of each repository
// that holds mirror issues updated since shortly before the previous poll, and
// hands each mirror issue among them to the processing a delivery about it
// goes to, so a change made on GitHub with no delivery, such as a close, is
// recorded within 2 minutes. It reads them with conditional requests, so an
// unchanged listing comes back as not modified and costs nothing of GitHub's
// rate limit; and a change that the poll and the 15-minute reconciliation
// both find is handed on once.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let alice: string;
let ayse: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["ayse", "omar"], { hook: true, repositories: ["acme/fe-intake"] });
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  alice = await addUser(install.owner, { login: "alice" });
  ayse = await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, ayse, fe);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
  // GitHub cannot reach the install, so it runs in polling mode; the first poll reads from now on.
  await install.owner.query("UPDATE github_app SET mode = 'polling', mode_settled_at = now()");
  await poll();
  await processSent();
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
});

const jobs = { send: async (_tx: unknown, queue: string, data: Record<string, unknown>) => void install.sentJobs.push({ queue, data }) };

/** One poll, as the worker runs it every 60 seconds, by the worker's clock, reaching GitHub as the install's App. */
async function poll(now: () => Date = () => new Date(), github: InstallGitHub = provider.github): Promise<void> {
  await pollGitHub.handle(
    { id: randomUUID(), queue: pollGitHub.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now, github, execute: install.execute, jobs },
  );
}

/** One run of the 15-minute GitHub reconciliation. */
async function reconcile(): Promise<void> {
  await reconcileGitHub.handle(
    { id: randomUUID(), queue: reconcileGitHub.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github: provider.github, execute: install.execute, jobs },
  );
}

/** Processes, as the worker does, the changes whose processing jobs were sent. */
async function processSent(): Promise<void> {
  for (const job of install.sentJobs.filter(({ queue }) => queue === processGitHubDelivery.type.queue)) {
    install.sentJobs.splice(install.sentJobs.indexOf(job), 1);
    await processDelivery({ database: install.db, github: provider.github, execute: install.execute }, (job.data as { deliveryId: string }).deliveryId);
  }
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

/** The request's events of tracker changes: the change, and whom it acted for. */
async function trackerEventsOf(requestId: string): Promise<{ change: string; actor_kind: string; surface: string; actor_user_id: string | null }[]> {
  const { rows } = await install.owner.query(
    `SELECT data ->> 'change' AS change, actor_kind, surface, actor_user_id
       FROM events WHERE type = 'request.tracker_changed' AND data ->> 'requestId' = $1 ORDER BY number`,
    [requestId],
  );
  return rows;
}

/** The reads of acme/fe-intake's issues that GitHub got since `from`, with their answers' status. */
function issueListings(from: number): { query: URLSearchParams; status: number }[] {
  return stub.received
    .slice(from)
    .filter(({ method, path }) => method === "GET" && path === "/repos/acme/fe-intake/issues")
    .map(({ query, status }) => ({ query: new URLSearchParams(query), status }));
}

describe("the poll of polling mode, for the mirror issues", () => {
  it("records a close made on GitHub with no delivery within 2 minutes: at the next poll, 60 seconds later", async () => {
    const request = await mirroredRequest();
    await poll();
    await processSent();
    const closedAt = Date.now();
    await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse" }, { delivery: "none" });

    await poll(() => new Date(closedAt + 60_000));
    await processSent();

    expect(await trackerEventsOf(request.id)).toEqual([{ change: "closed", actor_kind: "integration", surface: "github", actor_user_id: ayse }]);
  });

  it("reads the mirror issues with conditional requests, so an unchanged listing comes back as not modified", async () => {
    await mirroredRequest();
    await poll();
    await processSent();
    const from = stub.received.length;

    await poll();

    const listings = issueListings(from);
    expect(listings.map(({ status }) => status)).toEqual([304]);
    expect(listings[0]?.query.get("state")).toBe("all");
    expect(listings[0]?.query.get("sort")).toBe("updated");
    expect(install.sentJobs).toEqual([]);
  });

  it("hands a change on once when the poll and the reconciliation both find it", async () => {
    const request = await mirroredRequest();
    await stub.assignIssue("acme/fe-intake", request.number, { by: "ayse", assignees: ["omar"] }, { delivery: "none" });

    await poll();
    await reconcile();

    expect(await sentFor(request.number)).toHaveLength(1);
    await processSent();
    expect((await trackerEventsOf(request.id)).map(({ change }) => change)).toEqual(["assignees_changed"]);
  });

  it("reads the mirror issues again from the previous poll's time when GitHub failed their listing", async () => {
    const request = await mirroredRequest();
    await poll();
    await processSent();
    await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse", reason: "not_planned" }, { delivery: "none" });
    const failing: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/repos/acme/fe-intake/issues") return new Response(JSON.stringify({ message: "Server Error" }), { status: 502 });
      return fetch(input, init);
    };
    const down = createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: stub.apiUrl, fetch: failing, logger: install.logger });

    await expect(poll(() => new Date(Date.now() + 10 * 60_000), down)).rejects.toThrow();
    expect(install.sentJobs).toEqual([]);

    await poll();
    await processSent();
    expect((await trackerEventsOf(request.id)).map(({ change }) => change)).toEqual(["closed"]);
  });

  it("reads no mirror issue in webhook mode, where deliveries and the reconciliation bring their changes", async () => {
    const request = await mirroredRequest();
    await install.owner.query("UPDATE github_app SET mode = 'webhook'");
    try {
      await stub.closeIssue("acme/fe-intake", request.number, { by: "ayse" }, { delivery: "none" });
      const from = stub.received.length;
      await poll();
      expect(issueListings(from)).toEqual([]);
      expect(install.sentJobs).toEqual([]);
    } finally {
      await install.owner.query("UPDATE github_app SET mode = 'polling'");
      await poll();
      await processSent();
    }
  });
});

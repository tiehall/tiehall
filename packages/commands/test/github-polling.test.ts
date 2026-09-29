import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubInstallation } from "@tiehall/testing/github";
import { pollGitHub, processDelivery, processGitHubDelivery, pruneGitHubDeliveries, WORKER_JOBS, type GitHubEvent, type WebSessionCaller } from "../src/index.ts";
import { serveWebhooks, type WebhookServer } from "./support/github-app.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Polling mode (tracker-mirrors: GitHub and Jira each run in webhook mode or
// polling mode; tracker-mirrors: Admins connect GitHub installations with the
// confirmation step; tracker-mirrors: Covered repositories follow each
// connected installation; sign-in: Leaving the GitHub organization ends
// access; github-app-reachability: design.md, Design rules: Finding
// installations; design.md, Self-hosting decisions: S9). In polling mode a
// job every 60 seconds asks GitHub what changed, so a change is picked up
// within 2 minutes: it lists the App's installations and the repositories of
// the connected ones, reads the pull requests in covered repositories updated
// since the last poll, and checks the members Tiehall saw in each working
// connected organization. A pull request it finds goes to the same processing
// as a webhook delivery, with the same input, and a change seen by a poll and
// by a webhook is handled once. Every read is a conditional request, so an
// unchanged answer is a 304, which does not count against GitHub's rate limit.

let install: TestInstall;
let stub: GitHubStub;
let hooks: WebhookServer;
let harness: SignInHarness;
let acme: StubInstallation;
let pia: WebSessionCaller;

beforeEach(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["omar", "lee"]) stub.addUser({ login });
  stub.addOrg({ login: "acme", members: { omar: "admin", lee: "member" } });
  for (const name of ["acme/web", "acme/api", "acme/tools"]) stub.addRepo(name);
  // An App with a webhook at a local server, in polling mode, as after a failed delivery: some deliveries still arrive.
  hooks = await serveWebhooks(install, () => harness.box);
  harness = await startSignIn(install, stub, { hook: { url: hooks.url } });
  stub.updateApp(harness.app, { public: true });
  await install.owner.query("UPDATE github_app SET mode = 'polling', mode_settled_at = now()");
  acme = await stub.install(harness.app, { account: "acme", repositories: ["acme/web", "acme/api"] }, { delivery: "none" });
  await harness.connect("acme");
  install.useGitHub(harness.github);
  pia = sessionOf(await addUser(install.owner, { login: "pia", role: "admin" }));
  // The first poll: from here on, each poll reads what changed since the one before.
  await poll();
  install.sentJobs.length = 0;
}, 60_000);

afterEach(async () => {
  await stub?.close();
  await hooks?.close();
  await install?.close();
});

/** One poll, as the worker runs it every 60 seconds. */
async function poll(): Promise<void> {
  await pollGitHub.handle(
    { id: randomUUID(), queue: pollGitHub.type.queue, data: {}, signal: new AbortController().signal },
    {
      database: install.db,
      now: () => new Date(),
      github: harness.github,
      execute: install.execute,
      jobs: { send: async (_tx, queue, data) => void install.sentJobs.push({ queue, data }) },
    },
  );
}

/** Processes the changes whose jobs were sent, as the worker does; returns the pull requests the processing saw, by repository and number. */
async function processSent(): Promise<{ repository: string; number: number; title: string }[]> {
  const seen: { repository: string; number: number; title: string }[] = [];
  const processors = {
    pull_request: async (event: GitHubEvent) => {
      const pr = event.payload["pull_request"] as { number: number; title: string };
      const repository = event.payload["repository"] as { full_name: string };
      expect(event.installation.installationId).toBe(acme.id);
      seen.push({ repository: repository.full_name, number: pr.number, title: pr.title });
    },
  };
  for (const { queue, data } of install.sentJobs.splice(0)) {
    expect(queue).toBe(processGitHubDelivery.type.queue);
    await processDelivery({ database: install.db, github: harness.github, execute: install.execute, processors }, (data as { deliveryId: string }).deliveryId);
  }
  return seen;
}

/** The installations the admin page lists, as an admin reads them. */
async function listed(): Promise<{ account: string; connected: boolean; suspended: boolean; deleted: boolean; repositories: string[] }[]> {
  type Listed = { account: string; connected: boolean; suspended: boolean; deleted: boolean; repositories: string[] };
  const result = await install.web(pia).read<{ installations: Listed[] }>("github.list_installations", {});
  if (!result.ok) throw new Error(`github.list_installations answered ${result.problem.status}`);
  return result.output.installations.map(({ account, connected, suspended, deleted, repositories }) => ({ account, connected, suspended, deleted, repositories }));
}

describe("the poll of polling mode", () => {
  it("runs every 60 seconds, as one of the worker's jobs", () => {
    expect(pollGitHub.schedule).toBe("* * * * *");
    expect(WORKER_JOBS).toContain(pollGitHub);
  });

  it("picks up a pull request opened in a covered repository on the next poll, and feeds it to the processing a delivery goes to", async () => {
    await stub.openPullRequest("acme/web", { title: "Fix the header for FE-142", head: "fix-header", author: "omar" }, { delivery: "none" });

    await poll();

    expect(await processSent()).toEqual([{ repository: "acme/web", number: 1, title: "Fix the header for FE-142" }]);
    // A later change of the same pull request is picked up too; an unchanged one is not picked up again.
    await stub.editPullRequest("acme/web", 1, { title: "Fix the header for FE-143" }, { delivery: "none" });
    await poll();
    await poll();
    expect(await processSent()).toEqual([{ repository: "acme/web", number: 1, title: "Fix the header for FE-143" }]);
  });

  it("leaves out pull requests in a repository no connected installation covers", async () => {
    await stub.openPullRequest("acme/tools", { title: "Tidy up", head: "tidy", author: "omar" }, { delivery: "none" });
    await poll();
    expect(await processSent()).toEqual([]);
  });

  it("picks up a member's departure from the GitHub organization on the next poll", async () => {
    const { response, jar } = await harness.signIn("lee");
    expect(response.status).toBe(302);
    const lee = (await harness.sessionOf(jar))!.userId;
    await stub.removeMember("acme", "lee", { delivery: "none" });

    await poll();

    expect((await install.owner.query("SELECT 1 FROM members WHERE user_id = $1", [lee])).rows).toEqual([]);
    const { rows } = await install.owner.query<{ actor_kind: string }>("SELECT actor_kind FROM events WHERE type = 'member.removed' AND data->>'userId' = $1", [lee]);
    expect(rows).toEqual([{ actor_kind: "system" }]);
  });

  it("asks GitHub with conditional requests, so unchanged answers come back as not modified", async () => {
    const from = stub.received.length;

    await poll();

    const reads = stub.received.slice(from).filter(({ method, host }) => method === "GET" && host === "api");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect({ path: read.path, status: read.status }).toEqual({ path: read.path, status: 304 });
      expect(read.headers["if-none-match"]).toMatch(/^W\/"/);
    }
  });

  it("handles once a change that a webhook delivered and the next poll finds too", async () => {
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" });
    await stub.settled();
    expect(install.sentJobs).toHaveLength(1);

    await poll();

    expect(await processSent()).toEqual([{ repository: "acme/web", number: 1, title: "Fix the header" }]);
  });

  it("handles once a change that a poll found and a delivery of GitHub brings later", async () => {
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" }, { delivery: "drop" });
    await poll();
    expect(await processSent()).toHaveLength(1);

    const dropped = stub.deliveries(harness.app).at(-1)!;
    expect(dropped.event).toBe("pull_request");
    await stub.redeliver(dropped);
    await stub.settled();

    expect(install.sentJobs).toEqual([]);
    expect(await processSent()).toEqual([]);
  });

  it("stores changes that the nightly pruning deletes as it deletes deliveries: 7 days after processing, or 30 days after storing when never processed (github-layer-hardening 1.19)", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" }, { delivery: "none" });
    await stub.openPullRequest("acme/api", { title: "Fix the client", head: "fix-client", author: "omar" }, { delivery: "none" });
    await poll();
    install.sentJobs.length = 0;
    const changes = async () =>
      (
        await install.owner.query<{ delivery_id: string; repository: string; received_at: Date; processed: boolean }>(
          `SELECT delivery_id, payload->'repository'->>'full_name' AS repository, received_at, processed_at IS NOT NULL AS processed
             FROM github_deliveries WHERE change_key IS NOT NULL ORDER BY repository`,
        )
      ).rows;
    const [api, web] = await changes();
    expect([api?.repository, web?.repository]).toEqual(["acme/api", "acme/web"]);
    // The worker processes the change in acme/web now; the job of the one in acme/api fails for good.
    const start = new Date();
    await processDelivery({ database: install.db, github: harness.github, execute: install.execute, processors: {}, now: () => start }, web!.delivery_id);
    const pruneAt = (now: Date) =>
      pruneGitHubDeliveries.handle(
        { id: randomUUID(), queue: pruneGitHubDeliveries.type.queue, data: {}, signal: new AbortController().signal },
        { database: install.db, now: () => now },
      );

    await pruneAt(new Date(start.getTime() + 6 * DAY));
    expect((await changes()).map(({ repository, processed }) => ({ repository, processed }))).toEqual([
      { repository: "acme/api", processed: false },
      { repository: "acme/web", processed: true },
    ]);
    await pruneAt(new Date(start.getTime() + 8 * DAY));
    expect((await changes()).map(({ repository }) => repository)).toEqual(["acme/api"]);
    await pruneAt(new Date(api!.received_at.getTime() + 29 * DAY));
    expect((await changes()).map(({ repository }) => repository)).toEqual(["acme/api"]);
    await pruneAt(new Date(api!.received_at.getTime() + 31 * DAY));
    expect(await changes()).toEqual([]);
  });

  it("does nothing in webhook mode", async () => {
    await install.owner.query("UPDATE github_app SET mode = 'webhook'");
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" }, { delivery: "none" });
    const from = stub.received.length;

    await poll();

    expect(stub.received.slice(from)).toEqual([]);
    expect(install.sentJobs).toEqual([]);
  });
});

describe("the installations polling mode finds with no delivery (github-app-reachability 1.5)", () => {
  it("lists an installation made on GitHub on the admin page as not connected, on the next poll", async () => {
    stub.addOrg({ login: "acme-labs", members: { omar: "admin" } });
    await stub.install(harness.app, { account: "acme-labs" }, { delivery: "none" });
    expect((await listed()).map(({ account }) => account)).toEqual(["acme"]);

    await poll();

    expect(await listed()).toEqual([
      { account: "acme", connected: true, suspended: false, deleted: false, repositories: ["acme/api", "acme/web"] },
      { account: "acme-labs", connected: false, suspended: false, deleted: false, repositories: [] },
    ]);
  });

  it("counts a repository added to or removed from a connected installation, on the next poll", async () => {
    await stub.addRepositories(acme, ["acme/tools"], { delivery: "none" });
    await stub.removeRepositories(acme, ["acme/web"], { delivery: "none" });

    await poll();

    expect((await listed())[0]?.repositories).toEqual(["acme/api", "acme/tools"]);
  });

  it("stops counting the repositories of a connected installation GitHub suspended or deleted, which counts as suspended or deleted, on the next poll", async () => {
    await stub.suspend(acme, { delivery: "none" });
    await poll();
    expect((await listed())[0]).toMatchObject({ account: "acme", connected: true, suspended: true, repositories: [] });

    await stub.unsuspend(acme, { delivery: "none" });
    await poll();
    expect((await listed())[0]).toMatchObject({ suspended: false, repositories: ["acme/api", "acme/web"] });

    await stub.uninstall(acme, { delivery: "none" });
    await poll();
    expect((await listed())[0]).toMatchObject({ account: "acme", deleted: true, repositories: [] });
  });
});

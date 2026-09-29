import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp, type StubDelivery } from "@tiehall/testing/github";
import {
  connectInstallations,
  processDelivery,
  processGitHubDelivery,
  readInstallations,
  REDELIVERY_ASKS,
  redeliverGitHubDeliveries,
  WORKER_JOBS,
  withOrg,
  type GitHubEvent,
} from "../src/index.ts";
import { serveWebhooks, storeStubApp, type StoredStubApp, type WebhookServer } from "./support/github-app.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";

// Failed GitHub deliveries are redelivered (tracker-mirrors: Failed GitHub
// deliveries are redelivered; design.md, Design rules: Tracker mirrors;
// design.md, Self-hosting decisions: S9). GitHub does not retry a delivery that
// failed, such as one sent while the install was restarting. So while GitHub
// runs in webhook mode, a job every 10 minutes reads the App's delivery log and
// asks GitHub to redeliver each delivery whose last attempt failed and that
// Tiehall has not stored; the redelivery keeps the delivery's id, so it is
// stored and processed once. Only deliveries made after the App's credentials
// were stored count, as for the reachability check. The deliveries here are
// the GitHub stub's own, sent to a local server that answers with the real
// /webhooks/github route.

let install: TestInstall;
let stub: GitHubStub;
let hooks: WebhookServer;
let app: StubApp;
let stored: StoredStubApp;

beforeEach(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  hooks = await serveWebhooks(install, () => stored.box);
  // GitHub pings the hook when the App is created, before the setup screen stores the App: that ping fails.
  app = stub.createApp({ owner: "acme", hook: { url: hooks.url } });
  await stub.settled();
  stored = await storeStubApp(install, stub, app);
  // GitHub logs deliveries to the second; the ones from here on are logged after the credentials were stored.
  stub.advanceClock(2_000);
  await stub.install(app, { account: "acme", repositories: ["acme/web"] });
  await stub.settled();
  await readInstallations({ database: install.db, app: (await stored.github.app())! });
  await withOrg(install.db, async (context) => {
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations");
    await connectInstallations(context, rows.map(({ id }) => id));
  });
  install.sentJobs.length = 0;
}, 60_000);

afterEach(async () => {
  await stub?.close();
  await hooks?.close();
  await install?.close();
});

/** One run of the redelivery job, as the worker runs it every 10 minutes. */
async function redeliver(github = stored.github): Promise<void> {
  await redeliverGitHubDeliveries.handle(
    { id: randomUUID(), queue: redeliverGitHubDeliveries.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github },
  );
  // GitHub accepts a redelivery at once and makes it afterwards.
  await stub.settled();
}

/** The deliveries Tiehall asked GitHub to redeliver, by the id of the logged attempt. */
function asked(): number[] {
  return stub.received
    .filter(({ method, path }) => method === "POST" && /^\/app\/hook\/deliveries\/\d+\/attempts$/.test(path))
    .map(({ path }) => Number(path.split("/")[4]));
}

/** Processes the deliveries whose jobs the route sent, as the worker does, and returns the pull requests' deliveries a processor saw. */
async function processSentJobs(): Promise<string[]> {
  const seen: string[] = [];
  const processors = { pull_request: async (event: GitHubEvent) => void seen.push(event.deliveryId) };
  for (const { queue, data } of install.sentJobs.splice(0)) {
    expect(queue).toBe(processGitHubDelivery.type.queue);
    await processDelivery({ database: install.db, github: stored.github, execute: install.execute, processors }, (data as { deliveryId: string }).deliveryId);
  }
  return seen;
}

async function storedDeliveries(): Promise<string[]> {
  const { rows } = await install.owner.query<{ delivery_id: string }>("SELECT delivery_id FROM github_deliveries ORDER BY received_at");
  return rows.map(({ delivery_id }) => delivery_id);
}

/** Opens a pull request while the install cannot be reached, as during a restart; returns the delivery GitHub logged as failed. */
async function missedDelivery(): Promise<StubDelivery> {
  stub.setHookReachable(false);
  await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" });
  await stub.settled();
  stub.setHookReachable(true);
  const failed = stub.deliveries(app).at(-1)!;
  expect(failed).toMatchObject({ event: "pull_request", redelivery: false });
  expect(failed.statusCode < 200 || failed.statusCode > 299).toBe(true);
  return failed;
}

describe("the redelivery of failed GitHub deliveries", () => {
  it("runs every 10 minutes, as one of the worker's jobs", () => {
    expect(redeliverGitHubDeliveries.schedule).toBe("*/10 * * * *");
    expect(WORKER_JOBS).toContain(redeliverGitHubDeliveries);
  });

  it("asks GitHub to redeliver a delivery missed during a restart, which is then stored and processed once", async () => {
    const missed = await missedDelivery();
    expect(await storedDeliveries()).not.toContain(missed.guid);

    await redeliver();

    expect(asked()).toEqual([missed.id]);
    expect(await storedDeliveries()).toContain(missed.guid);
    expect(await processSentJobs()).toEqual([missed.guid]);

    // The next run finds the delivery stored, asks nothing more, and nothing is processed twice.
    await redeliver();
    expect(asked()).toEqual([missed.id]);
    expect(await processSentJobs()).toEqual([]);
    const { rows } = await install.owner.query<{ count: number }>("SELECT count(*)::int AS count FROM github_deliveries WHERE delivery_id = $1", [missed.guid]);
    expect(rows[0]?.count).toBe(1);
  });

  it("does not ask for a delivery made before the App's credentials were stored, such as the ping sent when the App was created", async () => {
    const ping = stub.deliveries(app)[0]!;
    expect(ping).toMatchObject({ event: "ping" });
    expect(ping.statusCode).toBe(401);

    await redeliver();

    expect(asked()).toEqual([]);
  });

  it("asks again at the next run while the redelivery fails, and gives up on a delivery after asking a few times", async () => {
    const missed = await missedDelivery();
    stub.setHookReachable(false);
    for (let run = 0; run < REDELIVERY_ASKS + 2; run += 1) await redeliver();

    expect(asked()).toHaveLength(REDELIVERY_ASKS);
    expect(stub.deliveries(app).filter(({ guid }) => guid === missed.guid)).toHaveLength(REDELIVERY_ASKS + 1);
    expect(await storedDeliveries()).not.toContain(missed.guid);
  });

  it("asks nothing while GitHub runs in polling mode", async () => {
    await missedDelivery();
    await install.owner.query("UPDATE github_app SET mode = 'polling'");
    const from = stub.received.length;

    await redeliver();

    expect(stub.received.slice(from).filter(({ path }) => path.startsWith("/app/hook"))).toEqual([]);
  });
});

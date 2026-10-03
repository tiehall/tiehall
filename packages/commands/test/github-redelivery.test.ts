import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp, type StubDelivery } from "@tiehall/testing/github";
import {
  connectInstallations,
  createGitHubAdminRoute,
  createInstallGitHub,
  GITHUB_ADMIN_PATH,
  processDelivery,
  processGitHubDelivery,
  readInstallations,
  REDELIVERY_ASKS,
  redeliverGitHubDeliveries,
  WORKER_JOBS,
  withOrg,
  type GitHubEvent,
  type WebSessionCaller,
} from "../src/index.ts";
import { databaseClock, serveWebhooks, storeStubApp, type StoredStubApp, type WebhookServer } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";

// Failed GitHub deliveries are redelivered (tracker-mirrors: Failed GitHub
// deliveries are redelivered; design.md, Design rules: Tracker mirrors;
// design.md, Self-hosting decisions: S9). GitHub does not retry a delivery that
// failed, such as one sent while the install was restarting. So while GitHub
// runs in webhook mode, a job every 10 minutes reads the App's delivery log and
// asks GitHub to redeliver each delivery whose last attempt failed and that
// Tiehall has not stored; the redelivery keeps the delivery's id, so it is
// stored and processed once. Only deliveries made after the App's credentials
// were stored count, as for the reachability check. Tiehall asks for one
// delivery 5 times at most; a delivery still failed after the fifth request
// is given up: the App's row records the give-up, which the admin page's
// banner shows, and GitHub moves to polling mode, unless an admin's switch to
// webhook mode was the latest change of the mode (github-layer-hardening:
// design.md, Decisions this change rests on: D50 (15); design.md, Technical
// decisions: T8). The deliveries here are the GitHub stub's own, sent to a
// local server that answers with the real /webhooks/github route.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

let install: TestInstall;
let stub: GitHubStub;
let hooks: WebhookServer;
let app: StubApp;
let stored: StoredStubApp;
/** An admin of the install. */
let ada: WebSessionCaller;

beforeEach(async () => {
  install = await startTestInstall();
  // The stub logs deliveries by the database's clock, which stamps when the credentials were stored, so a host clock
  // a second or two off the database container's cannot move a delivery to the other side of that moment.
  stub = await startGitHubStub({ now: await databaseClock(install.owner) });
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
  ada = sessionOf(await addUser(install.owner, { login: "ada", role: "admin" }));
}, 60_000);

afterEach(async () => {
  await stub?.close();
  await hooks?.close();
  await install?.close();
});

/** One run of the redelivery job, as the worker runs it every 10 minutes, by the worker's clock. */
async function redeliver(github = stored.github, now: () => Date = () => new Date()): Promise<void> {
  await redeliverGitHubDeliveries.handle(
    { id: randomUUID(), queue: redeliverGitHubDeliveries.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now, github, jobs: { send: async () => {} } },
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

describe("the stub's clock in these tests", () => {
  it("is the database's, whatever the host's clock says", async () => {
    const database = async () => Number((await install.owner.query<{ now: number }>("SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now")).rows[0]!.now);
    for (const skew of [-3_000, 0, 3_000]) {
      const clock = await databaseClock(install.owner, () => Date.now() + skew);
      const before = await database();
      const read = clock();
      const after = await database();
      expect(read).toBeGreaterThanOrEqual(before - 50);
      expect(read).toBeLessThanOrEqual(after + 50);
    }
  });
});

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

describe("the limits of redelivery (github-layer-hardening 1.21)", () => {
  it("asks GitHub exactly 5 times to redeliver one failed delivery", async () => {
    const missed = await missedDelivery();
    stub.setHookReachable(false);
    for (let run = 0; run < 8; run += 1) await redeliver();

    expect(REDELIVERY_ASKS).toBe(5);
    expect(asked()).toHaveLength(5);
    expect(stub.deliveries(app).filter(({ guid }) => guid === missed.guid)).toHaveLength(6);
  });

  it("asks nothing for a failed delivery made more than 3 days before the run, and asks for one made less", async () => {
    const missed = await missedDelivery();
    const made = Date.parse(missed.deliveredAt);

    await redeliver(stored.github, () => new Date(made + 3 * DAY + MINUTE));
    expect(asked()).toEqual([]);

    // A first run again, which reads no later than it would, 2 minutes earlier.
    await install.owner.query("UPDATE github_app SET redelivery_checked_at = NULL");
    await redeliver(stored.github, () => new Date(made + 3 * DAY - MINUTE));
    expect(asked()).toEqual([missed.id]);
  });

  it("reads the log from 15 minutes before its previous run, so a failed attempt GitHub logged late is still asked for", async () => {
    // GitHub logs a failed attempt at a time before the previous run, but the log shows it only after that run.
    const before = Math.floor(Date.now() / 1000) * 1000;
    await redeliver(stored.github, () => new Date(before + 14 * MINUTE));
    const missed = await missedDelivery();
    expect(Date.parse(missed.deliveredAt)).toBeLessThan(before + MINUTE);

    await redeliver(stored.github, () => new Date(before + 24 * MINUTE));

    expect(asked()).toEqual([missed.id]);
  });

  it("does not read the log back further than 15 minutes before its previous run", async () => {
    const before = Math.floor(Date.now() / 1000) * 1000;
    await redeliver(stored.github, () => new Date(before + 16 * MINUTE + 5_000));
    const missed = await missedDelivery();
    expect(Date.parse(missed.deliveredAt)).toBeLessThan(before + MINUTE);

    await redeliver(stored.github, () => new Date(before + 26 * MINUTE));

    expect(asked()).toEqual([]);
  });
});

/** The install's App, reaching GitHub through this fetch. */
function reachingGitHubThrough(through: typeof fetch) {
  return createInstallGitHub({ database: install.db, secrets: () => stored.box, apiUrl: stub.apiUrl, fetch: through, logger: install.logger });
}

function pathOf(input: string | URL | Request): string {
  return new URL(input instanceof Request ? input.url : String(input)).pathname;
}

describe("a run GitHub fails", () => {
  // A 200 whose body is not a list, such as a page a proxy that inspects TLS serves, says nothing of which deliveries
  // failed: the run fails, records no run, and the next one reads the log from where it would have.
  it("when GitHub answers the delivery log with 200 and a body that is not a list, records no run, so the next run still asks for the failed delivery", async () => {
    const missed = await missedDelivery();
    const made = Date.parse(missed.deliveredAt);
    const page = reachingGitHubThrough(async (input, init) =>
      pathOf(input) === "/app/hook/deliveries"
        ? new Response("<html><body>Blocked by policy.</body></html>", { status: 200, headers: { "content-type": "text/html" } })
        : fetch(input, init),
    );
    await expect(redeliver(page, () => new Date(made + 60 * MINUTE))).rejects.toThrow();
    expect(asked()).toEqual([]);

    await redeliver(stored.github, () => new Date(made + 70 * MINUTE));
    expect(asked()).toEqual([missed.id]);
  });
});

describe("a redelivery request GitHub refuses", () => {
  /** The install's App, while GitHub refuses with 422 every request to redeliver the attempt with this id. */
  function refusing(attemptId: number) {
    return reachingGitHubThrough(async (input, init) =>
      (init?.method ?? "GET").toUpperCase() === "POST" && pathOf(input) === `/app/hook/deliveries/${attemptId}/attempts`
        ? new Response('{"message":"Validation Failed"}', { status: 422, headers: { "content-type": "application/json" } })
        : fetch(input, init),
    );
  }

  it("does not stop the run: Tiehall still asks GitHub to redeliver the other failed deliveries", async () => {
    const first = await missedDelivery();
    stub.advanceClock(2_000);
    stub.setHookReachable(false);
    await stub.openPullRequest("acme/web", { title: "Fix the footer", head: "fix-footer", author: "omar" });
    await stub.settled();
    stub.setHookReachable(true);
    const second = stub.deliveries(app).at(-1)!;
    expect(second.id).not.toBe(first.id);

    await redeliver(refusing(first.id));

    expect(asked()).toEqual([second.id]);
  });

  it("counts as one of the delivery's requests, so a delivery whose redelivery GitHub refuses every time is given up after the fifth", async () => {
    const missed = await missedDelivery();
    const github = refusing(missed.id);
    for (let run = 0; run < REDELIVERY_ASKS; run += 1) await redeliver(github);
    const givenUp = async () => (await install.owner.query<{ at: Date | null }>("SELECT webhook_given_up_at AS at FROM github_app")).rows[0]!.at;
    expect(await givenUp()).toBeNull();

    await redeliver(github);

    expect(await givenUp()).not.toBeNull();
    const { rows } = await install.owner.query<{ asks: number }>("SELECT asks FROM github_redeliveries WHERE delivery_id = $1", [missed.guid]);
    expect(rows).toEqual([{ asks: REDELIVERY_ASKS }]);
  });

  it("with a server error, or not at all, fails the run, as GitHub failing it, and counts no request", async () => {
    const missed = await missedDelivery();
    const answers = [
      async () => new Response('{"message":"Server Error"}', { status: 502, headers: { "content-type": "application/json" } }),
      async (): Promise<Response> => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const answer of answers) {
      const failing = reachingGitHubThrough(async (input, init) =>
        (init?.method ?? "GET").toUpperCase() === "POST" && pathOf(input) === `/app/hook/deliveries/${missed.id}/attempts` ? answer() : fetch(input, init),
      );
      await expect(redeliver(failing)).rejects.toThrow();
    }
    expect((await install.owner.query("SELECT 1 FROM github_redeliveries")).rows).toEqual([]);
  });
});

describe("a delivery given up (github-layer-hardening 1.21)", () => {
  /** What the App's row says of the mode and of a given-up delivery. */
  async function appRow(): Promise<{ mode: string; given_up_at: Date | null }> {
    const { rows } = await install.owner.query<{ mode: string; given_up_at: Date | null }>("SELECT mode, webhook_given_up_at AS given_up_at FROM github_app");
    return rows[0]!;
  }

  async function modeEvents(): Promise<{ actor_kind: string; actor_user_id: string | null; data: Record<string, string>; occurred_at: Date }[]> {
    const { rows } = await install.owner.query<{ actor_kind: string; actor_user_id: string | null; data: Record<string, string>; occurred_at: Date }>(
      "SELECT actor_kind, actor_user_id, data, occurred_at FROM events WHERE type = 'github.mode_changed' ORDER BY number",
    );
    return rows;
  }

  async function adminPage(): Promise<string> {
    const route = createGitHubAdminRoute({ execute: install.execute, session: async () => ada, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
    const page = await route(new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`));
    expect(page.status).toBe(200);
    return page.text();
  }

  /** Ada switches GitHub's mode on the admin page. */
  async function switchTo(mode: "webhook" | "polling"): Promise<void> {
    await install.execute("github.set_mode", ada, { mode });
  }

  /** Runs the job until it has asked for the missed delivery 5 times, and once more, which finds it still failed. */
  async function giveUp(): Promise<void> {
    stub.setHookReachable(false);
    for (let run = 0; run < REDELIVERY_ASKS; run += 1) await redeliver();
    expect((await appRow()).given_up_at).toBeNull();
    await redeliver();
  }

  it("is given up once it still fails after the fifth request: in one write the App's row records it and GitHub moves to polling mode, which the admin page shows, with a security event that names no user", async () => {
    await missedDelivery();
    expect(await adminPage()).toContain("GitHub runs in webhook mode");

    await giveUp();

    const row = await appRow();
    expect(row.mode).toBe("polling");
    expect(row.given_up_at).not.toBeNull();
    expect(await adminPage()).toContain("GitHub runs in polling mode");
    const events = await modeEvents();
    expect(events.map(({ actor_kind, actor_user_id, data }) => ({ actor_kind, actor_user_id, data }))).toEqual([
      { actor_kind: "system", actor_user_id: null, data: { mode: "polling", previousMode: "webhook", cause: "given_up_delivery" } },
    ]);
    // The same write: the give-up and the event carry its time.
    expect(events[0]!.occurred_at).toEqual(row.given_up_at);

    // Later runs record nothing more for it.
    for (let run = 0; run < 2; run += 1) await redeliver();
    expect(await appRow()).toEqual(row);
    expect(await modeEvents()).toHaveLength(1);
    expect(asked()).toHaveLength(REDELIVERY_ASKS);
  });

  it("keeps webhook mode when an admin's switch to webhook mode was the latest change of the mode, and still records the give-up, once", async () => {
    await switchTo("polling");
    await switchTo("webhook");
    await missedDelivery();

    await giveUp();

    const row = await appRow();
    expect(row.mode).toBe("webhook");
    expect(row.given_up_at).not.toBeNull();
    expect((await modeEvents()).map(({ data }) => data["cause"])).toEqual(["admin_switch", "admin_switch"]);
    for (let run = 0; run < 2; run += 1) await redeliver();
    expect(await appRow()).toEqual(row);
    expect(await modeEvents()).toHaveLength(2);
  });

  it("is cleared by an admin's switch of the mode, and the same delivery is not given up again", async () => {
    await missedDelivery();
    await giveUp();
    expect(await appRow()).toMatchObject({ mode: "polling" });

    await switchTo("webhook");

    expect(await appRow()).toEqual({ mode: "webhook", given_up_at: null });
    for (let run = 0; run < 2; run += 1) await redeliver();
    expect(await appRow()).toEqual({ mode: "webhook", given_up_at: null });
    expect((await modeEvents()).map(({ data }) => data["cause"])).toEqual(["given_up_delivery", "admin_switch"]);
  });

  it("is cleared by a verified delivery that /webhooks/github stores after it, and not by one that fails verification", async () => {
    await switchTo("polling");
    await switchTo("webhook");
    await missedDelivery();
    await giveUp();
    expect((await appRow()).given_up_at).not.toBeNull();

    const forged = await fetch(hooks.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": randomUUID(), "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      body: "{}",
    });
    expect(forged.status).toBe(401);
    expect((await appRow()).given_up_at).not.toBeNull();

    // The webhook works again: GitHub's next delivery reaches the install and verifies.
    stub.setHookReachable(true);
    await stub.editPullRequest("acme/web", 1, { title: "Fix the header, again" });
    await stub.settled();
    expect(stub.deliveries(app).at(-1)).toMatchObject({ event: "pull_request", statusCode: 202 });

    expect(await appRow()).toEqual({ mode: "webhook", given_up_at: null });
  });

  it("is forgotten, with the admin's switch, when the App's credentials are stored again", async () => {
    await switchTo("polling");
    await switchTo("webhook");
    await missedDelivery();
    await giveUp();
    expect(await appRow()).toMatchObject({ mode: "webhook" });

    stored = await storeStubApp(install, stub, app);
    expect(await appRow()).toEqual({ mode: "webhook", given_up_at: null });

    // The admin's switch is forgotten too: a delivery given up now moves GitHub to polling mode.
    stub.advanceClock(2_000);
    await missedDelivery();
    await giveUp();
    expect((await appRow()).mode).toBe("polling");
    expect((await modeEvents()).map(({ data }) => data["cause"])).toEqual(["admin_switch", "admin_switch", "given_up_delivery"]);
  });

  it("is never a delivery made before the App's credentials were stored", async () => {
    // The ping GitHub sent when the App was created failed, before the setup screen stored the App.
    expect(stub.deliveries(app)[0]).toMatchObject({ event: "ping", statusCode: 401 });

    for (let run = 0; run < REDELIVERY_ASKS + 2; run += 1) await redeliver();

    expect(asked()).toEqual([]);
    expect(await appRow()).toEqual({ mode: "webhook", given_up_at: null });
    expect(await modeEvents()).toEqual([]);
  });
});

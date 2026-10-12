import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp, type StubDelivery } from "@tiehall/testing/github";
import {
  changeKeyOf,
  connectInstallations,
  createGitHubAdminRoute,
  createInstallGitHub,
  emailAdminAlerts,
  GITHUB_ADMIN_PATH,
  polledDeliveryId,
  processDelivery,
  processGitHubDelivery,
  readInstallations,
  REDELIVERY_ASKS,
  redeliverGitHubDeliveries,
  WORKER_JOBS,
  withOrg,
  type Banner,
  type GitHubEvent,
  type JobSender,
  type WebSessionCaller,
} from "../src/index.ts";
import { databaseClock, serveWebhooks, storeStubApp, type StoredStubApp, type WebhookServer } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

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

/** One run of the redelivery job, as the worker runs it every 10 minutes, by the worker's clock, sending its jobs with these. */
async function redeliver(github = stored.github, now: () => Date = () => new Date(), jobs: JobSender = { send: async () => {} }): Promise<void> {
  await redeliverGitHubDeliveries.handle(
    { id: randomUUID(), queue: redeliverGitHubDeliveries.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now, github, jobs },
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

  // public-api: Request bodies have a size limit (decisions-from-groups-15-28: design.md, Decisions this change rests
  // on: D55 (5)). A delivery that arrives while one web process already receives as many bodies as it holds at once
  // is answered 503 busy and read no further; GitHub logs it as a failed delivery, so the next run asks for it again.
  it("asks GitHub again for a delivery refused with 503 busy, which is then stored and processed once", async () => {
    hooks.busy = true;
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" });
    await stub.settled();
    hooks.busy = false;
    const refused = stub.deliveries(app).at(-1)!;
    expect(refused).toMatchObject({ event: "pull_request", redelivery: false, statusCode: 503 });
    expect(JSON.parse(String(refused.response.payload))).toMatchObject({ type: "https://tiehall.com/problems/busy", status: 503 });
    expect(await storedDeliveries()).not.toContain(refused.guid);

    await redeliver();

    expect(asked()).toEqual([refused.id]);
    expect(await storedDeliveries()).toContain(refused.guid);
    expect(await processSentJobs()).toEqual([refused.guid]);
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

describe("redelivery, with GitHub's clock a few seconds off the database's", () => {
  it("asks for a failed delivery that GitHub logged a few seconds before the credentials were stored", async () => {
    // GitHub's clock runs 18 seconds behind the database's.
    stub.advanceClock(-20_000);
    const missed = await missedDelivery();
    const { rows } = await install.owner.query<{ stored_at: Date }>("SELECT stored_at FROM github_app");
    expect(Date.parse(missed.deliveredAt)).toBeLessThan(rows[0]!.stored_at.getTime());

    await redeliver();

    expect(asked()).toEqual([missed.id]);
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

  it("waits for GitHub to log the fifth redelivery, and gives up only once a failed attempt newer than the fifth request is logged", async () => {
    await missedDelivery();
    stub.setHookReachable(false);
    for (let run = 0; run < REDELIVERY_ASKS - 1; run += 1) await redeliver();
    // GitHub accepts the fifth request at once, but makes and logs its redelivery only later.
    const held: (() => Promise<Response>)[] = [];
    const late = reachingGitHubThrough(async (input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && /^\/app\/hook\/deliveries\/\d+\/attempts$/.test(pathOf(input))) {
        held.push(() => fetch(input, init));
        return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
      }
      return fetch(input, init);
    });
    await redeliver(late);
    expect(held).toHaveLength(1);
    const { rows } = await install.owner.query<{ asks: number }>("SELECT asks FROM github_redeliveries");
    expect(rows).toEqual([{ asks: REDELIVERY_ASKS }]);

    // The log's latest attempt is still the fourth redelivery, which failed before the fifth request: nothing is given up yet.
    await redeliver();
    expect((await appRow()).given_up_at).toBeNull();
    expect(asked()).toHaveLength(REDELIVERY_ASKS - 1);

    // GitHub makes the fifth redelivery, which fails too: the next run gives the delivery up.
    expect((await held[0]!()).status).toBe(202);
    await stub.settled();
    await redeliver();
    expect((await appRow()).given_up_at).not.toBeNull();
  });

  // GitHub may accept the fifth request and never make its redelivery: the delivery is still failed after the last
  // request, so it is given up once the job's runs have read past the request for as long as GitHub may log an attempt
  // late, by the worker's runs 10 minutes apart.
  it("gives up a delivery whose fifth redelivery GitHub accepted but never made, once the runs read past that request", async () => {
    await missedDelivery();
    stub.setHookReachable(false);
    for (let run = 0; run < REDELIVERY_ASKS - 1; run += 1) await redeliver();
    const dropped = reachingGitHubThrough(async (input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && /^\/app\/hook\/deliveries\/\d+\/attempts$/.test(pathOf(input))) {
        return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
      }
      return fetch(input, init);
    });
    const fifth = Date.now();
    await redeliver(dropped, () => new Date(fifth));
    const { rows } = await install.owner.query<{ asks: number }>("SELECT asks FROM github_redeliveries");
    expect(rows).toEqual([{ asks: REDELIVERY_ASKS }]);

    // The next two runs still read from before the fifth request, where GitHub could yet log its redelivery late.
    for (const minutes of [10, 20]) {
      await redeliver(stored.github, () => new Date(fifth + minutes * MINUTE));
      expect((await appRow()).given_up_at).toBeNull();
    }
    // The run after reads from after it: GitHub logged no redelivery, so the delivery is given up, once.
    await redeliver(stored.github, () => new Date(fifth + 30 * MINUTE));
    const row = await appRow();
    expect(row).toMatchObject({ mode: "polling", given_up_at: expect.any(Date) });
    await redeliver(stored.github, () => new Date(fifth + 40 * MINUTE));
    expect(await appRow()).toEqual(row);
    expect((await modeEvents()).map(({ data }) => data["cause"])).toEqual(["given_up_delivery"]);
    expect(asked()).toHaveLength(REDELIVERY_ASKS - 1);
  });

  // /webhooks/github answers a delivery whose change it holds already under another delivery id, such as a change the
  // poll stored, with 202 and stores nothing: a redelivery answered so reached the install, and the delivery, no longer
  // failed, is not given up once the runs read past the fifth request, as GitHub's log shows the redelivery succeeded.
  it("does not give up a delivery whose fifth redelivery reached the install, though the change is stored under another delivery id", async () => {
    const missed = await missedDelivery();
    const key = changeKeyOf("pull_request", missed.request.payload as Record<string, unknown>)!;
    stub.setHookReachable(false);
    for (let run = 0; run < REDELIVERY_ASKS - 1; run += 1) await redeliver();
    // The poll stored the same change, as a poll does that runs just after an admin's switch of the mode.
    await install.owner.query(
      "INSERT INTO github_deliveries (org_id, delivery_id, event, payload, change_key) SELECT id, $1, 'pull_request', $2::jsonb, $3 FROM orgs",
      [polledDeliveryId(key), JSON.stringify(missed.request.payload), key],
    );
    stub.setHookReachable(true);
    const fifth = Date.now();
    await redeliver(stored.github, () => new Date(fifth));
    // GitHub made the fifth redelivery, which the install answered with 202 and did not store again.
    expect(asked()).toHaveLength(REDELIVERY_ASKS);
    expect(stub.deliveries(app).filter(({ guid }) => guid === missed.guid).at(-1)).toMatchObject({ redelivery: true, statusCode: 202 });
    expect(await storedDeliveries()).not.toContain(missed.guid);

    for (const minutes of [10, 20, 30, 40]) {
      await redeliver(stored.github, () => new Date(fifth + minutes * MINUTE));
      expect(await appRow()).toEqual({ mode: "webhook", given_up_at: null });
    }
    expect(await modeEvents()).toEqual([]);
    expect(asked()).toHaveLength(REDELIVERY_ASKS);
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

// A webhook removed on GitHub (tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode;
// tracker-mirrors: Broken integrations are surfaced; decisions-from-groups-15-28: design.md, Decisions this change
// rests on: D55 (6); Technical decisions: T2). While GitHub runs in webhook mode and a webhook secret is stored,
// GitHub's 404 for the App's delivery log means that it holds no webhook for the App any more, as when someone removed
// it in the App's settings: no delivery can arrive, so Tiehall moves GitHub to polling mode whoever last set the mode,
// with a security event that names no user, and shows the banner about GitHub's webhook to the admins and to the
// members of each team whose mirrors go through GitHub, emailing the admins once. While no webhook secret is stored, a
// 404 changes nothing.
describe("a webhook removed on GitHub (decisions-from-groups-15-28 1.20)", () => {
  /** The emails to the admins that the runs started. */
  let alerts: Record<string, unknown>[];
  const jobs: JobSender = {
    send: async (_tx, queue, data) => {
      if (queue === emailAdminAlerts.type.queue) alerts.push(data);
    },
  };
  /** A member of FE, which mirrors through GitHub, and one of DATA, which mirrors nowhere. */
  let ayse: WebSessionCaller;
  let dan: WebSessionCaller;

  beforeEach(async () => {
    alerts = [];
    const fe = await addTeam(install.owner, "FE");
    const data = await addTeam(install.owner, "DATA");
    ayse = sessionOf(await addUser(install.owner, { login: "ayse" }));
    dan = sessionOf(await addUser(install.owner, { login: "dan" }));
    await joinTeams(install.owner, ayse.userId, fe);
    await joinTeams(install.owner, dan.userId, data);
    // The repositories of the connected installation, read as a sync does once it is connected.
    await readInstallations({ database: install.db, app: (await stored.github.app())! });
    await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/web" });
  });

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

  /** The text of the banner about GitHub's webhook this person sees, or undefined. */
  async function webhookBanner(session: WebSessionCaller): Promise<string | undefined> {
    const { banners } = (await install.execute("install.get_banners", session, {}, { readOnly: true })) as { banners: Banner[] };
    return banners.find(({ id }) => id === "github_webhook")?.text;
  }

  async function adminPage(): Promise<string> {
    const route = createGitHubAdminRoute({ execute: install.execute, session: async () => ada, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
    const page = await route(new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`));
    expect(page.status).toBe(200);
    return page.text();
  }

  const switchTo = (mode: "webhook" | "polling") => install.execute("github.set_mode", ada, { mode });

  it("moves GitHub to polling mode, even after an admin's switch to webhook mode, with a security event that names no user, the webhook banner and one email", async () => {
    await switchTo("polling");
    await switchTo("webhook");
    // Someone removes the webhook in the App's settings on GitHub, which then answers a read of the delivery log with 404.
    stub.updateApp(app, { hook: null });

    await redeliver(stored.github, () => new Date(), jobs);

    const row = await appRow();
    expect(row.mode).toBe("polling");
    expect(row.given_up_at).not.toBeNull();
    expect(await adminPage()).toContain("GitHub runs in polling mode");
    const events = await modeEvents();
    expect(events.map(({ actor_kind, actor_user_id, data }) => ({ actor_kind, actor_user_id, data }))).toEqual([
      { actor_kind: "web_session", actor_user_id: ada.userId, data: { mode: "polling", previousMode: "webhook", cause: "admin_switch" } },
      { actor_kind: "web_session", actor_user_id: ada.userId, data: { mode: "webhook", previousMode: "polling", cause: "admin_switch" } },
      { actor_kind: "system", actor_user_id: null, data: { mode: "polling", previousMode: "webhook", cause: "webhook_removed" } },
    ]);
    // The same write: the banner and the event carry its time.
    expect(events.at(-1)!.occurred_at).toEqual(row.given_up_at);

    // The admins and the members of FE, whose mirrors go through GitHub, see the banner, which names the cause; a member of DATA does not.
    for (const session of [ada, ayse]) expect(await webhookBanner(session)).toContain("GitHub holds no webhook for the install's App any more");
    expect(await webhookBanner(dan)).toBeUndefined();
    expect(alerts).toEqual([{ alert: "github_webhook", raisedAt: row.given_up_at!.toISOString() }]);

    // In polling mode the job reads no log, and records nothing more.
    const from = stub.received.length;
    for (let run = 0; run < 2; run += 1) await redeliver(stored.github, () => new Date(), jobs);
    expect(stub.received.slice(from).filter(({ path }) => path.startsWith("/app/hook"))).toEqual([]);
    expect(await appRow()).toEqual(row);
    expect(await modeEvents()).toHaveLength(3);
    expect(alerts).toHaveLength(1);
  });

  it("changes nothing for GitHub's 404 while no webhook secret is stored, and alerts no one", async () => {
    await install.owner.query("DELETE FROM integration_secrets WHERE name = 'github_app.webhook_secret'");
    stub.updateApp(app, { hook: null });

    await redeliver(stored.github, () => new Date(), jobs);

    expect(await appRow()).toEqual({ mode: "webhook", given_up_at: null });
    expect(await modeEvents()).toEqual([]);
    expect(await webhookBanner(ada)).toBeUndefined();
    expect(alerts).toEqual([]);
  });

  it("is cleared by an admin's next switch of the mode, and a run that still finds no webhook moves GitHub to polling mode again", async () => {
    stub.updateApp(app, { hook: null });
    await redeliver(stored.github, () => new Date(), jobs);
    expect((await appRow()).mode).toBe("polling");

    await switchTo("webhook");
    expect(await appRow()).toEqual({ mode: "webhook", given_up_at: null });
    expect(await webhookBanner(ada)).toBeUndefined();

    await redeliver(stored.github, () => new Date(), jobs);
    const row = await appRow();
    expect(row.mode).toBe("polling");
    expect(row.given_up_at).not.toBeNull();
    expect(await webhookBanner(ada)).toContain("GitHub holds no webhook for the install's App any more");
    expect((await modeEvents()).map(({ data }) => data["cause"])).toEqual(["webhook_removed", "admin_switch", "webhook_removed"]);
    // The banner came back, so the admins are emailed about it again.
    expect(alerts).toHaveLength(2);
  });

  it("is cleared by a verified delivery once the webhook is added back on GitHub", async () => {
    stub.updateApp(app, { hook: null });
    await redeliver(stored.github, () => new Date(), jobs);
    expect(await webhookBanner(ada)).toBeDefined();

    stub.updateApp(app, { hook: { url: hooks.url } });
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" });
    await stub.settled();
    expect(stub.deliveries(app).at(-1)).toMatchObject({ event: "pull_request", statusCode: 202 });

    expect(await webhookBanner(ada)).toBeUndefined();
    expect(await webhookBanner(ayse)).toBeUndefined();
  });

  it("names a given-up delivery, not a removed webhook, when a delivery is given up while the webhook is there", async () => {
    await missedDelivery();
    stub.setHookReachable(false);
    for (let run = 0; run <= REDELIVERY_ASKS; run += 1) await redeliver(stored.github, () => new Date(), jobs);
    const text = await webhookBanner(ada);
    expect(text).toContain("Tiehall gave one up after asking GitHub 5 times");
    expect(text).not.toContain("holds no webhook");
  });
});

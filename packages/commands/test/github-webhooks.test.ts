import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signBody, startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { CATALOG } from "@tiehall/catalog";
import {
  createExecute,
  createGitHubWebhookRoute,
  createInstallGitHub,
  HANDLERS,
  migrate,
  openDatabase,
  openSecretBox,
  processGitHubDelivery,
  pruneGitHubDeliveries,
  pruneSecurityEventOrigins,
  releaseHeldGitHubDeliveries,
  storeGitHubApp,
  WORKER_JOBS,
  type Database,
  type JobData,
  type JobSender,
  type SecretBox,
} from "../src/index.ts";

// GitHub's webhook deliveries at /webhooks/github (tracker-mirrors: GitHub
// webhooks are verified, deduplicated and processed in the background;
// self-host-install: The setup code guards the setup screen; design.md,
// Technical decisions: T16; github-app-reachability: design.md, Design rules:
// An App without a webhook). A delivery is verified with the App's webhook
// secret, stored once by its delivery id, answered with a 2xx status, and
// processed afterwards in a background job. Every delivery gets 401 and is
// neither stored nor processed while no webhook secret is stored, as for an
// App created without a webhook, and so does one whose signature does not
// verify. Deliveries are accepted from the moment the App's credentials are
// stored, before setup completes, and those that arrive before setup completes
// are processed once it does. A nightly job deletes a stored delivery, its
// payload with it, 7 days after it was processed, and one never processed 30
// days after it arrived, before setup completes too (github-layer-hardening:
// design.md, Decisions this change rests on: D50 (4); design.md, Technical
// decisions: T3). The deliveries here are the GitHub stub's own, signed as
// GitHub signs them, sent to a local server that answers with the route.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let box: SecretBox;
let stub: GitHubStub;
let server: Server;
let hook: string;
/** The jobs the route and the jobs sent, in order. */
let sent: { queue: string; data: JobData }[];
const jobs: JobSender = {
  async send(_tx, queue, data) {
    sent.push({ queue, data });
  },
};

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  box = openSecretBox(randomBytes(32).toString("base64url"));
  const route = createGitHubWebhookRoute({ database: db, secrets: () => box, jobs });
  server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
      const method = incoming.method ?? "GET";
      const request = new Request(`https://tiehall.example.com${incoming.url ?? "/"}`, {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
      });
      void route(request).then(async (answer) => {
        outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
        outgoing.end(Buffer.from(await answer.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/github`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

beforeEach(async () => {
  sent = [];
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
});

afterEach(async () => {
  await stub.close();
  await owner.query(
    `DELETE FROM github_deliveries; DELETE FROM github_covered_repositories; DELETE FROM github_connected_installations;
     DELETE FROM github_installations; DELETE FROM integration_secrets; DELETE FROM github_app; DELETE FROM orgs`,
  );
});

/** The install before setup completes, with the App the setup screen stored; its webhook secret is the stub App's. */
async function installWith(app: StubApp): Promise<string> {
  const orgId = (await owner.query<{ id: string }>("INSERT INTO orgs (name) VALUES ('Acme') RETURNING id")).rows[0]?.id ?? "";
  await db.transaction((tx) =>
    storeGitHubApp({ tx, orgId }, box, {
      id: app.id,
      slug: app.slug,
      name: app.name,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      privateKey: app.pem,
      webhookSecret: app.webhookSecret,
      owner: { login: app.owner.login, type: app.owner.type },
    }),
  );
  return orgId;
}

/**
 * An App with its webhook at the local server, which the stub delivers to. Its
 * ping, which GitHub sends when an App is created, is answered before the setup
 * screen has stored the App.
 */
async function appWithAWebhook(): Promise<StubApp> {
  const app = stub.createApp({ owner: "acme", hook: { url: hook } });
  await stub.settled();
  return app;
}

async function completeSetup(): Promise<void> {
  await owner.query("UPDATE orgs SET setup_completed_at = now()");
}

async function stored(): Promise<{ delivery_id: string; event: string; processed: boolean }[]> {
  const { rows } = await owner.query<{ delivery_id: string; event: string; processed: boolean }>(
    "SELECT delivery_id, event, processed_at IS NOT NULL AS processed FROM github_deliveries ORDER BY received_at",
  );
  return rows;
}

/** A delivery as GitHub would send it, signed with the given secret, or unsigned. */
function post(body: string, signedWith: string | undefined, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(hook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "installation",
      "x-github-delivery": randomUUID(),
      ...(signedWith === undefined ? {} : { "x-hub-signature-256": signBody(signedWith, body).sha256 }),
      ...headers,
    },
    body,
  });
}

const INSTALLATION = JSON.stringify({ action: "created", installation: { id: 1 } });

/** Runs the jobs sent so far that the worker would run, as the worker does with its clock, and forgets them. */
async function runSentJobs(now: () => Date = () => new Date()): Promise<void> {
  const queued = sent.splice(0);
  for (const { queue, data } of queued) {
    expect(queue).toBe(processGitHubDelivery.type.queue);
    await processGitHubDelivery.handle(
      { id: randomUUID(), queue, data: data as { deliveryId: string }, signal: new AbortController().signal },
      {
        database: db,
        now,
        // Processing an installation's delivery lists the App's installations, on the stub.
        github: createInstallGitHub({ database: db, secrets: () => box, apiUrl: stub.apiUrl, fetch }),
        execute: createExecute({ catalog: CATALOG, handlers: HANDLERS, store: { database: db, jobs } }),
      },
    );
  }
}

async function releaseHeld(): Promise<void> {
  await releaseHeldGitHubDeliveries.handle(
    { id: randomUUID(), queue: releaseHeldGitHubDeliveries.type.queue, data: {}, signal: new AbortController().signal },
    { database: db, now: () => new Date(), jobs },
  );
}

describe("/webhooks/github while no webhook secret is stored (github-app-reachability 1.4)", () => {
  for (const [how, secret] of [
    ["signed with some secret", "a secret GitHub never had"],
    ["signed with an empty secret", ""],
    ["not signed", undefined],
  ] as const) {
    it(`answers a delivery ${how} with 401, and stores and enqueues nothing`, async () => {
      // An App created without a webhook: GitHub gave no webhook secret.
      await installWith(stub.createApp({ owner: "acme" }));
      for (const complete of [false, true]) {
        if (complete) await completeSetup();
        const answer = await post(INSTALLATION, secret);
        expect(answer.status).toBe(401);
        expect(answer.headers.get("content-type")).toBe("application/problem+json");
      }
      expect(await stored()).toEqual([]);
      expect(sent).toEqual([]);
    });
  }
});

describe("/webhooks/github with the App's webhook secret stored", () => {
  it("answers a forged delivery with 401, and neither stores nor processes it", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    await completeSetup();
    for (const answer of [
      await post(INSTALLATION, "another secret"),
      await post(INSTALLATION, undefined),
      await post(INSTALLATION, undefined, { "x-hub-signature-256": "sha256=zz" }),
      await post(INSTALLATION, undefined, { "x-hub-signature": signBody(app.webhookSecret!, INSTALLATION).sha1 }),
      // Signed for another body.
      await post(INSTALLATION, undefined, { "x-hub-signature-256": signBody(app.webhookSecret!, "{}").sha256 }),
    ]) {
      expect(answer.status).toBe(401);
    }
    await runSentJobs();
    expect(await stored()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("stores a verified delivery, answers 2xx, and processes it in a background job", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    await completeSetup();
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    const [delivery] = stub.deliveries(app).filter(({ event }) => event === "installation");
    expect(delivery?.statusCode).toBe(202);
    expect(await stored()).toEqual([{ delivery_id: delivery?.guid, event: "installation", processed: false }]);
    expect(sent).toEqual([{ queue: processGitHubDelivery.type.queue, data: { deliveryId: delivery?.guid } }]);
    await runSentJobs();
    expect(await stored()).toEqual([{ delivery_id: delivery?.guid, event: "installation", processed: true }]);
  });

  it("answers a repeated delivery id with 2xx, and sends no second job", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    await completeSetup();
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    const [delivery] = stub.deliveries(app).filter(({ event }) => event === "installation");
    const again = await stub.redeliver(delivery!);
    expect(again?.guid).toBe(delivery?.guid);
    expect(again?.statusCode).toBe(202);
    expect(await stored()).toHaveLength(1);
    expect(sent).toHaveLength(1);
    await runSentJobs();
    expect(await stub.redeliver(delivery!)).toMatchObject({ statusCode: 202 });
    expect(sent).toEqual([]);
    expect(await stored()).toEqual([{ delivery_id: delivery?.guid, event: "installation", processed: true }]);
  });

  it("stores a delivery that arrives during setup, and processes it once setup completes", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    // The operator installs the App on acme before signing in; GitHub delivers the installation at once.
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    const [delivery] = stub.deliveries(app).filter(({ event }) => event === "installation");
    expect(delivery?.statusCode).toBe(202);
    expect(await stored()).toEqual([{ delivery_id: delivery?.guid, event: "installation", processed: false }]);
    // Nothing runs before setup completes.
    expect(sent).toEqual([]);
    await releaseHeld();
    expect(sent).toEqual([]);

    await completeSetup();
    await releaseHeld();
    expect(sent).toEqual([{ queue: processGitHubDelivery.type.queue, data: { deliveryId: delivery?.guid } }]);
    await runSentJobs();
    expect(await stored()).toEqual([{ delivery_id: delivery?.guid, event: "installation", processed: true }]);
    // Released once: the next run sends nothing.
    await releaseHeld();
    expect(sent).toEqual([]);
  });

  it("refuses a verified delivery without its delivery id or event with 400, and stores nothing", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    await completeSetup();
    for (const headers of [{ "x-github-delivery": "" }, { "x-github-event": "" }, { "x-github-delivery": "not a delivery id!" }]) {
      const answer = await post(INSTALLATION, app.webhookSecret!, headers);
      expect(answer.status).toBe(400);
      expect(answer.headers.get("content-type")).toBe("application/problem+json");
    }
    expect((await post("not json", app.webhookSecret!)).status).toBe(400);
    expect((await post("[]", app.webhookSecret!)).status).toBe(400);
    expect(await stored()).toEqual([]);
    expect(sent).toEqual([]);
  });

  // GitHub caps a delivery at 25 MB, and the route takes at most 25 MiB, so it reads no body of any size before
  // it checks the signature (public-api: Request bodies have a size limit). The web role's request guard refuses
  // such a body first; the route refuses it too, where the guard is not installed.
  it("refuses a delivery over 25 MiB with 413 before reading it past the limit, and stores nothing", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    await completeSetup();
    const route = createGitHubWebhookRoute({ database: db, secrets: () => box, jobs });
    const MiB = 1024 * 1024;
    let pulled = 0;
    const chunk = new Uint8Array(MiB).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 40 * MiB) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const delivery = (streamed: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
      new Request(hook.replace(/^http:\/\/[^/]+/, "https://tiehall.example.com"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": "installation", "x-github-delivery": randomUUID(), ...headers },
        body: streamed,
        duplex: "half",
      } as RequestInit);
    const answer = await route(delivery(body));
    expect(answer.status).toBe(413);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/payload-too-large", detail: expect.stringContaining("25 MiB") });
    expect(pulled).toBeLessThanOrEqual(27 * MiB);

    let declaredPulls = 0;
    const declared = new ReadableStream<Uint8Array>({
      pull(controller) {
        declaredPulls += 1;
        controller.enqueue(chunk);
      },
    });
    expect((await route(delivery(declared, { "content-length": String(25 * MiB + 1) }))).status).toBe(413);
    expect(declaredPulls).toBeLessThanOrEqual(1);
    expect(await stored()).toEqual([]);
    expect(sent).toEqual([]);
  });

  // A delivery is verified against the stored secret, read in a short read-only query, before any write
  // transaction opens: an unsigned or forged delivery takes no lock on the org's row, so a flood of them holds
  // up nothing, such as the sign-in that completes setup, which locks that row.
  it("answers an unsigned delivery with 401 while another transaction holds the org's row, taking no lock on it", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    await completeSetup();
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM orgs FOR UPDATE");
      const answer = await Promise.race([
        post(INSTALLATION, undefined),
        post(INSTALLATION, "another secret"),
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 3_000)),
      ]);
      expect(answer === "held" ? answer : answer.status).toBe(401);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect(await stored()).toEqual([]);
  });

  it("offers nothing but POST", async () => {
    await installWith(await appWithAWebhook());
    expect((await fetch(hook)).status).toBe(404);
  });
});

describe("the worker's jobs", () => {
  it("include processing deliveries and releasing the ones held during setup, which runs every minute", () => {
    expect(WORKER_JOBS).toContain(processGitHubDelivery);
    expect(WORKER_JOBS).toContain(releaseHeldGitHubDeliveries);
    expect(releaseHeldGitHubDeliveries.schedule).toBe("* * * * *");
  });

  it("include the pruning of stored deliveries, which runs daily, beside the pruning of IP addresses and user agents", () => {
    expect(WORKER_JOBS).toContain(pruneGitHubDeliveries);
    expect(WORKER_JOBS).toContain(pruneSecurityEventOrigins);
    // Once a day, at a fixed minute and hour, every day of every month.
    expect(pruneGitHubDeliveries.schedule).toMatch(/^[0-5]?\d (?:1?\d|2[0-3]) \* \* \*$/);
  });
});

describe("the nightly pruning of stored deliveries (github-layer-hardening 1.19)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Runs the pruning job once, as the daily schedule does, with the worker's clock at `now`. */
  async function pruneAt(now: Date): Promise<void> {
    await pruneGitHubDeliveries.handle(
      { id: randomUUID(), queue: pruneGitHubDeliveries.type.queue, data: {}, signal: new AbortController().signal },
      { database: db, now: () => now, jobs },
    );
  }

  /** When the delivery arrived and was processed, as the database holds them. */
  async function timesOf(deliveryId: string): Promise<{ receivedAt: Date; processedAt: Date | null }> {
    const { rows } = await owner.query<{ received_at: Date; processed_at: Date | null }>(
      "SELECT received_at, processed_at FROM github_deliveries WHERE delivery_id = $1",
      [deliveryId],
    );
    if (rows[0] === undefined) throw new Error(`No delivery ${deliveryId} is stored.`);
    return { receivedAt: rows[0].received_at, processedAt: rows[0].processed_at };
  }

  /** Whether any stored row, its payload included, holds the text. */
  async function held(text: string): Promise<boolean> {
    const { rows } = await owner.query<{ row: string }>("SELECT to_jsonb(d)::text AS row FROM github_deliveries d");
    return rows.some(({ row }) => row.includes(text));
  }

  /** A verified delivery the route stores, about an installation on an account whose login it names; returns its id. */
  async function deliver(secret: string, login: string): Promise<string> {
    const deliveryId = randomUUID();
    const body = JSON.stringify({ action: "created", installation: { id: 1, account: { login } } });
    expect((await post(body, secret, { "x-github-delivery": deliveryId })).status).toBe(202);
    return deliveryId;
  }

  it("deletes a delivery processed 8 days ago, its payload with it, and keeps one processed 6 days ago", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    await completeSetup();
    const older = await deliver(app.webhookSecret!, "older-account");
    const newer = await deliver(app.webhookSecret!, "newer-account");
    const start = new Date();
    // The worker processes the older delivery now, and the newer one 2 days later.
    sent = sent.filter(({ data }) => (data as { deliveryId: string }).deliveryId === older);
    await runSentJobs(() => start);
    sent = [{ queue: processGitHubDelivery.type.queue, data: { deliveryId: newer } }];
    await runSentJobs(() => new Date(start.getTime() + 2 * DAY));
    expect((await timesOf(older)).processedAt).toEqual(start);

    await pruneAt(new Date(start.getTime() + 8 * DAY));

    expect(await stored()).toEqual([{ delivery_id: newer, event: "installation", processed: true }]);
    expect(await held("older-account")).toBe(false);
    expect(await held("newer-account")).toBe(true);
  });

  it("keeps a delivery never processed that arrived 29 days ago, and deletes one that arrived 31 days ago", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    await completeSetup();
    // Neither is processed: their jobs failed, and wait in the dead-letter queue.
    const earlier = await deliver(app.webhookSecret!, "earlier-account");
    const later = await deliver(app.webhookSecret!, "later-account");
    sent = [];
    await owner.query("UPDATE github_deliveries SET received_at = received_at - interval '2 days' WHERE delivery_id = $1", [earlier]);
    const { receivedAt } = await timesOf(later);

    await pruneAt(new Date(receivedAt.getTime() + 29 * DAY));

    expect(await stored()).toEqual([{ delivery_id: later, event: "installation", processed: false }]);
    expect(await held("earlier-account")).toBe(false);
  });

  it("deletes a held delivery that arrived 31 days ago while setup is still incomplete, and keeps one that arrived 29 days ago, which is processed when setup completes", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    const earlier = await deliver(app.webhookSecret!, "earlier-account");
    const later = await deliver(app.webhookSecret!, "later-account");
    expect(sent).toEqual([]);
    await owner.query("UPDATE github_deliveries SET received_at = received_at - interval '2 days' WHERE delivery_id = $1", [earlier]);
    const { receivedAt } = await timesOf(later);

    await pruneAt(new Date(receivedAt.getTime() + 29 * DAY));

    expect(await stored()).toEqual([{ delivery_id: later, event: "installation", processed: false }]);
    expect(await held("earlier-account")).toBe(false);
    await completeSetup();
    await releaseHeld();
    expect(sent).toEqual([{ queue: processGitHubDelivery.type.queue, data: { deliveryId: later } }]);
    await runSentJobs();
    expect(await stored()).toEqual([{ delivery_id: later, event: "installation", processed: true }]);
  });

  it("deletes nothing, and fails nothing, before the setup screen has made the install's org", async () => {
    await pruneAt(new Date(Date.now() + 400 * DAY));
    expect(await stored()).toEqual([]);
  });

  it("keeps a delivery 2 days after it was processed, so GitHub sending it again then is answered 2xx and not processed again", async () => {
    const app = await appWithAWebhook();
    await installWith(app);
    await completeSetup();
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    const [delivery] = stub.deliveries(app).filter(({ event }) => event === "installation");
    const start = new Date();
    await runSentJobs(() => start);

    await pruneAt(new Date(start.getTime() + 2 * DAY));
    const again = await stub.redeliver(delivery!);

    expect(again).toMatchObject({ guid: delivery?.guid, statusCode: 202 });
    expect(sent).toEqual([]);
    expect(await stored()).toEqual([{ delivery_id: delivery?.guid, event: "installation", processed: true }]);
  });
});

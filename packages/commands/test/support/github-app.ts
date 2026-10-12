import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import type { GitHubStub, StubApp, StubDelivery } from "@tiehall/testing/github";
import { httpProblem } from "@tiehall/core";
import { bodiesBusy, createGitHubWebhookRoute, createInstallGitHub, storeGitHubApp, type InstallGitHub, type SecretBox } from "../../src/index.ts";
import type { TestInstall } from "./install.ts";

// The install's GitHub App for the tests of what Tiehall does with GitHub: an
// App the GitHub stub created, stored in the install as the setup screen
// stores the App the manifest flow creates, and the client that calls GitHub
// as it, pointed at the stub.

export interface StoredStubApp {
  box: SecretBox;
  /** The install's App, as the worker and the web role reach it, calling the stub. */
  github: InstallGitHub;
}

/**
 * The database's clock, in milliseconds since the epoch, read on the host:
 * the host's clock plus how far the database container's runs ahead of it,
 * measured once. The GitHub stub runs on it where a test compares the times
 * GitHub logs, such as a delivery's, with times the database stamps, such as
 * when the App's credentials were stored, so a host clock a second or two off
 * the container's cannot reorder them.
 */
export async function databaseClock(owner: pg.Client, host: () => number = Date.now): Promise<() => number> {
  const asked = host();
  const { rows } = await owner.query<{ now: number }>("SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now");
  const answered = host();
  const offset = Number(rows[0]!.now) - (asked + answered) / 2;
  return () => host() + offset;
}

/** Stores the stub's App in the install, with its credentials encrypted with the install's box, and returns what calls GitHub as it. */
export async function storeStubApp(install: TestInstall, stub: GitHubStub, app: StubApp): Promise<StoredStubApp> {
  const box = install.box;
  await install.db.transaction(async (tx) => {
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM orgs");
    await storeGitHubApp({ tx, orgId: rows[0]?.id ?? "" }, box, {
      id: app.id,
      slug: app.slug,
      name: app.name,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      privateKey: app.pem,
      webhookSecret: app.webhookSecret,
      owner: { login: app.owner.login, type: app.owner.type },
    });
  });
  // The stub serves on local ports, which the client reaches with the plain fetch; at an install it reaches GitHub only.
  return { box, github: createInstallGitHub({ database: install.db, secrets: () => box, apiUrl: stub.apiUrl, fetch, logger: install.logger }) };
}

/** Stores a delivery the stub made as /webhooks/github stores a verified one once setup is complete, ready to be processed. */
export async function storeDelivery(install: TestInstall, delivery: StubDelivery): Promise<string> {
  await install.owner.query(
    "INSERT INTO github_deliveries (org_id, delivery_id, event, payload, enqueued_at) SELECT id, $1, $2, $3, now() FROM orgs",
    [delivery.guid, delivery.event, JSON.stringify(delivery.request.payload)],
  );
  return delivery.guid;
}

/** A local server that answers GitHub's deliveries with the install's /webhooks/github route. */
export interface WebhookServer {
  /** The hook URL to give the stub's App, on loopback, where the stub delivers. */
  url: string;
  /**
   * While true, every delivery is answered as the web role's request guard answers a body beyond what one process
   * receives at once: 503 busy, with Retry-After, before its body is read (public-api: Request bodies have a size
   * limit). False unless a test sets it.
   */
  busy: boolean;
  close(): Promise<void>;
}

/**
 * Serves /webhooks/github for the install on a local port, so the stub's
 * deliveries reach the real route; the jobs the route sends join the install's
 * sent jobs. The stored webhook secret is opened with the box the secrets give,
 * which may be stored after the server starts.
 */
export async function serveWebhooks(install: TestInstall, secrets: () => SecretBox): Promise<WebhookServer> {
  const route = createGitHubWebhookRoute({
    database: install.db,
    secrets,
    jobs: { send: async (_tx, queue, data) => void install.sentJobs.push({ queue, data }) },
    logger: install.logger,
  });
  let busy = false;
  const server = createServer((incoming, outgoing) => {
    if (busy) {
      const { status, headers, body } = httpProblem(bodiesBusy());
      outgoing.writeHead(status, { ...headers, connection: "close" });
      outgoing.end(JSON.stringify(body));
      return;
    }
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
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/github`,
    get busy() {
      return busy;
    },
    set busy(value) {
      busy = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

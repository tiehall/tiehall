import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, createSignInService, migrate, openDatabase, openSecretBox, storeGitHubApp, type Database } from "@tiehall/commands";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { installRequestGuard, type RequestGuard } from "../src/request-guard.ts";
import { TrustedProxies } from "../src/trusted-proxies.ts";

// Dynamic Client Registration counts registrations per client address, as the
// install sees it after its trusted proxies (agent-access: Dynamic Client
// Registration stays on, limited and unverified; self-host-install:
// `TIEHALL_URL` and TLS). Behind a proxy the operator names, the address is
// the one the proxy forwards, so two clients behind it are counted apart: the
// second registers while the first has used its 10 for the hour. A client
// that is not a trusted proxy cannot name its own address: the web role's
// request guard puts the connection's address in X-Forwarded-For, so a client
// that sends a new X-Forwarded-For with every registration is still counted
// as one address, and its 11th registration in the hour gets 429.

const migrationsFolder = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const URL_OF_INSTALL = "https://tiehall.example.com";

interface Install {
  database: TestDatabase;
  owner: pg.Client;
  db: Database;
  appRole: { name: string; password: string };
  guard: RequestGuard;
  server: http.Server;
  port: number;
}

/** An install whose sign-in service answers behind the request guard, trusting these proxies. */
async function startInstall(proxies: readonly string[]): Promise<Install> {
  const database = await createTestDatabase();
  const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
  const owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  const db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  const box = openSecretBox(randomBytes(32).toString("base64url"));
  const orgId = (await owner.query<{ id: string }>("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now()) RETURNING id")).rows[0]!.id;
  // The sign-in service is built from the stored App's client id and secret; nothing here reaches GitHub.
  await db.transaction((tx) =>
    storeGitHubApp({ tx, orgId }, box, {
      id: 1,
      slug: "tiehall-acme",
      name: "Tiehall Acme",
      clientId: "Iv23liRegistrationLimit",
      clientSecret: randomBytes(20).toString("hex"),
      privateKey: "not used here",
      webhookSecret: null,
      owner: { login: "acme", type: "Organization" },
    }),
  );
  const signIn = createSignInService({
    database: db,
    url: URL_OF_INSTALL,
    secret: () => "a secret of the sign-in service for this test only",
    secrets: () => box,
    github: { fetch: async () => new Response(null, { status: 503 }) },
    logger: createLogger({ write: () => {} }),
  });
  const guard = installRequestGuard({ proxies: new TrustedProxies(proxies), url: URL_OF_INSTALL });
  const server = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
      const request = new Request(`${URL_OF_INSTALL}${incoming.url ?? "/"}`, { method: incoming.method ?? "GET", headers, body: Buffer.concat(chunks) });
      void signIn.handler(request).then(async (answer) => {
        outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
        outgoing.end(Buffer.from(await answer.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { database, owner, db, appRole, guard, server, port: (server.address() as AddressInfo).port };
}

async function stop(install: Install | undefined): Promise<void> {
  if (install === undefined) return;
  await new Promise((resolve) => install.server.close(resolve));
  install.guard.uninstall();
  await install.db.$client.end();
  await install.owner.query(`DROP OWNED BY ${pg.escapeIdentifier(install.appRole.name)}; DROP ROLE ${pg.escapeIdentifier(install.appRole.name)}`);
  await install.owner.end();
  await install.database.drop();
}

function register(install: Install, forwardedFor: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${install.port}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify({
      client_name: "An agent",
      redirect_uris: ["http://127.0.0.1:53682/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
}

describe("registrations behind a proxy the operator names", () => {
  let install: Install | undefined;
  beforeAll(async () => {
    // The test's own connections come from 127.0.0.1, which plays the operator's reverse proxy.
    install = await startInstall(["127.0.0.1"]);
  });
  afterAll(() => stop(install));

  it("are counted per address the proxy forwards: a second address registers while the first has used its 10", async () => {
    const proxied = install!;
    for (let index = 1; index <= 10; index += 1) {
      const answer = await register(proxied, "203.0.113.5");
      await answer.arrayBuffer();
      expect(answer.status, `registration ${index}`).toBe(201);
    }
    const refused = await register(proxied, "203.0.113.5");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    await refused.arrayBuffer();
    const other = await register(proxied, "198.51.100.7");
    expect(other.status).toBe(201);
    const { rows } = await proxied.owner.query<{ address: string; count: string }>(
      "SELECT host(ip_address) AS address, count(*) FROM oauth_client_registrations GROUP BY 1 ORDER BY 1",
    );
    expect(rows).toEqual([
      { address: "198.51.100.7", count: "1" },
      { address: "203.0.113.5", count: "10" },
    ]);
  });
});

describe("registrations from a client that is no trusted proxy", () => {
  let install: Install | undefined;
  beforeAll(async () => {
    install = await startInstall([]);
  });
  afterAll(() => stop(install));

  it("are counted by the connection's address, however the client names its own: the 11th gets 429", async () => {
    const direct = install!;
    for (let index = 1; index <= 10; index += 1) {
      const answer = await register(direct, `203.0.113.${index}`);
      await answer.arrayBuffer();
      expect(answer.status, `registration ${index}`).toBe(201);
    }
    const refused = await register(direct, "203.0.113.11");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ type: "https://tiehall.com/problems/rate-limited" });
  });
});

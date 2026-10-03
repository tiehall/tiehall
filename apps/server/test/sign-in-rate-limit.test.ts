import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, createSignInService, migrate, openDatabase, openSecretBox, storeGitHubApp, type Database, type SignInService } from "@tiehall/commands";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { installRequestGuard, type RequestGuard } from "../src/request-guard.ts";
import { TrustedProxies } from "../src/trusted-proxies.ts";

// The sign-in service's rate limit is keyed on the client address the web
// role's request guard puts, alone, in X-Forwarded-For (design.md, Technical
// decisions: T7; self-host-install: `TIEHALL_URL` and TLS). A client that is
// not a trusted proxy cannot name its own address: the guard drops the
// X-Forwarded-For it sends and puts the connection's address there instead.
// So a client that sends a new X-Forwarded-For with every call still has one
// key, and is limited like any other: GitHub's return to the sign-in
// callback, the one sign-in route served over HTTP, takes 100 calls per 10
// seconds from one address, and the next gets 429.

const migrationsFolder = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
const URL_OF_INSTALL = "https://tiehall.example.com";

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let signIn: SignInService;
let guard: RequestGuard;
let server: http.Server;
let port: number;

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  const box = openSecretBox(randomBytes(32).toString("base64url"));
  const orgId = (await owner.query<{ id: string }>("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now()) RETURNING id")).rows[0]!.id;
  // The sign-in service is built from the stored App's client id and secret; nothing here reaches GitHub.
  await db.transaction((tx) =>
    storeGitHubApp({ tx, orgId }, box, {
      id: 1,
      slug: "tiehall-acme",
      name: "Tiehall Acme",
      clientId: "Iv23liRateLimitTest",
      clientSecret: randomBytes(20).toString("hex"),
      privateKey: "not used here",
      webhookSecret: null,
      owner: { login: "acme", type: "Organization" },
    }),
  );
  signIn = createSignInService({
    database: db,
    url: URL_OF_INSTALL,
    secret: () => randomBytes(32).toString("base64url"),
    secrets: () => box,
    github: { fetch: async () => new Response(null, { status: 503 }) },
    logger: createLogger({ write: () => {} }),
  });
  // No trusted proxy: every peer's forwarded headers are dropped.
  guard = installRequestGuard({ proxies: new TrustedProxies([]), url: URL_OF_INSTALL });
  server = http.createServer((incoming, outgoing) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
    void signIn.handler(new Request(`${URL_OF_INSTALL}${incoming.url ?? "/"}`, { headers })).then(async (answer) => {
      outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
      outgoing.end(Buffer.from(await answer.arrayBuffer()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  guard.uninstall();
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

describe("the sign-in service's rate limit behind the request guard", () => {
  it("keeps one key for a client that sends a new X-Forwarded-For with every call, and answers its 101st call with 429", async () => {
    const callback = (call: number) =>
      fetch(`http://127.0.0.1:${port}/api/auth/callback/github?code=not-a-code&state=not-a-state`, {
        headers: { "x-forwarded-for": `203.0.113.${call % 250}, 198.51.100.${call % 250}` },
        redirect: "manual",
      });
    for (let call = 0; call < 100; call += 1) {
      const answer = await callback(call);
      await answer.arrayBuffer();
      expect(answer.status, `call ${call + 1}`).not.toBe(429);
    }
    const limited = await callback(100);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ type: "https://tiehall.com/problems/rate-limited" });
  });
});

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createLogger,
  createSetupGate,
  migrate,
  openDatabase,
  openSecretBox,
  storeGitHubApp,
  storeSecret,
  type Database,
  type SetupGate,
} from "../src/index.ts";

// The setup gate (self-host-install: The setup code guards the setup screen;
// public-api: One error model for Tiehall's own refusals; design.md,
// Self-hosting decisions: S3). Until setup is complete, every page leads to
// /setup, and every API call answers 503 with the problem type
// setup-required, the OpenAPI document included. Only /setup, /healthz, the
// web UI's assets (/favicon.ico and every path under /assets/) and, once the
// GitHub App's credentials are stored, /webhooks/github are served.
// The App's credentials count as stored from its private key, which every App
// has, with or without a webhook secret, which an App created without a
// webhook lacks (github-app-reachability: design.md, Technical decisions: T3).
// The gate reads the install's state as the app role, as the web role does.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "https://tiehall.example.com";

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  await owner.query("DELETE FROM integration_secrets; DELETE FROM github_app; DELETE FROM orgs");
});

/** What the gate answers for a call: its status, Location and problem, or "served" when it lets the call through. */
async function ask(gate: SetupGate, path: string, init: RequestInit = {}) {
  const answer = await gate(new Request(`${ORIGIN}${path}`, init));
  if (answer === undefined) return "served" as const;
  const text = await answer.text();
  return {
    status: answer.status,
    location: answer.headers.get("location"),
    contentType: answer.headers.get("content-type"),
    cacheControl: answer.headers.get("cache-control"),
    problem: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** The number of rows in each of the app's tables, to show that a call stored nothing. */
async function rowCounts(): Promise<Record<string, number>> {
  const { rows: tables } = await owner.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    counts[name] = (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${pg.escapeIdentifier(name)}`)).rows[0]?.n ?? 0;
  }
  return counts;
}

const setupRequired = {
  status: 503,
  location: null,
  contentType: "application/problem+json",
  cacheControl: "no-store",
  problem: expect.objectContaining({ type: "https://tiehall.com/problems/setup-required", status: 503 }),
};

/** A page's answer: it leads to the setup screen at the install's URL. */
const toSetup = (status: number) => ({ status, location: `${ORIGIN}/setup`, contentType: null, cacheControl: "no-store", problem: undefined });

describe.each([
  ["before the install has its org", async () => {}],
  [
    "while the org exists and setup is not complete",
    async () => {
      // Setup has named the company, and has not completed.
      await owner.query("INSERT INTO orgs (name) VALUES ('Acme')");
    },
  ],
])("the setup gate %s", (_when, arrange) => {
  it.each(["/", "/FE-142", "/docs/api", "/docs/api/changelog", "/FE"])("redirects the page %s to /setup", async (path) => {
    await arrange();
    const gate = createSetupGate({ database: db, url: ORIGIN });
    expect(await ask(gate, path)).toEqual(toSetup(307));
    expect(await ask(gate, path, { method: "HEAD" })).toEqual(toSetup(307));
  });

  it("sends a form posted to a page to /setup with a GET", async () => {
    await arrange();
    expect(await ask(createSetupGate({ database: db, url: ORIGIN }), "/", { method: "POST", body: "x=1" })).toEqual(toSetup(303));
  });

  it.each([
    ["GET", "/api/v1/openapi.json"],
    ["GET", "/api/v1/requests/FE-142"],
    ["POST", "/api/v1/requests"],
    ["POST", "/mcp"],
    ["GET", "/.well-known/oauth-protected-resource"],
    ["GET", "/schemas/packet/v1-beta.json"],
    ["POST", "/api/auth/sign-in/social"],
    // GitHub's return to the usual sign-in; the setup screen's sign-in returns under /setup instead.
    ["GET", "/api/auth/callback/github?code=3584d83530557fdd1f46&state=Q2hvb3NlIGEgc3RhdGU"],
  ])("answers the API call %s %s with 503 setup-required", async (method, path) => {
    await arrange();
    expect(await ask(createSetupGate({ database: db, url: ORIGIN }), path, { method })).toEqual(setupRequired);
  });

  it.each(["/setup", "/healthz"])("serves %s", async (path) => {
    await arrange();
    const gate = createSetupGate({ database: db, url: ORIGIN });
    expect(await ask(gate, path)).toBe("served");
    expect(await ask(gate, path, { method: "POST", body: "code=x" })).toBe("served");
  });

  it("serves the setup screen's own steps under /setup", async () => {
    await arrange();
    expect(await ask(createSetupGate({ database: db, url: ORIGIN }), "/setup/github/app")).toBe("served");
  });

  // The web UI's assets hold nothing of the install's data, and the setup screen needs its stylesheet, fonts and
  // icons while nobody is signed in (web-ui: The install serves its own assets; design.md, Design: The install's
  // assets; D57 (14)).
  it.each(["/favicon.ico", "/favicon.ico?v=abc", "/assets/tiehall.css", "/assets/fonts/IBMPlexSans-Regular-Latin1.woff2", "/assets/fonts/OFL.txt", "/assets/nothing.css"])(
    "serves the web UI's asset path %s",
    async (path) => {
      await arrange();
      const gate = createSetupGate({ database: db, url: ORIGIN });
      expect(await ask(gate, path)).toBe("served");
      expect(await ask(gate, path, { method: "HEAD" })).toBe("served");
    },
  );

  it.each(["/assets", "/assetsx/tiehall.css", "/favicon.icon", "/favicon.ico/x", "/fonts/OFL.txt"])("still redirects the page %s to /setup", async (path) => {
    await arrange();
    expect(await ask(createSetupGate({ database: db, url: ORIGIN }), path)).toEqual(toSetup(307));
  });

  it("does not serve /webhooks/github before the App's credentials are stored, and stores nothing", async () => {
    await arrange();
    const before = await rowCounts();
    const delivery = {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "installation", "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958" },
      body: JSON.stringify({ action: "created", installation: { id: 1 } }),
    };
    expect(await ask(createSetupGate({ database: db, url: ORIGIN }), "/webhooks/github", delivery)).toEqual(setupRequired);
    expect(await rowCounts()).toEqual(before);
  });
});

describe("the setup gate once the App's credentials are stored", () => {
  async function servesWebhooksOnly(gate: SetupGate) {
    expect(await ask(gate, "/webhooks/github", { method: "POST", body: "{}" })).toBe("served");
    expect(await ask(gate, "/webhooks/jira/abc", { method: "POST", body: "{}" })).toEqual(setupRequired);
    expect(await ask(gate, "/api/v1/openapi.json")).toEqual(setupRequired);
    expect(await ask(gate, "/docs/api")).toEqual(toSetup(307));
    expect(await ask(gate, "/setup")).toBe("served");
  }

  it("serves /webhooks/github, and still nothing else but /setup and /healthz", async () => {
    const orgId = (await owner.query<{ id: string }>("INSERT INTO orgs (name) VALUES ('Acme') RETURNING id")).rows[0]?.id ?? "";
    // The setup screen stores the App's credentials before setup completes; the private key says they are stored.
    const box = openSecretBox(randomBytes(32).toString("base64url"));
    await db.transaction((tx) => storeSecret({ tx, orgId }, box, "github_app.private_key", "a private key"));
    await servesWebhooksOnly(createSetupGate({ database: db, url: ORIGIN }));
  });

  it("serves /webhooks/github for an App stored without a webhook secret, and still nothing else but /setup and /healthz", async () => {
    const orgId = (await owner.query<{ id: string }>("INSERT INTO orgs (name) VALUES ('Acme') RETURNING id")).rows[0]?.id ?? "";
    // An App created without a webhook, such as a trial install's: GitHub gives it no webhook secret.
    const box = openSecretBox(randomBytes(32).toString("base64url"));
    await db.transaction((tx) =>
      storeGitHubApp({ tx, orgId }, box, {
        id: 2000001,
        slug: "tiehall-localhost",
        name: "Tiehall localhost",
        clientId: "Iv23liExampleClient",
        clientSecret: "a client secret",
        privateKey: "a private key",
        webhookSecret: null,
        owner: { login: "acme", type: "Organization" },
      }),
    );
    expect((await owner.query("SELECT name FROM integration_secrets ORDER BY name")).rows).toEqual([
      { name: "github_app.client_secret" },
      { name: "github_app.private_key" },
    ]);
    await servesWebhooksOnly(createSetupGate({ database: db, url: ORIGIN }));
  });
});

describe("the setup gate once setup is complete", () => {
  it.each([
    ["GET", "/"],
    ["GET", "/FE-142"],
    ["GET", "/docs/api"],
    ["GET", "/api/v1/openapi.json"],
    ["POST", "/api/v1/requests"],
    ["POST", "/mcp"],
    ["POST", "/webhooks/github"],
    ["GET", "/healthz"],
    ["GET", "/setup"],
  ])("serves %s %s", async (method, path) => {
    await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
    expect(await ask(createSetupGate({ database: db, url: ORIGIN }), path, { method, ...(method === "POST" ? { body: "{}" } : {}) })).toBe("served");
  });

  it("stops reading the install's state once it has seen setup complete", async () => {
    await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
    const gate = createSetupGate({ database: db, url: ORIGIN });
    expect(await ask(gate, "/docs/api")).toBe("served");
    // Setup never becomes incomplete again: `setup reopen` reopens only the App step, and the install keeps serving.
    await owner.query("DELETE FROM orgs");
    expect(await ask(gate, "/docs/api")).toBe("served");
  });
});

describe("the setup gate when the database cannot be read", () => {
  it("serves /healthz, which answers down, and answers anything else with a 500 problem that says nothing", async () => {
    const unreachable = openDatabase({ connectionString: "postgres://tiehall_app@127.0.0.1:1/tiehall", password: "unused" });
    try {
      const logged: string[] = [];
      const gate = createSetupGate({ database: unreachable, url: ORIGIN, logger: createLogger({ write: (line) => logged.push(line) }) });
      expect(await ask(gate, "/healthz")).toBe("served");
      expect(await ask(gate, "/docs/api")).toMatchObject({ status: 500, contentType: "application/problem+json" });
      expect(logged.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(["setup gate: the install's state could not be read"]);
    } finally {
      await unreachable.$client.end();
    }
  });
});

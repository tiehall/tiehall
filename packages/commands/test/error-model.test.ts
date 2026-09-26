import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { PROBLEM_TYPE_BASE, Refusal } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createExecute,
  createLogger,
  createRestHandler,
  migrate,
  openDatabase,
  SetupRequiredError,
  type Caller,
  type Database,
  type RestHandler,
} from "../src/index.ts";

// The rows of the error model that REST reaches now (public-api: One error
// model for Tiehall's own refusals; public-api: Errors are RFC 9457 problem
// details), through the real route and execute(): both 404 rows, 400, 409,
// 429 with Retry-After and 503 setup-required. The 503 with Retry-After: 0
// that a call gets while the app shuts down is the web role's, tested in
// apps/server. Later tasks add a test for each row they make reachable.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const INSTALL = "https://tiehall.example.com";

/** Probe operations whose handlers refuse as a request's handlers will. */
const catalog = defineCatalog([
  defineCommand({
    id: "probes.get",
    summary: "Read a probe request, which does not exist.",
    input: z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/) }),
    output: z.object({ key: z.string() }),
    method: "GET",
    path: "/api/v1/probes/{key}",
    scopes: ["requests:read"],
    commitment: false,
    confirm: false,
    surfaces: ["rest"],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.claim",
    summary: "Claim a probe request, which someone already holds.",
    input: z.object({ key: z.string() }),
    output: z.object({}),
    method: "POST",
    path: "/api/v1/probes/{key}/claim",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest"],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.post",
    summary: "Post on a probe request, beyond the token's write limit.",
    input: z.object({ key: z.string(), body: z.string() }),
    output: z.object({}),
    method: "POST",
    path: "/api/v1/probes/{key}/messages",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest"],
    stability: "alpha",
  }),
]);

const agent: Caller = {
  kind: "personal_access_token",
  userId: randomUUID(),
  tokenId: randomUUID(),
  scopes: ["requests:read", "requests:write"],
  surface: "api",
};

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let rest: RestHandler;
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
  const execute = createExecute({
    catalog,
    handlers: {
      "probes.get": async (input) => {
        throw new Refusal("record-not-found", `There is no request ${(input as { key: string }).key}.`);
      },
      "probes.claim": async () => {
        throw new Refusal("conflict", "This request is already claimed.");
      },
      "probes.post": async () => {
        throw new Refusal("rate-limited", "This token has made 60 writes in the last minute.", { retryAfterSeconds: 17 });
      },
    },
    store: { database: db, jobs: { send: async () => {} } },
  });
  rest = createRestHandler({ catalog, execute, authenticate: async () => agent, logger: createLogger({ write: () => {} }) });
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

async function send(method: string, path: string, body?: unknown) {
  const response = await rest(
    new Request(`${INSTALL}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
  );
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  return { status: response.status, retryAfter: response.headers.get("retry-after"), problem: (await response.json()) as Record<string, unknown> };
}

describe("before setup is complete", () => {
  it("answers an operation with 503 and the problem type setup-required", async () => {
    const { status, retryAfter, problem } = await send("GET", "/api/v1/probes/FE-9999");
    expect(status).toBe(503);
    expect(retryAfter).toBeNull();
    expect(problem).toMatchObject({ type: `${PROBLEM_TYPE_BASE}setup-required`, status: 503 });
    expect(new SetupRequiredError()).toBeInstanceOf(Refusal);
  });
});

describe("once the install has its org", () => {
  beforeAll(async () => {
    await owner.query("INSERT INTO orgs (name) VALUES ('Acme')");
  });

  it("answers a path that serves no operation with 404 route-not-found", async () => {
    const { status, problem } = await send("GET", "/api/v1/no-such-operation");
    expect(status).toBe(404);
    expect(problem).toMatchObject({ type: `${PROBLEM_TYPE_BASE}route-not-found`, status: 404 });
  });

  it("answers a record that does not exist with 404 record-not-found", async () => {
    const { status, problem } = await send("GET", "/api/v1/probes/FE-9999");
    expect(status).toBe(404);
    expect(problem).toMatchObject({ type: `${PROBLEM_TYPE_BASE}record-not-found`, status: 404, detail: "There is no request FE-9999." });
  });

  it("answers input that fails the schema with 400 invalid-input", async () => {
    const { status, problem } = await send("GET", "/api/v1/probes/not-a-key");
    expect(status).toBe(400);
    expect(problem).toMatchObject({ type: `${PROBLEM_TYPE_BASE}invalid-input`, status: 400, errors: [{ path: ["key"] }] });
  });

  it("answers a state conflict with 409 conflict", async () => {
    const { status, problem } = await send("POST", "/api/v1/probes/FE-142/claim", {});
    expect(status).toBe(409);
    expect(problem).toMatchObject({ type: `${PROBLEM_TYPE_BASE}conflict`, status: 409 });
  });

  it("answers an exceeded limit with 429 and Retry-After", async () => {
    const { status, retryAfter, problem } = await send("POST", "/api/v1/probes/FE-142/messages", { body: "Which endpoint?" });
    expect(status).toBe(429);
    expect(retryAfter).toBe("17");
    expect(problem).toMatchObject({ type: `${PROBLEM_TYPE_BASE}rate-limited`, status: 429, retryAfter: 17 });
  });
});

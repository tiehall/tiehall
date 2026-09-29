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
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, packetOf, tokenOf } from "./support/requests.ts";

// The rows of the error model that REST reaches now (public-api: One error
// model for Tiehall's own refusals; public-api: Errors are RFC 9457 problem
// details), through the real route and execute(): both 404 rows, 400, 403 for
// a removed member, 409, 429 with Retry-After, 502 integration-unavailable and
// 503 setup-required, and 413 for a body over the size limit, through the real
// catalog. The 503 with
// Retry-After: 0 that a call gets while the app shuts down is the web role's,
// tested in apps/server, as are the web role's own 413 answers. Later tasks add
// a test for each row they make reachable.

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
  defineCommand({
    id: "probes.link",
    summary: "Link a probe request to a pull request, which GitHub fails to name.",
    input: z.object({ key: z.string(), pullRequest: z.string() }),
    output: z.object({}),
    method: "POST",
    path: "/api/v1/probes/{key}/links",
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
      "probes.link": async () => {
        throw new Refusal("integration-unavailable", "GitHub did not answer the read of the pull request within 10 seconds, so nothing changed.");
      },
    },
    store: { database: db, jobs: { send: async () => {} } },
  });
  rest = createRestHandler({ catalog, document: "{}\n", execute, authenticate: async () => agent, logger: createLogger({ write: () => {} }) });
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
    await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
    await addUser(owner, { userId: agent.userId });
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

  it("answers a caller who has been removed from the install with 403 removed-member", async () => {
    await owner.query("DELETE FROM members WHERE user_id = $1", [agent.userId]);
    try {
      const { status, problem } = await send("GET", "/api/v1/probes/FE-9999");
      expect(status).toBe(403);
      expect(problem).toMatchObject({ type: `${PROBLEM_TYPE_BASE}removed-member`, status: 403 });
    } finally {
      await owner.query("INSERT INTO members (org_id, user_id, role) SELECT id, $1, 'member' FROM orgs", [agent.userId]);
    }
  });

  // D50 (3): GitHub or the Jira site failing a call the action needs. No operation offered on REST asks GitHub
  // during the call yet; the probe refuses as one that does, such as linking a PR (16.8), will.
  it("answers GitHub or the Jira site failing the action with 502 integration-unavailable, and no Retry-After", async () => {
    const { status, retryAfter, problem } = await send("POST", "/api/v1/probes/FE-142/links", { pullRequest: "acme/web#7" });
    expect(status).toBe(502);
    expect(retryAfter).toBeNull();
    expect(problem).toEqual({
      type: `${PROBLEM_TYPE_BASE}integration-unavailable`,
      title: "Integration unavailable",
      status: 502,
      detail: "GitHub did not answer the read of the pull request within 10 seconds, so nothing changed.",
    });
  });

  it("answers an exceeded limit with 429 and Retry-After", async () => {
    const { status, retryAfter, problem } = await send("POST", "/api/v1/probes/FE-142/messages", { body: "Which endpoint?" });
    expect(status).toBe(429);
    expect(retryAfter).toBe("17");
    expect(problem).toMatchObject({ type: `${PROBLEM_TYPE_BASE}rate-limited`, status: 429, retryAfter: 17 });
  });
});

// public-api: Request bodies have a size limit. A body over 2 MiB is refused before it is parsed, so the
// operation does not run, whatever the body holds: this one would open a request if it were smaller.
describe("a body over the size limit", () => {
  let install: TestInstall;
  let alice: string;

  beforeAll(async () => {
    install = await startTestInstall();
    const be = await addTeam(install.owner, "BE");
    await addTeam(install.owner, "FE");
    alice = await addUser(install.owner, { login: "alice" });
    await joinTeams(install.owner, alice, be);
  });

  afterAll(async () => {
    await install.close();
  });

  it("answers a 3 MiB requests.create body with 413 payload-too-large, and creates nothing", async () => {
    const valid = JSON.stringify({ targetTeam: "FE", title: "Add a dark mode", packet: packetOf() });
    const body = valid.padEnd(3 * 1024 * 1024, " ");
    const count = async () =>
      (await install.owner.query("SELECT (SELECT count(*) FROM requests) AS requests, (SELECT count(*) FROM events) AS events")).rows[0];
    const before = await count();
    const response = await install.api(tokenOf(alice))(
      new Request(`${URL_OF_INSTALL}/api/v1/requests`, { method: "POST", headers: { "content-type": "application/json" }, body }),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}payload-too-large`,
      status: 413,
      detail: expect.stringContaining("2 MiB"),
    });
    expect(await count()).toEqual(before);
  });
});

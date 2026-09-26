import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createExecute,
  createLogger,
  createRestHandler,
  createWebCommands,
  migrate,
  openDatabase,
  type Caller,
  type Database,
  type Execute,
  type LogEntry,
  type WebSessionCaller,
} from "../src/index.ts";

// The web UI's authorization path (public-api: One definition per operation,
// the same on every surface; design.md, Technical decisions: T3). Server
// actions and server components run operations through execute(), in
// process, as the signed-in user's web session: the same parsing, the same
// rules for the caller and the same handler as every other surface, so a web
// session has no rights that the same user lacks over /api/v1, and a refusal
// carries the same RFC 9457 problem.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
/** The member of the team a request is addressed to, who may decline it. */
const TARGET_MEMBER = randomUUID();
/** A member of another team, who may not. */
const OTHER_MEMBER = randomUUID();

const catalog = defineCatalog([
  defineCommand({
    id: "probes.decline",
    summary: "Decline a request addressed to your team.",
    input: z.object({ key: z.string(), reason: z.string().min(1) }),
    output: z.object({ key: z.string(), state: z.literal("declined") }),
    method: "POST",
    path: "/api/v1/probes/{key}/decline",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp", "cli"],
    tool: "decline_probe",
    cliCommand: "decline",
    stability: "alpha",
  }),
]);

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let execute: Execute;
let logged: LogEntry[] = [];
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
  execute = createExecute({
    catalog,
    // The side rule a later task builds, as a fixture: only the target team's members may decline.
    handlers: {
      "probes.decline": async (input, { caller }) => {
        const { key } = input as { key: string };
        if (!("userId" in caller) || caller.userId !== TARGET_MEMBER) {
          throw new Refusal("forbidden", "Only the team the request is addressed to may decline it.");
        }
        return { key, state: "declined" };
      },
    },
    store: { database: db, jobs: { send: async () => {} } },
  });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

const session = (userId: string): WebSessionCaller => ({ kind: "web_session", userId, sessionId: randomUUID() });

function web(caller: WebSessionCaller | undefined) {
  return createWebCommands({ execute, session: async () => caller, logger: createLogger({ write: (line) => logged.push(JSON.parse(line) as LogEntry) }) });
}

/** The same user over /api/v1, with a personal access token. */
async function overRest(userId: string, body: unknown): Promise<Response> {
  const caller: Caller = { kind: "personal_access_token", userId, tokenId: randomUUID(), scopes: ["requests:write"], surface: "api" };
  const rest = createRestHandler({ catalog, document: "{}\n", execute, authenticate: async () => caller });
  return rest(
    new Request("https://tiehall.example.com/api/v1/probes/FE-142/decline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("a web session", () => {
  it("is refused an operation its user may not run exactly as the same user is over /api/v1, with 403", async () => {
    const rest = await overRest(OTHER_MEMBER, { reason: "Not ours" });
    expect(rest.status).toBe(403);
    expect(rest.headers.get("content-type")).toBe("application/problem+json");
    const restProblem = await rest.json();

    const result = await web(session(OTHER_MEMBER)).run("probes.decline", { key: "FE-142", reason: "Not ours" });
    expect(result).toEqual({ ok: false, problem: restProblem });
    expect(result).toMatchObject({ problem: { status: 403, type: "https://tiehall.com/problems/forbidden" } });
  });

  it("runs an operation its user may run, as the same user does over /api/v1", async () => {
    const rest = await overRest(TARGET_MEMBER, { reason: "We cannot take it this quarter" });
    expect(rest.status).toBe(200);
    const result = await web(session(TARGET_MEMBER)).run("probes.decline", { key: "FE-142", reason: "We cannot take it this quarter" });
    expect(result).toEqual({ ok: true, output: await rest.json() });
  });

  it("refuses input that fails the schema with the same 400 problem as /api/v1", async () => {
    const restProblem = await (await overRest(TARGET_MEMBER, { reason: "" })).json();
    expect(await web(session(TARGET_MEMBER)).run("probes.decline", { key: "FE-142", reason: "" })).toEqual({ ok: false, problem: restProblem });
  });

  it("runs nothing without a signed-in user, answering as /api/v1 does without credentials", async () => {
    const result = await web(undefined).run("probes.decline", { key: "FE-142", reason: "Not ours" });
    expect(result).toMatchObject({ ok: false, problem: { status: 401, type: "https://tiehall.com/problems/unauthenticated" } });
  });

  it("answers a failure that is not a refusal with a 500 problem that says nothing about it, and logs it without its message", async () => {
    logged = [];
    const failing = createWebCommands({
      execute: async () => {
        throw new Error("connection to postgres://tiehall_app:hunter2@db failed");
      },
      session: async () => session(TARGET_MEMBER),
      logger: createLogger({ write: (line) => logged.push(JSON.parse(line) as LogEntry) }),
    });
    const result = await failing.run("probes.decline", { key: "FE-142", reason: "x" });
    expect(result).toMatchObject({ ok: false, problem: { status: 500 } });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(logged).toEqual([expect.objectContaining({ level: "error", operationId: "probes.decline" })]);
    expect(JSON.stringify(logged)).not.toContain("hunter2");
  });
});

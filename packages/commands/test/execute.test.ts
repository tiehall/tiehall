import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { messagePosted, Refusal } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createExecute,
  createRestHandler,
  migrate,
  OutputSchemaError,
  openDatabase,
  type Caller,
  type Database,
  type Execute,
  type Handlers,
} from "../src/index.ts";

// execute() (public-api: Input and output follow the published schemas;
// agent-access: Six kinds of caller; design.md, Technical decisions: T3). Every
// operation, from every surface, runs through it: it parses the input against
// the operation's schema before anything runs, lets each of the six kinds of
// caller run only what its kind may run, asks for the confirmation step where
// the operation needs it, runs the handler inside withOrg(), and returns only
// output that passes the operation's output schema.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const BOB = randomUUID();
const PIA = randomUUID();

/** Operations of the kinds the real catalog holds, on a probe table. */
const catalog = defineCatalog([
  defineCommand({
    id: "probes.post",
    summary: "Post a message on a request.",
    input: z.object({ requestId: z.uuid(), body: z.string().min(1) }),
    output: z.object({ messageId: z.uuid() }),
    method: "POST",
    path: "/api/v1/probes/{requestId}/messages",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp"],
    tool: "post_probe",
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.misreport",
    summary: "Post a message and answer with an output its schema refuses.",
    input: z.object({ requestId: z.uuid() }),
    output: z.object({ messageId: z.uuid() }),
    method: "POST",
    path: "/api/v1/probes/{requestId}/misreport",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest"],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.note",
    summary: "An internal command: post a message as the web UI or the worker does.",
    input: z.object({ requestId: z.uuid(), body: z.string() }),
    output: z.object({ messageId: z.uuid() }),
    scopes: [],
    commitment: false,
    confirm: false,
    surfaces: [],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.report",
    summary: "File a report in one of two kinds, whose tool schema lowers the union to a kind enum.",
    input: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("bug"), requestId: z.uuid(), steps: z.array(z.string()) }),
      z.strictObject({ kind: z.literal("feature"), requestId: z.uuid(), goal: z.string() }),
    ]),
    output: z.object({ kind: z.string() }),
    method: "POST",
    path: "/api/v1/probes/{requestId}/reports",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp"],
    tool: "file_probe_report",
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.change_role",
    summary: "A command that needs the confirmation step.",
    input: z.object({ requestId: z.uuid(), body: z.string() }),
    output: z.object({ messageId: z.uuid() }),
    scopes: [],
    commitment: false,
    confirm: true,
    surfaces: [],
    stability: "alpha",
  }),
]);

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let execute: Execute;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

/** Posts a probe message and records its event, as post_message will. */
const postProbe: Handlers[string] = async (input, context) => {
  const { requestId, body } = input as { requestId: string; body: string };
  return context.write(async (writer) => {
    const { rows } = await writer.tx.execute<{ id: string }>(
      `INSERT INTO probe_messages (org_id, request_id, body) VALUES ('${writer.orgId}', '${requestId}', ${pg.escapeLiteral(body)})
       RETURNING id`,
    );
    const messageId = rows[0]?.id ?? "";
    await writer.record(messagePosted, { requestId, messageId });
    return { messageId };
  });
};

const handlers: Handlers = {
  "probes.post": postProbe,
  "probes.misreport": async (input, context) => {
    await postProbe({ ...(input as object), body: "posted before the output was refused" }, context);
    return { messageId: "not a uuid" };
  },
  "probes.note": postProbe,
  "probes.change_role": postProbe,
  "probes.report": async (input) => ({ kind: (input as { kind: string }).kind }),
};

const webSession: Caller = { kind: "web_session", userId: PIA, sessionId: randomUUID() };
const oauthToken: Caller = {
  kind: "oauth_token",
  userId: BOB,
  clientId: "https://client.example/metadata.json",
  scopes: ["requests:read", "requests:write"],
  surface: "mcp",
};
const personalAccessToken: Caller = {
  kind: "personal_access_token",
  userId: BOB,
  tokenId: randomUUID(),
  scopes: ["requests:read", "requests:write", "contracts:report"],
  surface: "api",
};
const ciCaller: Caller = { kind: "ci", repositoryId: "1296269" };
const systemJob: Caller = { kind: "system_job", job: "requests.close_on_merge" };
const integrationEvent: Caller = { kind: "integration_event", source: "github" };

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await owner.query(
    `CREATE TABLE probe_messages (
       org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), request_id uuid NOT NULL, body text NOT NULL,
       PRIMARY KEY (org_id, id))`,
  );
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  execute = createExecute({
    catalog,
    handlers,
    store: {
      database: db,
      jobs: {
        async send() {
          throw new Error("no probe command starts a job");
        },
      },
    },
  });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  // Events are append-only; the test container's superuser clears them with triggers off for its own transaction.
  await owner.query(
    `BEGIN; SET LOCAL session_replication_role = replica;
     DELETE FROM probe_messages; DELETE FROM events; DELETE FROM event_sequence; COMMIT`,
  );
});

async function counts(): Promise<{ messages: number; events: number }> {
  const { rows } = await owner.query<{ messages: number; events: number }>(
    "SELECT (SELECT count(*)::int FROM probe_messages) AS messages, (SELECT count(*)::int FROM events) AS events",
  );
  return rows[0] ?? { messages: -1, events: -1 };
}

/** The refusal a call gets, or a failure of the test when it gets none. */
async function refusalOf(call: Promise<unknown>): Promise<Refusal> {
  const outcome = await call.then(
    (output) => new Error(`the call was not refused; it answered ${JSON.stringify(output)}`),
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Refusal);
  return outcome as Refusal;
}

describe("execute", () => {
  it("runs an operation for a caller that may run it and returns its output", async () => {
    const requestId = randomUUID();
    const output = await execute("probes.post", personalAccessToken, { requestId, body: "Which endpoint?", extra: "dropped" });
    expect(output).toEqual({ messageId: expect.any(String) });
    expect(await counts()).toEqual({ messages: 1, events: 1 });
    const { rows } = await owner.query("SELECT actor_kind, actor_user_id, surface FROM events");
    expect(rows).toEqual([{ actor_kind: "agent", actor_user_id: BOB, surface: "api" }]);
  });

  it("refuses invalid input with 400 before anything runs: nothing changes and no event is appended", async () => {
    for (const caller of [webSession, oauthToken, personalAccessToken]) {
      const refusal = await refusalOf(execute("probes.post", caller, { requestId: "FE-142", body: 42 }));
      expect(refusal).toMatchObject({ status: 400, reason: "invalid-input" });
      expect(refusal.issues.map(({ path }) => path)).toEqual([["requestId"], ["body"]]);
      expect(JSON.stringify(refusal.issues)).not.toContain("FE-142");
    }
    await refusalOf(execute("probes.post", webSession, undefined));
    await refusalOf(execute("probes.post", webSession, { requestId: randomUUID(), body: "" }));
    expect(await counts()).toEqual({ messages: 0, events: 0 });
  });

  // agent-surfaces: Tool schemas that current clients accept. The tool's schema is a kind enum plus optional
  // fields, but execute() still validates with the zod union, whose variants are strict.
  it("refuses an input that mixes variants with 400, though the lowered tool schema would let it through", async () => {
    const requestId = randomUUID();
    expect(await execute("probes.report", oauthToken, { kind: "bug", requestId, steps: ["Open the page"] })).toEqual({ kind: "bug" });
    const refusal = await refusalOf(execute("probes.report", oauthToken, { kind: "bug", requestId, steps: ["Open the page"], goal: "Faster" }));
    expect(refusal).toMatchObject({ status: 400, reason: "invalid-input" });
    await refusalOf(execute("probes.report", oauthToken, { kind: "feature", requestId, steps: ["Open the page"] }));
    await refusalOf(execute("probes.report", oauthToken, { kind: "chore", requestId }));
    expect(await counts()).toEqual({ messages: 0, events: 0 });
  });

  // agent-surfaces: Tool schemas that current clients accept: "the same input sent to the tool's /api/v1 operation
  // gets HTTP 400, and nothing changes".
  it("refuses the same input that mixes variants with 400 on the tool's /api/v1 operation, and runs a valid one", async () => {
    const requestId = randomUUID();
    const rest = createRestHandler({ catalog, document: "{}", execute, authenticate: async () => oauthToken });
    const post = (body: unknown) =>
      rest(
        new Request(`https://tiehall.example.com/api/v1/probes/${requestId}/reports`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const valid = await post({ kind: "bug", steps: ["Open the page"] });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ kind: "bug" });
    const mixed = await post({ kind: "bug", steps: ["Open the page"], goal: "Faster" });
    expect(mixed.status).toBe(400);
    expect(mixed.headers.get("content-type")).toBe("application/problem+json");
    expect(await mixed.json()).toMatchObject({ status: 400 });
    expect((await post({ kind: "feature", steps: ["Open the page"] })).status).toBe(400);
    expect(await counts()).toEqual({ messages: 0, events: 0 });
  });

  it("never returns an output that fails its schema, and keeps nothing of the call", async () => {
    const failure = await execute("probes.misreport", webSession, { requestId: randomUUID() }).then(
      (output) => new Error(`the output was returned: ${JSON.stringify(output)}`),
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OutputSchemaError);
    expect(failure).not.toBeInstanceOf(Refusal);
    expect((failure as Error).message).not.toContain("not a uuid");
    expect(await counts()).toEqual({ messages: 0, events: 0 });
  });

  it("refuses an internal command to an OAuth token, a personal access token and a CI caller, as a path that is not there", async () => {
    for (const caller of [oauthToken, personalAccessToken, ciCaller]) {
      const refusal = await refusalOf(execute("probes.note", caller, { requestId: randomUUID(), body: "internal" }));
      expect(refusal, caller.kind).toMatchObject({ status: 404, reason: "route-not-found" });
    }
    expect(await counts()).toEqual({ messages: 0, events: 0 });
  });

  it("runs an internal command for a web session, a system job and an integration event", async () => {
    for (const caller of [webSession, systemJob, integrationEvent]) {
      await execute("probes.note", caller, { requestId: randomUUID(), body: "internal" });
    }
    const { rows } = await owner.query("SELECT actor_kind, actor_user_id, surface FROM events ORDER BY number");
    expect(rows).toEqual([
      { actor_kind: "web_session", actor_user_id: PIA, surface: "web" },
      { actor_kind: "system", actor_user_id: null, surface: null },
      { actor_kind: "integration", actor_user_id: null, surface: "github" },
    ]);
  });

  it("refuses a surface an operation is not offered on, even to a caller that may use that surface", async () => {
    const refusal = await refusalOf(execute("probes.misreport", oauthToken, { requestId: randomUUID() }));
    expect(refusal).toMatchObject({ status: 404, reason: "route-not-found" });
    expect(await counts()).toEqual({ messages: 0, events: 0 });
  });

  it("lets a CI caller run nothing but contract.report", async () => {
    const refusal = await refusalOf(execute("probes.post", ciCaller, { requestId: randomUUID(), body: "from CI" }));
    expect(refusal).toMatchObject({ status: 403, reason: "ci-caller-refused" });
    expect(await counts()).toEqual({ messages: 0, events: 0 });
  });

  it("never runs an operation offered on a surface for a system job or an integration event", async () => {
    for (const caller of [systemJob, integrationEvent]) {
      const refusal = await refusalOf(execute("probes.post", caller, { requestId: randomUUID(), body: "from the worker" }));
      expect(refusal, caller.kind).toMatchObject({ status: 403, reason: "forbidden" });
    }
    expect(await counts()).toEqual({ messages: 0, events: 0 });
  });

  it("refuses a confirm command without a confirmation nonce with 403", async () => {
    const input = { requestId: randomUUID(), body: "change Lee's role" };
    const refusal = await refusalOf(execute("probes.change_role", webSession, input));
    expect(refusal).toMatchObject({ status: 403, reason: "confirmation-required" });
    // Until the confirmation step checks nonces (task 8.2), no nonce is accepted.
    const withNonce = await refusalOf(execute("probes.change_role", webSession, input, { confirmation: { nonce: "a".repeat(43) } }));
    expect(withNonce).toMatchObject({ status: 403, reason: "confirmation-required" });
    expect(await counts()).toEqual({ messages: 0, events: 0 });
  });

  it("answers an id that names no operation as a path that is not there", async () => {
    const refusal = await refusalOf(execute("probes.missing", webSession, {}));
    expect(refusal).toMatchObject({ status: 404, reason: "route-not-found" });
  });

  it("needs a handler for every operation of its catalog, and no other", () => {
    const store = { database: db, jobs: { send: async () => {} } };
    expect(() => createExecute({ catalog, handlers: { ...handlers, "probes.note": undefined as never }, store })).toThrow(
      "probes.note has no handler.",
    );
    expect(() => createExecute({ catalog, handlers: { ...handlers, "probes.extra": postProbe }, store })).toThrow(
      "probes.extra is a handler for an operation the catalog does not hold.",
    );
  });
});

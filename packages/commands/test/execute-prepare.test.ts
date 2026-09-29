import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createConfirmationNonces,
  createExecute,
  definePreparedHandler,
  migrate,
  openDatabase,
  type Database,
  type Execute,
  type WebSessionCaller,
} from "../src/index.ts";
import { addUser } from "./support/members.ts";

// A handler's step before the call's transaction (execute.ts; design.md,
// Technical decisions: T3 and T16). A handler that must ask GitHub before it
// changes anything, such as creating an invite or uploading an App key, gives
// execute() a step that runs outside any transaction. execute() runs it only
// for a call it has authorized, its confirmation nonce checked but not yet
// used; then opens the call's transaction, authorizes the call again, uses
// the nonce and runs the handler with what the step returned. A step that
// fails leaves the nonce unused, so the same review page's form can be posted
// again.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const COMMAND = "probes.checked_change";

const checkedChange = defineCommand({
  id: COMMAND,
  summary: "A command that asks GitHub before it changes anything, with the confirmation step.",
  input: z.object({ login: z.string().min(1) }),
  output: z.object({ checked: z.string() }),
  scopes: [],
  commitment: false,
  confirm: true,
  surfaces: [],
  stability: "alpha",
});
const catalog = defineCatalog([checkedChange]);

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let execute: Execute;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
const nonces = createConfirmationNonces({ secret: randomBytes(32).toString("base64url") });
const pia: WebSessionCaller = { kind: "web_session", userId: randomUUID(), sessionId: randomUUID() };

/** What the step saw each time it ran, and whether it fails its next run. */
let steps: { login: string; openTransactions: number }[];
let failNext: boolean;

/** Sessions of the app role that are in a transaction now, apart from the one asking. */
async function openTransactions(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = $1 AND state LIKE 'idle in transaction%'",
    [appRole.name],
  );
  return rows[0]?.n ?? -1;
}

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
    handlers: {
      [COMMAND]: definePreparedHandler(
        checkedChange,
        async ({ login }, context) => {
          steps.push({ login, openTransactions: await openTransactions() });
          // The step may read, in a read-only transaction of its own.
          const org = await context.read(async ({ orgId }) => orgId);
          if (failNext) {
            failNext = false;
            throw new Error("GitHub did not answer");
          }
          return `${login} in ${org}`;
        },
        async (_input, context) => ({ checked: context.prepared }),
      ),
    },
    store: { database: db, jobs: { send: async () => {} } },
    confirmations: nonces,
  });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  await addUser(owner, { userId: pia.userId, role: "admin" });
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

beforeEach(() => {
  steps = [];
  failNext = false;
});

function run(input: unknown, nonce: string | undefined, caller: WebSessionCaller = pia): Promise<unknown> {
  return execute(COMMAND, caller, input, nonce === undefined ? {} : { confirmation: { nonce } });
}

describe("a handler's step before the call's transaction", () => {
  it("runs outside any transaction, once the call is authorized, and the handler gets what it returned", async () => {
    const input = { login: "omar" };
    const output = (await run(input, nonces.issue(pia, COMMAND, input))) as { checked: string };
    expect(output.checked).toMatch(/^omar in [0-9a-f-]{36}$/);
    expect(steps).toEqual([{ login: "omar", openTransactions: 0 }]);
  });

  it("does not run for a call without a valid confirmation, for a nonce used already, or for input that fails the schema", async () => {
    const input = { login: "lee" };
    await expect(run(input, undefined)).rejects.toMatchObject({ status: 403, reason: "confirmation-required" });
    await expect(run(input, nonces.issue(pia, COMMAND, { login: "someone else" }))).rejects.toMatchObject({ status: 403 });
    const nonce = nonces.issue(pia, COMMAND, input);
    await run(input, nonce);
    expect(steps).toHaveLength(1);
    await expect(run(input, nonce)).rejects.toMatchObject({ status: 403, reason: "confirmation-required" });
    await expect(run({ login: "" }, nonces.issue(pia, COMMAND, { login: "" }))).rejects.toMatchObject({ status: 400 });
    expect(steps).toHaveLength(1);
  });

  it("does not run for a user who is no longer a member", async () => {
    const removed: WebSessionCaller = { kind: "web_session", userId: await addUser(owner, { role: null }), sessionId: randomUUID() };
    const input = { login: "kim" };
    const refusal = await run(input, nonces.issue(removed, COMMAND, input), removed).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Refusal);
    expect(refusal).toMatchObject({ status: 403, reason: "removed-member" });
    expect(steps).toEqual([]);
  });

  it("that fails leaves the nonce unused, so the same nonce applies the action once the step succeeds", async () => {
    const input = { login: "sam" };
    const nonce = nonces.issue(pia, COMMAND, input);
    failNext = true;
    await expect(run(input, nonce)).rejects.toThrow("GitHub did not answer");
    expect(await run(input, nonce)).toMatchObject({ checked: expect.stringMatching(/^sam in /) });
    expect(steps).toHaveLength(2);
  });
});

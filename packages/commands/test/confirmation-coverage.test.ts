import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, defineCatalog, defineCommand, type Catalog } from "@tiehall/catalog";
import { messagePosted } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createConfirmationNonces,
  createConfirmationStep,
  createConfirmRoute,
  createExecute,
  csrfTokenFor,
  HANDLERS,
  migrate,
  openDatabase,
  REVIEWS,
  type Database,
  type Handlers,
  type Reviews,
  type WebSessionCaller,
} from "../src/index.ts";
import { addUser } from "./support/members.ts";

// The two cases of every action that needs the confirmation step (agent-safety:
// Actions that need the confirmation step; agent-safety: One confirmation
// approves one action). tools/repo-checks/confirmation-actions.json lists the
// actions; each one a task has built names its confirm command and an input,
// and `pnpm check:confirmations` fails a built action without them. Here each
// built action runs its two cases through the real catalog, handlers and
// review pages, as its form posts to /confirm/<command id> from the install's
// own origin with the session's CSRF token:
// - with the session and the CSRF token alone, it gets 403 and changes nothing;
// - with a nonce issued for another action, it gets 403 and changes nothing.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const LIST = new URL("../../../tools/repo-checks/confirmation-actions.json", import.meta.url);
const URL_OF_INSTALL = "https://tiehall.example.com";
const SECRET = randomBytes(32).toString("base64url");

interface BuiltAction {
  action: string;
  command: string;
  input: unknown;
}

/** The actions of the committed list that a task has built. */
function builtActions(): BuiltAction[] {
  const list = JSON.parse(readFileSync(LIST, "utf8")) as { items: { actions: Partial<BuiltAction>[] }[] };
  return list.items.flatMap(({ actions }) =>
    actions.flatMap((entry) => (typeof entry.command === "string" ? [{ action: entry.action ?? "", command: entry.command, input: entry.input }] : [])),
  );
}

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
const pia: WebSessionCaller = { kind: "web_session", userId: randomUUID(), sessionId: randomUUID() };

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await owner.query("CREATE TABLE probe_members (user_id uuid PRIMARY KEY, role text NOT NULL)");
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  await addUser(owner, { userId: pia.userId, role: "admin" });
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

/** A digest of every row of every table, to show that a refused confirmation changed nothing. */
async function everything(): Promise<Record<string, string>> {
  const { rows: tables } = await owner.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'");
  const digests: Record<string, string> = {};
  for (const { name } of tables) {
    const table = pg.escapeIdentifier(name);
    const { rows } = await owner.query<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS digest FROM ${table} t`,
    );
    digests[name] = rows[0]?.digest ?? "";
  }
  return digests;
}

interface CaseResult {
  status: number;
  type: unknown;
  changed: boolean;
}

/** Runs an action's two cases through the review page's form, and says what each got and whether it changed anything. */
async function twoCases(
  services: { catalog: Catalog; handlers: Handlers; reviews: Reviews },
  { command, input }: BuiltAction,
): Promise<{ sessionAndCsrfAlone: CaseResult; nonceForAnotherAction: CaseResult }> {
  const confirmations = createConfirmationNonces({ secret: SECRET });
  const store = { database: db, jobs: { send: async () => {} } };
  const execute = createExecute({ ...services, store, confirmations });
  const route = createConfirmRoute({
    step: createConfirmationStep({ catalog: services.catalog, reviews: services.reviews, store, confirmations }),
    session: async () => pia,
    write: { execute, url: URL_OF_INSTALL, secret: SECRET },
  });
  const post = async (fields: Record<string, string>): Promise<CaseResult> => {
    const before = await everything();
    const answer = await route(
      new Request(`${URL_OF_INSTALL}/confirm/${command}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ input: JSON.stringify(input), csrf: csrfTokenFor(SECRET, pia.sessionId), ...fields }).toString(),
      }),
    );
    const body = (await answer.text()).trim();
    const type = body.startsWith("{") ? (JSON.parse(body) as { type?: unknown }).type : undefined;
    return { status: answer.status, type, changed: JSON.stringify(await everything()) !== JSON.stringify(before) };
  };
  return {
    sessionAndCsrfAlone: await post({}),
    nonceForAnotherAction: await post({ nonce: confirmations.issue(pia, `${command}.another_action`, input) }),
  };
}

const refused = { status: 403, type: "https://tiehall.com/problems/confirmation-required", changed: false };

describe.each(builtActions())("the confirmation step of $action", (action) => {
  it(`refuses ${action.command} with 403, changing nothing, with the session and the CSRF token alone, and with a nonce for another action`, async () => {
    expect(await twoCases({ catalog: CATALOG, handlers: HANDLERS, reviews: REVIEWS }, action)).toEqual({
      sessionAndCsrfAlone: refused,
      nonceForAnotherAction: refused,
    });
  });
});

describe("the two cases", () => {
  const LEE = randomUUID();
  const catalog = defineCatalog([
    defineCommand({
      id: "probes.change_role",
      summary: "Change a member's role, with the confirmation step.",
      input: z.object({ userId: z.uuid(), role: z.enum(["admin", "member"]) }),
      output: z.object({}),
      scopes: [],
      commitment: false,
      confirm: true,
      surfaces: [],
      stability: "alpha",
    }),
    defineCommand({
      id: "probes.change_role_unguarded",
      summary: "Change a member's role without the confirmation step, as a mistake would.",
      input: z.object({ userId: z.uuid(), role: z.enum(["admin", "member"]) }),
      output: z.object({}),
      scopes: [],
      commitment: false,
      confirm: false,
      surfaces: [],
      stability: "alpha",
    }),
  ]);
  const changeRole: Handlers[string] = async (input, context) => {
    const { userId, role } = input as { userId: string; role: string };
    return context.write(async (writer) => {
      await writer.tx.execute(`INSERT INTO probe_members VALUES ('${userId}', '${role}')`);
      await writer.record(messagePosted, { requestId: userId, messageId: userId });
      return {};
    });
  };
  const services = {
    catalog,
    handlers: { "probes.change_role": changeRole, "probes.change_role_unguarded": changeRole },
    reviews: { "probes.change_role": async () => ({ title: "Change a role", lines: [] }) },
  };

  it("pass for an action that needs the confirmation step", async () => {
    expect(await twoCases(services, { action: "changing a member's role", command: "probes.change_role", input: { userId: LEE, role: "admin" } })).toEqual({
      sessionAndCsrfAlone: refused,
      nonceForAnotherAction: refused,
    });
  });

  it("fail for an action whose command does not need it, which has no review page to be confirmed from", async () => {
    const result = await twoCases(services, {
      action: "changing a member's role",
      command: "probes.change_role_unguarded",
      input: { userId: LEE, role: "admin" },
    });
    expect(result.sessionAndCsrfAlone).not.toEqual(refused);
  });
});

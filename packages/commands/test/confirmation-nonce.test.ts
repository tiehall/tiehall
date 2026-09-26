import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { messagePosted, Refusal } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  consumeForGatedRoute,
  createConfirmationNonces,
  createConfirmationStep,
  createConfirmRoute,
  createExecute,
  migrate,
  openDatabase,
  pruneUsedConfirmationNonces,
  WORKER_JOBS,
  type Database,
  type Execute,
  type Handlers,
  type WebSessionCaller,
} from "../src/index.ts";
import { addUser } from "./support/members.ts";

// The confirmation nonce (agent-safety: One confirmation approves one action;
// design.md, Technical decisions: T3 and T8; design.md, Self-hosting
// decisions: S7). Each review page carries a nonce of 32 random bytes, bound
// to the user, the session and a digest of the action and its exact input,
// which expires after 5 minutes. execute() checks and consumes it, in the
// call's transaction, before a command that needs the confirmation step runs,
// and the route guard does the same for a route of the sign-in service that
// the step gates. A nonce that is missing, used, expired, or bound to another
// user, session or input gets 403 and changes nothing; one confirmation
// approves exactly one action.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const SECRET = randomBytes(32).toString("base64url");
const LEE = randomUUID();
const KIM = randomUUID();

const catalog = defineCatalog([
  defineCommand({
    id: "probes.change_role",
    summary: "Change a member's role.",
    input: z.object({ userId: z.uuid(), role: z.enum(["admin", "member"]) }),
    output: z.object({ userId: z.uuid(), role: z.string() }),
    scopes: [],
    commitment: false,
    confirm: true,
    surfaces: [],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.remove_member",
    summary: "Remove a member.",
    input: z.object({ userId: z.uuid() }),
    output: z.object({ userId: z.uuid() }),
    scopes: [],
    commitment: false,
    confirm: true,
    surfaces: [],
    stability: "alpha",
  }),
]);

/** Each fixture action changes a probe member and records its event, as a real action will. */
const handlers: Handlers = {
  "probes.change_role": async (input, context) => {
    const { userId, role } = input as { userId: string; role: string };
    return context.write(async (writer) => {
      const { rowCount } = await writer.tx.execute(`UPDATE probe_members SET role = '${role}' WHERE user_id = '${userId}'`);
      if (rowCount === 0) throw new Refusal("record-not-found", "No such member.");
      await writer.record(messagePosted, { requestId: userId, messageId: userId });
      return { userId, role };
    });
  },
  "probes.remove_member": async (input, context) => {
    const { userId } = input as { userId: string };
    return context.write(async (writer) => {
      await writer.tx.execute(`DELETE FROM probe_members WHERE user_id = '${userId}'`);
      await writer.record(messagePosted, { requestId: userId, messageId: userId });
      return { userId };
    });
  },
};

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let clock = new Date("2026-09-26T10:00:00Z");
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
const nonces = createConfirmationNonces({ secret: SECRET, now: () => clock });
let execute: Execute;

const pia: WebSessionCaller = { kind: "web_session", userId: randomUUID(), sessionId: randomUUID() };
const piaElsewhere: WebSessionCaller = { ...pia, sessionId: randomUUID() };
const dana: WebSessionCaller = { kind: "web_session", userId: randomUUID(), sessionId: randomUUID() };

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
  await addUser(owner, { userId: dana.userId });
  await owner.query("INSERT INTO probe_members VALUES ($1, 'member'), ($2, 'member')", [LEE, KIM]);
  execute = createExecute({ catalog, handlers, store: { database: db, jobs: { send: async () => {} } }, confirmations: nonces });
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  clock = new Date("2026-09-26T10:00:00Z");
  await owner.query(
    `BEGIN; SET LOCAL session_replication_role = replica;
     DELETE FROM probe_members; DELETE FROM used_confirmation_nonces; DELETE FROM events; DELETE FROM event_sequence; COMMIT`,
  );
  await owner.query("INSERT INTO probe_members VALUES ($1, 'member'), ($2, 'member')", [LEE, KIM]);
});

async function members(): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ user_id: string; role: string }>("SELECT user_id, role FROM probe_members");
  return Object.fromEntries(rows.map(({ user_id, role }) => [user_id, role]));
}

async function eventCount(): Promise<number> {
  return (await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM events")).rows[0]?.n ?? 0;
}

/** Applies an action with a nonce, as the review page's form does. */
function confirmWith(nonce: string, caller: WebSessionCaller, commandId: string, input: unknown) {
  return execute(commandId, caller, input, { confirmation: { nonce } });
}

const forbidden = { status: 403, reason: "confirmation-required" };

describe("a confirmation nonce", () => {
  it("applies the action it was issued for, once", async () => {
    const nonce = nonces.issue(pia, "probes.change_role", { userId: LEE, role: "admin" });
    expect(await confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "admin" })).toEqual({ userId: LEE, role: "admin" });
    expect((await members())[LEE]).toBe("admin");
    expect(await eventCount()).toBe(1);
  });

  it("is refused with 403 once it has been used, and the second call changes nothing", async () => {
    const nonce = nonces.issue(pia, "probes.change_role", { userId: LEE, role: "admin" });
    await confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "admin" });
    await owner.query("UPDATE probe_members SET role = 'member'");
    await expect(confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "admin" })).rejects.toMatchObject(forbidden);
    expect((await members())[LEE]).toBe("member");
    expect(await eventCount()).toBe(1);
  });

  it("is refused with 403 when it arrives after it expired, 5 minutes after it was issued", async () => {
    const nonce = nonces.issue(pia, "probes.change_role", { userId: LEE, role: "admin" });
    clock = new Date(clock.getTime() + 6 * 60 * 1000);
    await expect(confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "admin" })).rejects.toMatchObject(forbidden);
    expect((await members())[LEE]).toBe("member");
    expect(await eventCount()).toBe(0);
  });

  it("is refused with 403 from another session of the same user, or from another user", async () => {
    const nonce = nonces.issue(pia, "probes.change_role", { userId: LEE, role: "admin" });
    await expect(confirmWith(nonce, piaElsewhere, "probes.change_role", { userId: LEE, role: "admin" })).rejects.toMatchObject(forbidden);
    await expect(confirmWith(nonce, dana, "probes.change_role", { userId: LEE, role: "admin" })).rejects.toMatchObject(forbidden);
    expect((await members())[LEE]).toBe("member");
    expect(await eventCount()).toBe(0);
    // Neither refusal used it up: the session it was issued to can still confirm.
    await confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "admin" });
    expect((await members())[LEE]).toBe("admin");
  });

  it("is refused with 403 for the same action with different input", async () => {
    const nonce = nonces.issue(pia, "probes.change_role", { userId: LEE, role: "member" });
    await expect(confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "admin" })).rejects.toMatchObject(forbidden);
    await expect(confirmWith(nonce, pia, "probes.change_role", { userId: KIM, role: "member" })).rejects.toMatchObject(forbidden);
    expect(await members()).toEqual({ [LEE]: "member", [KIM]: "member" });
    expect(await eventCount()).toBe(0);
  });

  it("approves one action: a second action needs a second confirmation", async () => {
    const nonce = nonces.issue(pia, "probes.change_role", { userId: LEE, role: "admin" });
    await confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "admin" });
    await expect(confirmWith(nonce, pia, "probes.remove_member", { userId: KIM })).rejects.toMatchObject(forbidden);
    expect(Object.keys(await members())).toContain(KIM);
    const second = nonces.issue(pia, "probes.remove_member", { userId: KIM });
    await confirmWith(second, pia, "probes.remove_member", { userId: KIM });
    expect(Object.keys(await members())).not.toContain(KIM);
  });

  it("is refused with 403 when it is missing or is not a nonce at all", async () => {
    await expect(execute("probes.change_role", pia, { userId: LEE, role: "admin" })).rejects.toMatchObject(forbidden);
    await expect(confirmWith("not-a-nonce", pia, "probes.change_role", { userId: LEE, role: "admin" })).rejects.toMatchObject(forbidden);
    expect(await eventCount()).toBe(0);
  });

  it("stays unused when the action it approves is refused, since nothing happened", async () => {
    const ghost = randomUUID();
    const nonce = nonces.issue(pia, "probes.change_role", { userId: ghost, role: "admin" });
    await expect(confirmWith(nonce, pia, "probes.change_role", { userId: ghost, role: "admin" })).rejects.toMatchObject({ status: 404 });
    expect((await owner.query("SELECT count(*)::int AS n FROM used_confirmation_nonces")).rows).toEqual([{ n: 0 }]);
  });

  it("is kept as used only by a hash, with the time it expires", async () => {
    const nonce = nonces.issue(pia, "probes.change_role", { userId: LEE, role: "admin" });
    await confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "admin" });
    const { rows } = await owner.query<{ nonce_hash: Buffer; expires_at: Date }>("SELECT nonce_hash, expires_at FROM used_confirmation_nonces");
    expect(rows).toEqual([{ nonce_hash: expect.any(Buffer), expires_at: new Date(clock.getTime() + 300_000) }]);
    expect(rows[0]?.nonce_hash.byteLength).toBe(32);
    const [random = ""] = nonce.split(".");
    expect(rows[0]?.nonce_hash.equals(Buffer.from(random, "base64url"))).toBe(false);
  });
});

describe("the review page's nonce", () => {
  it("is bound to the reviewed action, its exact input and the reviewing session", async () => {
    const step = createConfirmationStep({
      catalog,
      reviews: {
        "probes.change_role": async () => ({ title: "Change a role", lines: [] }),
        "probes.remove_member": async () => ({ title: "Remove a member", lines: [] }),
      },
      store: { database: db },
      confirmations: nonces,
    });
    const route = createConfirmRoute({ step, session: async () => pia, write: { execute, url: "https://tiehall.example.com", secret: SECRET } });
    const input = JSON.stringify({ role: "admin", userId: LEE, ignored: "dropped by the schema" });
    const html = await (await route(new Request(`https://tiehall.example.com/confirm/probes.change_role?input=${encodeURIComponent(input)}`))).text();
    const nonce = /<input type="hidden" name="nonce" value="([^"]+)">/.exec(html)?.[1] ?? "";
    expect(nonce).not.toBe("");
    await expect(confirmWith(nonce, piaElsewhere, "probes.change_role", { userId: LEE, role: "admin" })).rejects.toMatchObject(forbidden);
    await expect(confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "member" })).rejects.toMatchObject(forbidden);
    expect(await confirmWith(nonce, pia, "probes.change_role", { userId: LEE, role: "admin" })).toEqual({ userId: LEE, role: "admin" });
    // Opening the page stored nothing; only the confirmation recorded the nonce as used.
    expect((await owner.query("SELECT count(*)::int AS n FROM used_confirmation_nonces")).rows).toEqual([{ n: 1 }]);
  });
});

describe("the route guard of a gated route", () => {
  /** A route of the sign-in service that the confirmation step gates, such as the consent approval. */
  async function approveClient(caller: WebSessionCaller, clientId: string, nonce: string): Promise<number> {
    const allowed = await consumeForGatedRoute(db, nonces, { caller, action: "oauth.approve_client", input: { clientId }, nonce });
    return allowed ? 200 : 403;
  }

  it("lets the route run once for the action its nonce was issued for, and refuses it with 403 otherwise", async () => {
    const nonce = nonces.issue(pia, "oauth.approve_client", { clientId: "https://client.example/metadata.json" });
    expect(await approveClient(pia, "https://evil.example/metadata.json", nonce)).toBe(403);
    expect(await approveClient(piaElsewhere, "https://client.example/metadata.json", nonce)).toBe(403);
    expect(await approveClient(pia, "https://client.example/metadata.json", nonce)).toBe(200);
    expect(await approveClient(pia, "https://client.example/metadata.json", nonce)).toBe(403);
    // A nonce for a gated route approves no command, and a command's nonce no gated route.
    const commandNonce = nonces.issue(pia, "probes.remove_member", { userId: KIM });
    expect(await approveClient(pia, "https://client.example/metadata.json", commandNonce)).toBe(403);
  });

  it("refuses an expired nonce with 403", async () => {
    const nonce = nonces.issue(pia, "oauth.approve_client", { clientId: "https://client.example/metadata.json" });
    clock = new Date(clock.getTime() + 5 * 60 * 1000);
    expect(await approveClient(pia, "https://client.example/metadata.json", nonce)).toBe(403);
  });
});

describe("the hourly purge of used nonces", () => {
  it("deletes the record of a used nonce once its nonce expired a nonce's lifetime ago, and keeps the others", async () => {
    // The first expires at 10:05, the second at 10:09; at 10:11 only the first expired more than 5 minutes ago.
    await confirmWith(nonces.issue(pia, "probes.change_role", { userId: LEE, role: "admin" }), pia, "probes.change_role", { userId: LEE, role: "admin" });
    clock = new Date(clock.getTime() + 4 * 60 * 1000);
    await confirmWith(nonces.issue(pia, "probes.remove_member", { userId: KIM }), pia, "probes.remove_member", { userId: KIM });
    clock = new Date(clock.getTime() + 7 * 60 * 1000);
    const signal = new AbortController().signal;
    await pruneUsedConfirmationNonces.handle(
      { id: randomUUID(), queue: pruneUsedConfirmationNonces.type.queue, data: {}, signal },
      { database: db, now: () => clock },
    );
    expect((await owner.query("SELECT count(*)::int AS n FROM used_confirmation_nonces")).rows).toEqual([{ n: 1 }]);
    expect(WORKER_JOBS).toContain(pruneUsedConfirmationNonces);
  });
});

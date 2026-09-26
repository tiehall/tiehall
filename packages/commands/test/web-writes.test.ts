import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { messagePosted } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createConfirmationNonces,
  createConfirmationStep,
  createConfirmRoute,
  createExecute,
  createWebCommands,
  csrfTokenFor,
  migrate,
  openDatabase,
  type Database,
  type Execute,
  type Handlers,
  type WebSessionCaller,
  type WebWriteRequest,
} from "../src/index.ts";
import { addUser } from "./support/members.ts";

// Every web UI write passes three checks (agent-safety: One confirmation
// approves one action; agent-safety: Actions that need the confirmation step;
// design.md, Self-hosting decisions: S7): a CSRF token bound to the user's web
// session, an Origin equal to TIEHALL_URL and Sec-Fetch-Site: same-origin. A
// write that fails any of them gets 403 and changes nothing, rejections
// included. A confirmation must pass them as well as carry its nonce, so a
// session and a CSRF token alone never apply an action that needs the
// confirmation step.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const URL_OF_INSTALL = "https://tiehall.example.com";
const SECRET = randomBytes(32).toString("base64url");
const LEE = randomUUID();

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
    id: "probes.reject_proposal",
    summary: "Reject a proposal, which needs no confirmation step.",
    input: z.object({ proposalId: z.uuid() }),
    output: z.object({ proposalId: z.uuid(), state: z.literal("rejected") }),
    scopes: [],
    commitment: false,
    confirm: false,
    surfaces: [],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.count_members",
    summary: "A read, as a server component runs one.",
    input: z.object({}),
    output: z.object({ members: z.number() }),
    scopes: [],
    commitment: false,
    confirm: false,
    surfaces: [],
    stability: "alpha",
  }),
]);

const handlers: Handlers = {
  "probes.change_role": async (input, context) => {
    const { userId, role } = input as { userId: string; role: string };
    return context.write(async (writer) => {
      await writer.tx.execute(`UPDATE probe_members SET role = '${role}' WHERE user_id = '${userId}'`);
      await writer.record(messagePosted, { requestId: userId, messageId: userId });
      return { userId, role };
    });
  },
  "probes.reject_proposal": async (input, context) => {
    const { proposalId } = input as { proposalId: string };
    return context.write(async (writer) => {
      await writer.tx.execute(`UPDATE probe_proposals SET state = 'rejected' WHERE id = '${proposalId}'`);
      await writer.record(messagePosted, { requestId: proposalId, messageId: proposalId });
      return { proposalId, state: "rejected" as const };
    });
  },
  "probes.count_members": async (_input, { tx }) => {
    const { rows } = await tx.execute<{ n: number }>("SELECT count(*)::int AS n FROM probe_members");
    return { members: rows[0]?.n ?? 0 };
  },
};

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let execute: Execute;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
const nonces = createConfirmationNonces({ secret: SECRET });
const pia: WebSessionCaller = { kind: "web_session", userId: randomUUID(), sessionId: randomUUID() };
const PROPOSAL = randomUUID();

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await owner.query("CREATE TABLE probe_members (user_id uuid PRIMARY KEY, role text NOT NULL)");
  await owner.query("CREATE TABLE probe_proposals (id uuid PRIMARY KEY, state text NOT NULL)");
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  await addUser(owner, { userId: pia.userId, role: "admin" });
  execute = createExecute({ catalog, handlers, store: { database: db, jobs: { send: async () => {} } }, confirmations: nonces });
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  await owner.query(
    `BEGIN; SET LOCAL session_replication_role = replica;
     DELETE FROM probe_members; DELETE FROM probe_proposals; DELETE FROM used_confirmation_nonces;
     DELETE FROM events; DELETE FROM event_sequence; COMMIT`,
  );
});

async function arrange(): Promise<void> {
  await owner.query("INSERT INTO probe_members VALUES ($1, 'member')", [LEE]);
  await owner.query("INSERT INTO probe_proposals VALUES ($1, 'pending')", [PROPOSAL]);
}

/** Lee's role, the proposal's state and the number of events: what a refused write must leave as it was. */
async function state(): Promise<{ role: string | undefined; proposal: string | undefined; events: number }> {
  const role = (await owner.query<{ role: string }>("SELECT role FROM probe_members WHERE user_id = $1", [LEE])).rows[0]?.role;
  const proposal = (await owner.query<{ state: string }>("SELECT state FROM probe_proposals WHERE id = $1", [PROPOSAL])).rows[0]?.state;
  const events = (await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM events")).rows[0]?.n ?? 0;
  return { role, proposal, events };
}

const unchanged = { role: "member", proposal: "pending", events: 0 };

const route = () =>
  createConfirmRoute({
    step: createConfirmationStep({
      catalog,
      reviews: { "probes.change_role": async () => ({ title: "Change a role", lines: [] }) },
      store: { database: db },
      confirmations: nonces,
    }),
    session: async () => pia,
    write: { execute, url: URL_OF_INSTALL, secret: SECRET },
  });

/** The headers a browser sends with a form posted from a page of the install. */
const sameOrigin = { origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" };

/** Posts the review page's form, as the browser does when the person presses Confirm. */
function confirm(fields: Record<string, string>, headers: Record<string, string> = sameOrigin): Promise<Response> {
  return route()(
    new Request(`${URL_OF_INSTALL}/confirm/probes.change_role`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

const input = JSON.stringify({ role: "admin", userId: LEE });
const csrf = () => csrfTokenFor(SECRET, pia.sessionId);
const nonce = () => nonces.issue(pia, "probes.change_role", { userId: LEE, role: "admin" });

describe("a confirmation posted from the review page", () => {
  it("applies the action with its nonce, the CSRF token, the install's Origin and Sec-Fetch-Site: same-origin", async () => {
    await arrange();
    const answer = await confirm({ input, nonce: nonce(), csrf: csrf() });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await state()).toEqual({ role: "admin", proposal: "pending", events: 1 });
  });

  it.each([
    ["an attacker's Origin", { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }],
    ["an attacker's Origin that claims same-origin", { origin: "https://attacker.example", "sec-fetch-site": "same-origin" }],
    ["the install's Origin over http", { origin: "http://tiehall.example.com", "sec-fetch-site": "same-origin" }],
    ["Sec-Fetch-Site: cross-site", { origin: URL_OF_INSTALL, "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site: same-site", { origin: URL_OF_INSTALL, "sec-fetch-site": "same-site" }],
    ["no Origin", { "sec-fetch-site": "same-origin" }],
    ["no Sec-Fetch-Site", { origin: URL_OF_INSTALL }],
  ])("is refused with 403 from %s, with a valid nonce, and changes nothing", async (_from, headers: Record<string, string>) => {
    await arrange();
    const valid = nonce();
    const answer = await confirm({ input, nonce: valid, csrf: csrf() }, headers);
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/confirmation-required", status: 403 });
    expect(await state()).toEqual(unchanged);
    // The refused request did not use the nonce up.
    expect((await confirm({ input, nonce: valid, csrf: csrf() })).status).toBe(200);
  });

  it("is refused with 403 without the CSRF token, or with another session's, and changes nothing", async () => {
    await arrange();
    for (const token of ["", csrfTokenFor(SECRET, randomUUID()), csrfTokenFor(randomBytes(32).toString("base64url"), pia.sessionId)]) {
      const answer = await confirm({ input, nonce: nonce(), ...(token === "" ? {} : { csrf: token }) });
      expect(answer.status).toBe(403);
    }
    expect(await state()).toEqual(unchanged);
  });

  it("is refused with 403 when it carries only the session and the CSRF token, from the install's own origin, and changes nothing", async () => {
    await arrange();
    const answer = await confirm({ input, csrf: csrf() });
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/confirmation-required" });
    expect(await state()).toEqual(unchanged);
  });

  it("answers 401 without a signed-in user, and 400 for input that is not JSON", async () => {
    await arrange();
    const signedOut = createConfirmRoute({
      step: createConfirmationStep({ catalog, reviews: { "probes.change_role": async () => ({ title: "x", lines: [] }) }, store: { database: db }, confirmations: nonces }),
      session: async () => undefined,
      write: { execute, url: URL_OF_INSTALL, secret: SECRET },
    });
    const answer = await signedOut(
      new Request(`${URL_OF_INSTALL}/confirm/probes.change_role`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...sameOrigin },
        body: new URLSearchParams({ input, nonce: nonce(), csrf: csrf() }).toString(),
      }),
    );
    expect(answer.status).toBe(401);
    expect((await confirm({ input: "{not json", nonce: nonce(), csrf: csrf() })).status).toBe(400);
    expect(await state()).toEqual(unchanged);
  });
});

/** The web UI's path for server actions and server components, as Pia's web session. */
const webAsPia = () => createWebCommands({ execute, session: async () => pia, url: URL_OF_INSTALL, secret: () => SECRET });

describe("a write from a server action", () => {
  const request = (change: Partial<WebWriteRequest> = {}): WebWriteRequest => ({
    origin: URL_OF_INSTALL,
    fetchSite: "same-origin",
    csrfToken: csrfTokenFor(SECRET, pia.sessionId),
    ...change,
  });

  it("runs with the CSRF token, the install's Origin and Sec-Fetch-Site: same-origin, a rejection among them", async () => {
    await arrange();
    const result = await webAsPia().write("probes.reject_proposal", { proposalId: PROPOSAL }, request());
    expect(result).toEqual({ ok: true, output: { proposalId: PROPOSAL, state: "rejected" } });
    expect(await state()).toEqual({ role: "member", proposal: "rejected", events: 1 });
  });

  it.each([
    ["another Origin", { origin: "https://attacker.example" }],
    ["no Origin", { origin: null }],
    ["Sec-Fetch-Site: cross-site", { fetchSite: "cross-site" }],
    ["no Sec-Fetch-Site", { fetchSite: null }],
    ["no CSRF token", { csrfToken: null }],
    ["another session's CSRF token", { csrfToken: csrfTokenFor(SECRET, randomUUID()) }],
  ])("is refused with 403 with %s, and changes nothing, rejections included", async (_what, change: Partial<WebWriteRequest>) => {
    await arrange();
    const result = await webAsPia().write("probes.reject_proposal", { proposalId: PROPOSAL }, request(change));
    expect(result).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/forbidden" } });
    expect(await state()).toEqual(unchanged);
  });

  it("is refused with 403 for an action that needs the confirmation step, with the session and the CSRF token alone", async () => {
    await arrange();
    const result = await webAsPia().write("probes.change_role", { userId: LEE, role: "admin" }, request());
    expect(result).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/confirmation-required" } });
    expect(await state()).toEqual(unchanged);
  });
});

describe("a read from a server component", () => {
  it("runs without a CSRF token, for a page's GET", async () => {
    await arrange();
    expect(await webAsPia().read("probes.count_members", {})).toEqual({ ok: true, output: { members: 1 } });
  });

  it("runs in a read-only transaction, so it can never write, whatever operation it names", async () => {
    await arrange();
    const result = await webAsPia().read("probes.reject_proposal", { proposalId: PROPOSAL });
    expect(result).toMatchObject({ ok: false, problem: { status: 500 } });
    expect(await state()).toEqual(unchanged);
  });
});

describe("a CSRF token", () => {
  it("is bound to the web session and the install's secret", () => {
    const token = csrfTokenFor(SECRET, pia.sessionId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfTokenFor(SECRET, pia.sessionId)).toBe(token);
    expect(csrfTokenFor(SECRET, randomUUID())).not.toBe(token);
    expect(csrfTokenFor(randomBytes(32).toString("base64url"), pia.sessionId)).not.toBe(token);
  });
});

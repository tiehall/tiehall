import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  consumeForGatedRoute,
  createConfirmationNonces,
  createConfirmationStep,
  createConfirmRoute,
  createExecute,
  createLogger,
  createRestHandler,
  csrfTokenFor,
  migrate,
  openDatabase,
  withOrg,
  type Caller,
  type Database,
  type Execute,
  type WebSessionCaller,
} from "../src/index.ts";
import { addUser } from "./support/members.ts";

// Membership is re-checked on every call (teams-and-roles: Membership is
// re-checked on every call; public-api: One error model for Tiehall's own
// refusals; design.md, Design rules: Teams and roles; design.md, Technical
// decisions: T3). withOrg() re-checks, at the time of every call made for a
// user, through a web session, an OAuth token or a personal access token,
// that the user is still a member of the install, before any record is looked
// up. A removed member's next call gets 403 removed-member and no data, so it
// never learns whether a record exists: a missing record and an existing one
// look the same.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const INSTALL = "https://tiehall.example.com";

const catalog = defineCatalog([
  defineCommand({
    id: "probes.get_note",
    summary: "Read a note by its id.",
    input: z.object({ noteId: z.uuid() }),
    output: z.object({ body: z.string() }),
    method: "GET",
    path: "/api/v1/notes/{noteId}",
    scopes: ["requests:read"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp"],
    tool: "get_note",
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.revise_note",
    summary: "Revise a note, at the revision the writer read.",
    input: z.object({ noteId: z.uuid(), body: z.string(), expectedRevision: z.number().int().min(1).optional() }),
    output: z.object({ body: z.string() }),
    method: "POST",
    path: "/api/v1/notes/{noteId}/revisions",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest"],
    ifMatch: "expectedRevision",
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.change_role",
    summary: "An admin action that needs the confirmation step.",
    input: z.object({ userId: z.uuid() }),
    output: z.object({}),
    scopes: [],
    commitment: false,
    confirm: true,
    admin: "members",
    surfaces: [],
    stability: "alpha",
  }),
]);
const SECRET = randomBytes(32).toString("base64url");

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let execute: Execute;
let lookups = 0;
let noteId: string;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await owner.query(
    "CREATE TABLE probe_notes (org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), body text NOT NULL, PRIMARY KEY (org_id, id))",
  );
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  noteId = (await owner.query<{ id: string }>("INSERT INTO probe_notes (org_id, body) SELECT id, 'The launch plan' FROM orgs RETURNING id"))
    .rows[0]?.id ?? "";
  execute = createExecute({
    catalog,
    handlers: {
      "probes.get_note": async (input, { tx, orgId }) => {
        lookups += 1;
        const { rows } = await tx.execute<{ body: string }>(
          `SELECT body FROM probe_notes WHERE org_id = '${orgId}' AND id = '${(input as { noteId: string }).noteId}'`,
        );
        const note = rows[0];
        if (note === undefined) throw new Refusal("record-not-found", "There is no such note.");
        return { body: note.body };
      },
      "probes.revise_note": async (input) => {
        lookups += 1;
        return { body: (input as { body: string }).body };
      },
      "probes.change_role": async () => ({}),
    },
    store: { database: db, jobs: { send: async () => {} } },
  });
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

/** A web session, an OAuth token and a personal access token that act for the user. */
function callersFor(userId: string): Caller[] {
  return [
    { kind: "web_session", userId, sessionId: randomUUID() },
    { kind: "oauth_token", userId, clientId: "https://client.example/metadata.json", scopes: ["requests:read"], surface: "mcp" },
    { kind: "personal_access_token", userId, tokenId: randomUUID(), scopes: ["requests:read"], surface: "api" },
  ];
}

async function removeMember(userId: string): Promise<void> {
  await owner.query("DELETE FROM members WHERE user_id = $1", [userId]);
}

describe("withOrg() for a call made for a user", () => {
  it("hands the call the user's membership, read at the time of the call", async () => {
    const lee = await addUser(owner, { role: "member" });
    expect(await withOrg(db, async ({ member }) => member, { forUser: lee })).toEqual({ userId: lee, role: "member" });
    await owner.query("UPDATE members SET role = 'admin' WHERE user_id = $1", [lee]);
    expect(await withOrg(db, async ({ member }) => member, { forUser: lee })).toEqual({ userId: lee, role: "admin" });
  });

  it("refuses a user who is no longer a member with 403 removed-member, before the handler runs", async () => {
    const lee = await addUser(owner, { role: "member" });
    await removeMember(lee);
    let ran = false;
    await expect(
      withOrg(
        db,
        async () => {
          ran = true;
        },
        { forUser: lee },
      ),
    ).rejects.toMatchObject({ status: 403, type: "https://tiehall.com/problems/removed-member" });
    expect(ran).toBe(false);
  });

  it("checks no membership for a call made for no user, such as a job's", async () => {
    expect(await withOrg(db, async ({ member }) => member)).toBeUndefined();
  });
});

describe("a removed member's next call", () => {
  it("through a web session, an OAuth token or a personal access token gets 403 and no data", async () => {
    const dana = await addUser(owner, { role: "member" });
    const callers = callersFor(dana);
    for (const caller of callers) await expect(execute("probes.get_note", caller, { noteId })).resolves.toEqual({ body: "The launch plan" });

    await removeMember(dana);
    lookups = 0;
    for (const caller of callers) {
      await expect(execute("probes.get_note", caller, { noteId }), caller.kind).rejects.toMatchObject({
        status: 403,
        type: "https://tiehall.com/problems/removed-member",
      });
    }
    expect(lookups).toBe(0);
  });

  it("gets the same 403 for a record that exists and one that does not, before either is looked up", async () => {
    const dana = await addUser(owner, { role: "member" });
    await removeMember(dana);
    const caller: Caller = { kind: "personal_access_token", userId: dana, tokenId: randomUUID(), scopes: ["requests:read"], surface: "api" };
    const rest = createRestHandler({ catalog, document: "{}\n", execute, authenticate: async () => caller, logger: createLogger({ write: () => {} }) });
    lookups = 0;
    const answers = [];
    for (const id of [noteId, randomUUID()]) {
      const response = await rest(new Request(`${INSTALL}/api/v1/notes/${id}`));
      answers.push({ status: response.status, type: response.headers.get("content-type"), body: await response.text() });
    }
    expect(lookups).toBe(0);
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]?.status).toBe(403);
    expect(answers[0]?.type).toBe("application/problem+json");
    expect(JSON.parse(answers[0]?.body ?? "{}")).toMatchObject({ type: "https://tiehall.com/problems/removed-member", status: 403 });
    expect(answers[0]?.body).not.toContain("launch plan");
  });

  it("gets 403, not 400, for input that fails the operation's schema, through every caller, before anything is looked up", async () => {
    const dana = await addUser(owner, { role: "member" });
    const callers = callersFor(dana);
    for (const caller of callers) {
      await expect(execute("probes.get_note", caller, { noteId: "not-an-id" }), caller.kind).rejects.toMatchObject({
        status: 400,
        type: "https://tiehall.com/problems/invalid-input",
      });
    }

    await removeMember(dana);
    lookups = 0;
    for (const caller of callers) {
      await expect(execute("probes.get_note", caller, { noteId: "not-an-id" }), caller.kind).rejects.toMatchObject({
        status: 403,
        type: "https://tiehall.com/problems/removed-member",
      });
    }
    expect(lookups).toBe(0);
  });

  it("gets 403, not the confirmation step's refusal, for an action that needs a confirmation it does not carry", async () => {
    const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(owner, { role: "admin" }), sessionId: randomUUID() };
    await expect(execute("probes.change_role", ada, { userId: ada.userId })).rejects.toMatchObject({
      status: 403,
      type: "https://tiehall.com/problems/confirmation-required",
    });
    await removeMember(ada.userId);
    await expect(execute("probes.change_role", ada, { userId: ada.userId })).rejects.toMatchObject({
      status: 403,
      type: "https://tiehall.com/problems/removed-member",
    });
  });

  it("gets 403 on /api/v1 for a call whose input, body, Idempotency-Key or If-Match a member gets refused for", async () => {
    const dana = await addUser(owner, { role: "member" });
    const caller: Caller = { kind: "personal_access_token", userId: dana, tokenId: randomUUID(), scopes: ["requests:write"], surface: "api" };
    const rest = createRestHandler({ catalog, document: "{}\n", execute, authenticate: async () => caller, logger: createLogger({ write: () => {} }) });
    const revise = (headers: Record<string, string>, body: string) =>
      new Request(`${INSTALL}/api/v1/notes/${noteId}/revisions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const calls = [
      () => new Request(`${INSTALL}/api/v1/notes/not-an-id`),
      () => revise({}, "not JSON"),
      () => revise({ "idempotency-key": "k".repeat(256) }, JSON.stringify({ body: "The launch plan, v2" })),
      () => revise({ "if-match": 'W/"3"' }, JSON.stringify({ body: "The launch plan, v2" })),
    ];
    const answers = async () => {
      const found: [number, string][] = [];
      for (const call of calls) {
        const response = await rest(call());
        found.push([response.status, ((await response.json()) as { type: string }).type]);
      }
      return found;
    };
    expect(await answers()).toEqual([
      [400, "https://tiehall.com/problems/invalid-input"],
      [400, "https://tiehall.com/problems/invalid-input"],
      [400, "https://tiehall.com/problems/invalid-input"],
      [412, "https://tiehall.com/problems/precondition-failed"],
    ]);

    await removeMember(dana);
    lookups = 0;
    expect(await answers()).toEqual(calls.map(() => [403, "https://tiehall.com/problems/removed-member"]));
    expect(lookups).toBe(0);
  });

  it("gets the 403 for a user the install never had as a member, too", async () => {
    const stranger = randomUUID();
    await expect(
      execute("probes.get_note", { kind: "web_session", userId: stranger, sessionId: randomUUID() }, { noteId }),
    ).rejects.toMatchObject({ status: 403, type: "https://tiehall.com/problems/removed-member" });
  });
});

describe("the confirmation step for a user who is not a member, or whose role does not allow the action", () => {
  const nonces = createConfirmationNonces({ secret: SECRET });
  const reviewPage = (caller: WebSessionCaller) =>
    createConfirmRoute({
      step: createConfirmationStep({
        catalog,
        reviews: {
          "probes.change_role": async () => {
            lookups += 1;
            return { title: "Change a role", lines: [] };
          },
        },
        store: { database: db },
        confirmations: nonces,
      }),
      session: async () => caller,
      write: { execute, url: INSTALL, secret: SECRET },
    });
  const open = async (caller: WebSessionCaller) => {
    const input = encodeURIComponent(JSON.stringify({ userId: caller.userId }));
    const answer = await reviewPage(caller)(new Request(`${INSTALL}/confirm/probes.change_role?input=${input}`));
    return { status: answer.status, body: await answer.text() };
  };

  it("serves the review page to an admin who is a member", async () => {
    const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(owner, { role: "admin" }), sessionId: randomUUID() };
    expect((await open(ada)).status).toBe(200);
  });

  it("refuses the review page to a removed member with 403 removed-member, before the review reads anything", async () => {
    const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(owner, { role: "admin" }), sessionId: randomUUID() };
    await removeMember(ada.userId);
    lookups = 0;
    const { status, body } = await open(ada);
    expect(status).toBe(403);
    expect(JSON.parse(body)).toMatchObject({ type: "https://tiehall.com/problems/removed-member" });
    expect(lookups).toBe(0);
  });

  it("refuses the review page and the confirmation to a removed member with 403 removed-member, whatever input they send", async () => {
    const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(owner, { role: "admin" }), sessionId: randomUUID() };
    const inputs = ["not JSON", JSON.stringify({ userId: "not-an-id" })];
    const answers = async () => {
      const found: [number, string][] = [];
      for (const input of inputs) {
        const page = await reviewPage(ada)(new Request(`${INSTALL}/confirm/probes.change_role?input=${encodeURIComponent(input)}`));
        found.push([page.status, ((await page.json()) as { type: string }).type]);
        const form = new URLSearchParams({ csrf: csrfTokenFor(SECRET, ada.sessionId), input, nonce: "" });
        const confirmed = await reviewPage(ada)(
          new Request(`${INSTALL}/confirm/probes.change_role`, {
            method: "POST",
            headers: { origin: INSTALL, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          }),
        );
        found.push([confirmed.status, ((await confirmed.json()) as { type: string }).type]);
      }
      return found;
    };
    expect(await answers()).toEqual(inputs.flatMap(() => [
      [400, "https://tiehall.com/problems/invalid-input"],
      [400, "https://tiehall.com/problems/invalid-input"],
    ]));

    await removeMember(ada.userId);
    lookups = 0;
    expect(await answers()).toEqual(inputs.flatMap(() => [
      [403, "https://tiehall.com/problems/removed-member"],
      [403, "https://tiehall.com/problems/removed-member"],
    ]));
    expect(lookups).toBe(0);
  });

  it("refuses an admin action's review page to a member with 403", async () => {
    const dana: WebSessionCaller = { kind: "web_session", userId: await addUser(owner, { role: "member" }), sessionId: randomUUID() };
    lookups = 0;
    const { status, body } = await open(dana);
    expect(status).toBe(403);
    expect(JSON.parse(body)).toMatchObject({ type: "https://tiehall.com/problems/forbidden" });
    expect(lookups).toBe(0);
  });

  it("refuses a gated route of the sign-in service to a removed member with 403 removed-member, and keeps the nonce unused", async () => {
    const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(owner, { role: "member" }), sessionId: randomUUID() };
    const input = { clientId: "https://client.example/metadata.json" };
    const nonce = nonces.issue(ada, "oauth.approve_client", input);
    await removeMember(ada.userId);
    await expect(consumeForGatedRoute(db, nonces, { caller: ada, action: "oauth.approve_client", input, nonce })).rejects.toMatchObject({
      status: 403,
      type: "https://tiehall.com/problems/removed-member",
    });
    expect((await owner.query("SELECT count(*)::int AS n FROM used_confirmation_nonces")).rows).toEqual([{ n: 0 }]);
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand, role } from "@tiehall/catalog";
import { defineEventType } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { createExecute, migrate, openDatabase, type Caller, type Database, type Execute } from "../src/index.ts";
import { addUser } from "./support/members.ts";

// The role matrix that execute() consults (teams-and-roles: Two roles, admin and
// member; teams-and-roles: What admins and members may do; teams-and-roles: The
// role bounds every caller acting for a user). For every caller that acts for a
// user, execute() reads the user's role in the call's transaction and refuses
// an admin action to anyone whose role does not allow it, with 403, before its
// handler runs, so it changes nothing. An input that names a role other than
// admin or member, such as owner, fails its schema and gets 400. Admin actions
// run only in the web UI, so no token reaches one, whatever its user's role.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const probeTeamCreated = defineEventType({
  type: "probe.team_created",
  class: "security",
  fields: { teamId: { kind: "id", of: "team" } },
});

const catalog = defineCatalog([
  defineCommand({
    id: "probes.create_team",
    summary: "An admin action: create a team.",
    input: z.object({ key: z.string() }),
    output: z.object({ teamId: z.uuid() }),
    scopes: [],
    commitment: false,
    confirm: false,
    admin: "teams",
    surfaces: [],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.set_role",
    summary: "An admin action whose input names a role.",
    input: z.object({ userId: z.uuid(), role }),
    output: z.object({}),
    scopes: [],
    commitment: false,
    confirm: false,
    admin: "members",
    surfaces: [],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.read",
    summary: "An operation every member may run.",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    method: "GET",
    path: "/api/v1/probes",
    scopes: ["requests:read"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp"],
    tool: "read_probes",
    stability: "alpha",
  }),
]);

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let execute: Execute;
let ran: string[] = [];
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
let ada: string;
let dana: string;

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await owner.query("CREATE TABLE probe_teams (org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), key text NOT NULL)");
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  ada = await addUser(owner, { role: "admin", login: "ada" });
  dana = await addUser(owner, { role: "member", login: "dana" });
  execute = createExecute({
    catalog,
    handlers: {
      "probes.create_team": async (input, context) => {
        ran.push("probes.create_team");
        return context.write(async (writer) => {
          const { rows } = await writer.tx.execute<{ id: string }>(
            `INSERT INTO probe_teams (org_id, key) VALUES ('${writer.orgId}', ${pg.escapeLiteral((input as { key: string }).key)}) RETURNING id`,
          );
          const teamId = rows[0]?.id ?? "";
          await writer.record(probeTeamCreated, { teamId });
          return { teamId };
        });
      },
      "probes.set_role": async () => {
        ran.push("probes.set_role");
        return {};
      },
      "probes.read": async () => ({ ok: true }),
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

const session = (userId: string): Caller => ({ kind: "web_session", userId, sessionId: randomUUID() });

async function teamsAndEvents(): Promise<{ teams: number; events: number }> {
  const { rows } = await owner.query<{ teams: number; events: number }>(
    "SELECT (SELECT count(*)::int FROM probe_teams) AS teams, (SELECT count(*)::int FROM events) AS events",
  );
  return rows[0] ?? { teams: -1, events: -1 };
}

describe("an admin action", () => {
  it("is refused to a member with 403 before its handler runs, and changes nothing", async () => {
    ran = [];
    const before = await teamsAndEvents();
    await expect(execute("probes.create_team", session(dana), { key: "MOB" })).rejects.toMatchObject({
      status: 403,
      type: "https://tiehall.com/problems/forbidden",
    });
    expect(ran).toEqual([]);
    expect(await teamsAndEvents()).toEqual(before);
  });

  it("runs for an admin", async () => {
    const before = await teamsAndEvents();
    const output = await execute("probes.create_team", session(ada), { key: "MOB" });
    expect(output).toEqual({ teamId: expect.any(String) });
    expect(await teamsAndEvents()).toEqual({ teams: before.teams + 1, events: before.events + 1 });
  });

  it("follows the role the user holds at the time of the call", async () => {
    const omar = await addUser(owner, { role: "member", login: "omar" });
    const omarsSession = session(omar);
    await expect(execute("probes.create_team", omarsSession, { key: "OPS" })).rejects.toMatchObject({ status: 403 });
    await owner.query("UPDATE members SET role = 'admin' WHERE user_id = $1", [omar]);
    await expect(execute("probes.create_team", omarsSession, { key: "OPS" })).resolves.toEqual({ teamId: expect.any(String) });
    await owner.query("UPDATE members SET role = 'member' WHERE user_id = $1", [omar]);
    await expect(execute("probes.create_team", omarsSession, { key: "OPS2" })).rejects.toMatchObject({ status: 403 });
  });

  it("is reached by no token, whatever its user's role, as a path that is not there", async () => {
    for (const userId of [ada, dana]) {
      for (const caller of [
        { kind: "personal_access_token", userId, tokenId: randomUUID(), scopes: ["requests:read", "requests:write"], surface: "api" },
        { kind: "oauth_token", userId, clientId: "https://client.example/metadata.json", scopes: ["requests:write"], surface: "mcp" },
      ] satisfies Caller[]) {
        await expect(execute("probes.create_team", caller, { key: "BOT" })).rejects.toMatchObject({
          status: 404,
          type: "https://tiehall.com/problems/route-not-found",
        });
      }
    }
  });
});

describe("an operation every member may run", () => {
  it("runs for a member and for an admin, through a session or a token", async () => {
    for (const userId of [ada, dana]) {
      await expect(execute("probes.read", session(userId), {})).resolves.toEqual({ ok: true });
      const token: Caller = { kind: "personal_access_token", userId, tokenId: randomUUID(), scopes: ["requests:read"], surface: "api" };
      await expect(execute("probes.read", token, {})).resolves.toEqual({ ok: true });
    }
  });
});

describe("an input that names a role", () => {
  it("is refused with 400 when the role is not admin or member, such as owner, and nothing runs", async () => {
    ran = [];
    await expect(execute("probes.set_role", session(ada), { userId: dana, role: "owner" })).rejects.toMatchObject({
      status: 400,
      type: "https://tiehall.com/problems/invalid-input",
    });
    expect(ran).toEqual([]);
    await expect(execute("probes.set_role", session(ada), { userId: dana, role: "admin" })).resolves.toEqual({});
    expect(ran).toEqual(["probes.set_role"]);
  });
});

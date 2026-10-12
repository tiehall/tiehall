import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { defineEventType } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createConfirmationNonces,
  createConfirmationStep,
  createConfirmRoute,
  createExecute,
  migrate,
  openDatabase,
  provenanceOf,
  type Caller,
  type Database,
  type WebSessionCaller,
} from "../src/index.ts";
import { addUser } from "./support/members.ts";

// What the confirmation step records (agent-safety: Actions that need the
// confirmation step; requests: Provenance is stamped by the server; design.md,
// Self-hosting decisions: S7). Every action the confirmation step applies is
// recorded with the actor kind web_session and the surface web, for the
// signed-in user: the server cannot tell a person from an agent that drives a
// browser, so in v1 nothing is recorded with the actor kind human, which stays
// reserved for a later confirmation that proves a person acted. The schema
// refuses that actor kind, and no code path writes it.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const URL_OF_INSTALL = "https://tiehall.example.com";
const SECRET = randomBytes(32).toString("base64url");
const LEE = randomUUID();

/** A security event of the kind a role change records. */
const roleChanged = defineEventType({
  type: "probe.role_changed",
  class: "security",
  fields: { userId: { kind: "id", of: "user" }, role: { kind: "enum", values: ["admin", "member"] } },
});

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
]);

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
  await migrate(
    { connectionString: database.url },
    { migrationsFolder, release: "0.0.0-dev", appRole, alsoKnownTables: ["public.probe_members"], log: () => {} },
  );
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  await addUser(owner, { userId: pia.userId, role: "admin" });
  await owner.query("INSERT INTO probe_members VALUES ($1, 'member')", [LEE]);
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

describe("an action applied through the confirmation step", () => {
  it("is recorded with the actor kind web_session, the surface web and the signed-in user, never as human", async () => {
    const confirmations = createConfirmationNonces({ secret: SECRET });
    const store = { database: db, jobs: { send: async () => {} } };
    const execute = createExecute({
      catalog,
      handlers: {
        "probes.change_role": async (input, context) => {
          const { userId, role } = input as { userId: string; role: "admin" | "member" };
          return context.write(async (writer) => {
            await writer.tx.execute(`UPDATE probe_members SET role = '${role}' WHERE user_id = '${userId}'`);
            await writer.record(roleChanged, { userId, role });
            return { userId, role };
          });
        },
      },
      store,
      confirmations,
    });
    const route = createConfirmRoute({
      step: createConfirmationStep({
        catalog,
        reviews: { "probes.change_role": async () => ({ title: "Change a role", lines: [] }) },
        store,
        confirmations,
      }),
      session: async () => pia,
      write: { execute, url: URL_OF_INSTALL, secret: SECRET },
    });

    // The person opens the review page and presses Confirm, which posts the page's form.
    const input = encodeURIComponent(JSON.stringify({ userId: LEE, role: "admin" }));
    const html = await (await route(new Request(`${URL_OF_INSTALL}/confirm/probes.change_role?input=${input}`))).text();
    const field = (name: string) => new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html)?.[1]?.replaceAll("&#34;", '"') ?? "";
    const answer = await route(
      new Request(`${URL_OF_INSTALL}/confirm/probes.change_role`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: URL_OF_INSTALL,
          "sec-fetch-site": "same-origin",
          "x-forwarded-for": "203.0.113.7",
          "user-agent": "Mozilla/5.0 (probe)",
        },
        body: new URLSearchParams({ input: field("input"), nonce: field("nonce"), csrf: field("csrf") }).toString(),
      }),
    );
    expect(answer.status).toBe(200);

    const { rows } = await owner.query(
      "SELECT class, type, actor_kind, actor_user_id, surface, client, operator_command FROM events ORDER BY number",
    );
    expect(rows).toEqual([
      {
        class: "security",
        type: "probe.role_changed",
        actor_kind: "web_session",
        actor_user_id: pia.userId,
        surface: "web",
        client: null,
        operator_command: null,
      },
    ]);
    // Its IP address and user agent are kept apart from the event, for 90 days.
    expect((await owner.query("SELECT host(ip_address) AS ip, user_agent FROM security_event_origins")).rows).toEqual([
      { ip: "203.0.113.7", user_agent: "Mozilla/5.0 (probe)" },
    ]);
  });
});

describe("the actor kind human", () => {
  it("is refused by the schema, so no code path can write it", async () => {
    const { rows } = await owner.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'events_actor_kind_known'",
    );
    expect(rows[0]?.definition).toMatch(/'web_session'/);
    expect(rows[0]?.definition).not.toMatch(/'human'/);
    const app = new pg.Client({ connectionString: database.url.replace(/\/\/[^@]+@/, `//${appRole.name}:${appRole.password}@`) });
    await app.connect();
    try {
      const orgId = (await app.query<{ id: string }>("SELECT id FROM orgs")).rows[0]?.id;
      await expect(
        app.query(
          `INSERT INTO events (org_id, number, class, type, data, actor_kind, actor_user_id, surface)
           VALUES ($1, 999, 'security', 'probe.role_changed', '{}', 'human', $2, 'web')`,
          [orgId, pia.userId],
        ),
      ).rejects.toThrow(/events_actor_kind_known/);
    } finally {
      await app.end();
    }
  });

  it("is what no kind of caller's provenance stamps", () => {
    const callers: Caller[] = [
      pia,
      { kind: "oauth_token", userId: pia.userId, clientId: "https://client.example/metadata.json", scopes: [], surface: "mcp" },
      { kind: "personal_access_token", userId: pia.userId, tokenId: randomUUID(), scopes: [], surface: "api" },
      { kind: "ci", repositoryId: "1296269", repositoryOwnerId: "9919", jobWorkflowRef: "acme/payments/.github/workflows/contract.yml@refs/heads/main" },
      { kind: "system_job", job: "requests.close_on_merge" },
      { kind: "integration_event", source: "github", userId: pia.userId },
    ];
    expect(callers.map((caller) => provenanceOf(caller).actorKind)).toEqual(["web_session", "agent", "agent", "system", "system", "integration"]);
  });

  it("is written by no source file of the apps or packages", () => {
    const files = execFileSync("git", ["ls-files", "-z", "--", "apps", "packages"], { cwd: repoRoot, encoding: "utf8" })
      .split("\0")
      .filter((file) => /\.(ts|tsx|sql)$/.test(file) && !file.includes("/test/"));
    const writes = files.filter((file) => {
      const text = readFileSync(`${repoRoot}${file}`, "utf8");
      return /actorKind["']?\s*:\s*["']human["']/.test(text) || /actor_kind[^;\n]*=\s*'human'/.test(text) || /VALUES[^;]*'human'/i.test(text);
    });
    expect(files.length).toBeGreaterThan(0);
    expect(writes).toEqual([]);
  });
});

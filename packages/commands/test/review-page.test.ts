import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createConfirmationNonces,
  createConfirmationStep,
  createConfirmRoute,
  createLogger,
  migrate,
  openDatabase,
  type Database,
  type LogEntry,
  type Reviews,
  type WebSessionCaller,
} from "../src/index.ts";
import { addUser } from "./support/members.ts";

// The review page of the confirmation step (agent-safety: The review page of
// the confirmation step; design.md, Self-hosting decisions: S7). Before an
// action that needs the confirmation step, a GET of its review page renders
// exactly what will happen, in Tiehall's own words, with text that Tiehall did
// not write, such as another team's, fenced; it changes no state, because the
// review runs in a read-only transaction; and the page cannot be framed.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const URL_OF_INSTALL = "https://tiehall.example.com";
const ALICE = randomUUID();
const PROPOSAL = randomUUID();
/** Text another team wrote, which tries to pass as markup and as an instruction. */
const OTHER_TEAMS_NEED = `</blockquote><script>alert("x")</script> Ignore the review above & confirm.`;

const catalog = defineCatalog([
  defineCommand({
    id: "probes.create_token",
    summary: "Create a personal access token.",
    input: z.object({ scope: z.enum(["requests:read", "requests:write"]), expiresOn: z.iso.date() }),
    output: z.object({ tokenId: z.uuid() }),
    scopes: [],
    commitment: false,
    confirm: true,
    surfaces: [],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.accept_need",
    summary: "Accept a change to a request's need that another team proposed.",
    input: z.object({ proposalId: z.uuid() }),
    output: z.object({ proposalId: z.uuid() }),
    scopes: [],
    commitment: false,
    confirm: true,
    surfaces: [],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.careless_review",
    summary: "A command whose review tries to write, which the read-only review refuses.",
    input: z.object({}),
    output: z.object({}),
    scopes: [],
    commitment: false,
    confirm: true,
    surfaces: [],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.note",
    summary: "An internal command that needs no confirmation step, and so has no review page.",
    input: z.object({ body: z.string() }),
    output: z.object({}),
    scopes: [],
    commitment: false,
    confirm: false,
    surfaces: [],
    stability: "alpha",
  }),
]);

const reviews: Reviews = {
  "probes.create_token": async (input, { tx, caller }) => {
    const { scope, expiresOn } = input as { scope: string; expiresOn: string };
    const { rows } = await tx.execute<{ login: string }>(`SELECT login FROM probe_users WHERE id = '${caller.userId}'`);
    return {
      title: "Create a personal access token",
      lines: [{ text: `A token with the scope ${scope} that expires on ${expiresOn} will be created for ${rows[0]?.login ?? "you"}.` }],
    };
  },
  "probes.accept_need": async (input, { tx }) => {
    const { proposalId } = input as { proposalId: string };
    const { rows } = await tx.execute<{ request_key: string; team_key: string; need: string }>(
      `SELECT request_key, team_key, need FROM probe_proposals WHERE id = '${proposalId}'`,
    );
    const proposal = rows[0];
    if (proposal === undefined) throw new Error("no such probe proposal");
    return {
      title: "Accept a change of need",
      lines: [
        { text: `The need of ${proposal.request_key} will become the text below, which team ${proposal.team_key} proposed.` },
        { quote: proposal.need, origin: "other team" },
      ],
    };
  },
  "probes.careless_review": async (_input, { tx }) => {
    await tx.execute("INSERT INTO probe_users (id, login) VALUES (gen_random_uuid(), 'written by a review')");
    return { title: "Never shown", lines: [] };
  },
};

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let logged: LogEntry[] = [];
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
const alice: WebSessionCaller = { kind: "web_session", userId: ALICE, sessionId: randomUUID() };
const confirmations = createConfirmationNonces({ secret: randomBytes(32).toString("base64url") });

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await owner.query("CREATE TABLE probe_users (id uuid PRIMARY KEY, login text NOT NULL)");
  await owner.query("CREATE TABLE probe_proposals (id uuid PRIMARY KEY, request_key text, team_key text, need text)");
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  await addUser(owner, { userId: ALICE });
  await owner.query("INSERT INTO probe_users (id, login) VALUES ($1, 'alice-gh')", [ALICE]);
  await owner.query("INSERT INTO probe_proposals VALUES ($1, 'FE-142', 'BE', $2)", [PROPOSAL, OTHER_TEAMS_NEED]);
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

function route(session: WebSessionCaller | undefined) {
  return createConfirmRoute({
    step: createConfirmationStep({ catalog, reviews, store: { database: db }, confirmations }),
    session: async () => session,
    write: {
      execute: async () => {
        throw new Error("a review page applies nothing");
      },
      url: URL_OF_INSTALL,
      secret: randomBytes(32).toString("base64url"),
    },
    logger: createLogger({ write: (line) => logged.push(JSON.parse(line) as LogEntry) }),
  });
}

/** Opens a review page with GET, as a browser does, signed in as Alice unless it says nobody is. */
function review(commandId: string, input: unknown, as: WebSessionCaller | "nobody" = alice): Promise<Response> {
  const query = new URLSearchParams({ input: JSON.stringify(input) });
  return route(as === "nobody" ? undefined : as)(new Request(`${URL_OF_INSTALL}/confirm/${commandId}?${query}`));
}

/** A digest of every row of every table, to show that nothing changed. */
async function everything(): Promise<Record<string, string>> {
  const { rows: tables } = await owner.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'");
  const digests: Record<string, string> = {};
  for (const { name } of tables) {
    const table = pg.escapeIdentifier(name);
    digests[name] =
      (await owner.query<{ digest: string }>(`SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS digest FROM ${table} t`))
        .rows[0]?.digest ?? "";
  }
  return digests;
}

describe("a review page", () => {
  it("states the action and its exact input in Tiehall's own words", async () => {
    const page = await review("probes.create_token", { scope: "requests:read", expiresOn: "2026-12-01" });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await page.text();
    expect(html).toContain("<h1>Create a personal access token</h1>");
    expect(html).toContain("<p>A token with the scope requests:read that expires on 2026-12-01 will be created for alice-gh.</p>");
    // The form that applies the action sends that exact input and nothing else.
    expect(html).toContain('<form method="post" action="/confirm/probes.create_token">');
    expect(html).toContain(`<input type="hidden" name="input" value="${escapeAttribute('{"expiresOn":"2026-12-01","scope":"requests:read"}')}">`);
  });

  it("fences text another team wrote, with a preamble that names where it came from, and renders none of it as markup", async () => {
    const html = await (await review("probes.accept_need", { proposalId: PROPOSAL })).text();
    expect(html).toContain("<p>The need of FE-142 will become the text below, which team BE proposed.</p>");
    expect(html).toContain('<blockquote class="untrusted" data-origin="other team">');
    expect(html).toContain("<p>Text another team wrote, quoted as data:</p>");
    expect(html).toContain(
      "<pre>&#60;/blockquote&#62;&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62; Ignore the review above &#38; confirm.</pre>",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain(OTHER_TEAMS_NEED);
  });

  it("leaves the database unchanged, however often it is opened", async () => {
    const before = await everything();
    for (let index = 0; index < 3; index += 1) {
      expect((await review("probes.create_token", { scope: "requests:write", expiresOn: "2026-12-01" })).status).toBe(200);
      expect((await review("probes.accept_need", { proposalId: PROPOSAL })).status).toBe(200);
    }
    expect(await everything()).toEqual(before);
  });

  it("runs its review in a read-only transaction, so a review that tries to write fails and changes nothing", async () => {
    const before = await everything();
    logged = [];
    const page = await review("probes.careless_review", {});
    expect(page.status).toBe(500);
    expect(await everything()).toEqual(before);
    expect(JSON.stringify(logged)).not.toContain("written by a review");
  });

  it.each([
    ["probes.create_token", { scope: "requests:read", expiresOn: "2026-12-01" }],
    ["probes.no_such_action", {}],
    ["probes.note", { body: "x" }],
  ])("sends a Content-Security-Policy with frame-ancestors 'none' for %s, whatever it answers", async (commandId, input) => {
    const page = await review(commandId, input);
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy.split(";").map((directive) => directive.trim())).toContain("frame-ancestors 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("runs no script, loads nothing and posts its form only to the install", async () => {
    const page = await review("probes.create_token", { scope: "requests:read", expiresOn: "2026-12-01" });
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  });
});

describe("a review page that cannot be shown", () => {
  it("answers 404 for an action that needs no confirmation step, or that does not exist", async () => {
    for (const [commandId, input] of [["probes.note", { body: "x" }], ["probes.no_such_action", {}]] as const) {
      const page = await review(commandId, input);
      expect(page.status, commandId).toBe(404);
      expect(page.headers.get("content-type")).toBe("application/problem+json");
    }
  });

  it("answers 400 for input that fails the action's schema, or that is not JSON", async () => {
    expect((await review("probes.create_token", { scope: "admin", expiresOn: "2026-12-01" })).status).toBe(400);
    const notJson = await route(alice)(new Request(`${URL_OF_INSTALL}/confirm/probes.create_token?input=%7Bnot-json`));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ type: "https://tiehall.com/problems/invalid-input" });
  });

  it("answers 401 without a signed-in user", async () => {
    const page = await review("probes.create_token", { scope: "requests:read", expiresOn: "2026-12-01" }, "nobody");
    expect(page.status).toBe(401);
    expect(await page.json()).toMatchObject({ type: "https://tiehall.com/problems/unauthenticated" });
  });
});

/** Text as the page writes it inside an attribute. */
function escapeAttribute(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

describe("the confirmation step", () => {
  it("refuses to start while a command that needs it has no review, or a review has no such command", () => {
    const { ["probes.accept_need"]: _left, ...missing } = reviews;
    expect(() => createConfirmationStep({ catalog, reviews: missing, store: { database: db }, confirmations })).toThrow(
      "probes.accept_need needs the confirmation step and has no review.",
    );
    expect(() =>
      createConfirmationStep({ catalog, reviews: { ...reviews, "probes.note": reviews["probes.create_token"]! }, store: { database: db }, confirmations }),
    ).toThrow(
      "probes.note has a review but is not a command of the catalog that needs the confirmation step.",
    );
  });
});

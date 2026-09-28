import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, dumpDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createLogger,
  createSetupRoute,
  migrate,
  openDatabase,
  openSecretBox,
  SETUP_CODE_BITS,
  startSetup,
  type Database,
  type LogEntry,
} from "../src/index.ts";

// The setup code (self-host-install: The setup code guards the setup screen;
// design.md, Self-hosting decisions: S3). While setup is incomplete, each
// start of the web role prints a new setup code to the log, where `docker
// compose logs app` shows it, and stores only a hash of it, which replaces the
// previous one. Only a browser that enters the current code gets a setup
// session; a wrong code, the previous code and a POST from any origin but the
// install's own get 403 and no session. Every step of the setup screen needs
// that session. A setup session does not expire with time, and a later start
// does not end it; only the completion of setup does (design.md, Decisions:
// D45 (7)).

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const URL_OF_INSTALL = "https://tiehall.example.com";

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let logged: LogEntry[] = [];
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
const logger = createLogger({ write: (line) => logged.push(JSON.parse(line) as LogEntry) });

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  logged = [];
  await owner.query("DELETE FROM setup_sessions; DELETE FROM setup_codes; DELETE FROM orgs");
});

/** Starts the web role's setup step, as each start of the web role does, and returns the code it printed. */
async function start(): Promise<string> {
  const started = await startSetup({ database: db, url: URL_OF_INSTALL, logger });
  if (started === undefined) throw new Error("startSetup printed no code");
  return started.code;
}

const secrets = () => openSecretBox(randomBytes(32).toString("base64url"));
const route = () => createSetupRoute({ database: db, url: URL_OF_INSTALL, logger, secrets });

/** Enters a code on the setup screen, as the browser's form does. */
function enter(code: string, headers: Record<string, string> = { origin: URL_OF_INSTALL }): Promise<Response> {
  return route()(
    new Request(`${URL_OF_INSTALL}/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https", ...headers },
      body: new URLSearchParams({ code }).toString(),
    }),
  );
}

/** Opens the setup screen, with the session cookie a browser holds, if any. */
function open(cookie?: string): Promise<Response> {
  return route()(
    new Request(`${URL_OF_INSTALL}/setup`, {
      headers: { host: "tiehall.example.com", "x-forwarded-proto": "https", ...(cookie === undefined ? {} : { cookie }) },
    }),
  );
}

/** The cookie a browser sends back after this answer set it. */
function cookieOf(response: Response): string | undefined {
  const set = response.headers.get("set-cookie");
  return set === null ? undefined : set.split(";")[0];
}

async function sessions(): Promise<number> {
  return (await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM setup_sessions")).rows[0]?.n ?? 0;
}

describe("each start of the web role while setup is incomplete", () => {
  it("prints a setup code with at least 128 bits of randomness to the log, beside the setup screen's URL", async () => {
    const code = await start();
    expect(SETUP_CODE_BITS).toBeGreaterThanOrEqual(128);
    // 28 characters of Crockford's base32, 5 bits each, in groups of 4.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
    expect(SETUP_CODE_BITS).toBe(28 * 5);
    expect(logged).toEqual([
      expect.objectContaining({
        level: "info",
        msg: `setup: setup is not complete. Open ${URL_OF_INSTALL}/setup and enter the setup code ${code}`,
      }),
    ]);
  });

  it("makes the install's one org, unnamed until the setup screen names it", async () => {
    await start();
    expect((await owner.query("SELECT name, setup_completed_at FROM orgs")).rows).toEqual([{ name: null, setup_completed_at: null }]);
    await start();
    expect((await owner.query("SELECT count(*)::int AS n FROM orgs")).rows).toEqual([{ n: 1 }]);
  });

  it("prints a new code each time, which replaces the previous one", async () => {
    const codes = new Set<string>();
    for (let index = 0; index < 5; index += 1) codes.add(await start());
    expect(codes.size).toBe(5);
    expect((await owner.query("SELECT count(*)::int AS n FROM setup_codes")).rows).toEqual([{ n: 1 }]);
  });

  it("stores only a hash of the code, so the database holds no code in clear", async () => {
    const code = await start();
    const { rows } = await owner.query<{ code_hash: Buffer }>("SELECT code_hash FROM setup_codes");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code_hash.byteLength).toBe(32);
    const dump = dumpDatabase(database.url, "plain").toString("utf8");
    for (const form of [code, code.replaceAll("-", ""), code.toLowerCase(), code.replaceAll("-", "").toLowerCase()]) {
      expect(dump).not.toContain(form);
    }
    expect(dump).not.toContain(Buffer.from(code.replaceAll("-", "")).toString("hex"));
  });
});

describe("entering the setup code", () => {
  it("opens a setup session in that browser, with a cookie only the install reads", async () => {
    const code = await start();
    const answer = await enter(code);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`${URL_OF_INSTALL}/setup`);
    const cookie = answer.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-tiehall-setup=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(await sessions()).toBe(1);
    // The session's token is stored as a hash too.
    const token = cookieOf(answer)?.split("=")[1] ?? "";
    expect(dumpDatabase(database.url, "plain").toString("utf8")).not.toContain(token);
  });

  it("accepts the code as a person types it: in lower case, without the dashes, with spaces around it", async () => {
    const code = await start();
    expect((await enter(`  ${code.replaceAll("-", "").toLowerCase()} `)).status).toBe(303);
  });

  it("refuses a wrong code with 403, and opens no session", async () => {
    await start();
    const answer = await enter("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345");
    expect(answer.status).toBe(403);
    expect(answer.headers.get("content-type")).toBe("application/problem+json");
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/forbidden", status: 403 });
    expect(await sessions()).toBe(0);
  });

  it("refuses the code of the previous start with 403, and the new code opens a session", async () => {
    const previous = await start();
    const current = await start();
    expect((await enter(previous)).status).toBe(403);
    expect(await sessions()).toBe(0);
    expect((await enter(current)).status).toBe(303);
    expect(await sessions()).toBe(1);
  });

  it.each([
    ["another origin", { origin: "http://10.0.0.5:3000" }],
    ["an attacker's origin", { origin: "https://attacker.example" }],
    ["the install's host over http", { origin: "http://tiehall.example.com" }],
    ["no origin", {}],
  ])("refuses the current code sent from %s with 403, and opens no session", async (_from, headers: Record<string, string>) => {
    const code = await start();
    const answer = await enter(code, headers);
    expect(answer.status).toBe(403);
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(await sessions()).toBe(0);
  });

  it("refuses a code while no start has printed one", async () => {
    expect((await enter("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345")).status).toBe(403);
    expect(await sessions()).toBe(0);
  });
});

describe("a setup session", () => {
  it("outlives a later start: it still shows the next step, while the earlier code opens no new session", async () => {
    const first = await start();
    const cookie = cookieOf(await enter(first));
    await start();
    expect(await (await open(cookie)).text()).toContain("The setup code is accepted.");
    expect((await enter(first)).status).toBe(403);
    expect(await sessions()).toBe(1);
  });

  it("does not expire with time: one opened 30 days ago still shows the next step", async () => {
    const cookie = cookieOf(await enter(await start()));
    await owner.query("UPDATE setup_sessions SET created_at = created_at - interval '30 days'");
    expect(await (await open(cookie)).text()).toContain("The setup code is accepted.");
  });
});

describe("the setup screen", () => {
  it("asks for the setup code, in a page that runs no script and cannot be framed", async () => {
    await start();
    const page = await open();
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self'");
    const html = await page.text();
    expect(html).toContain('<form method="post" action="/setup">');
    expect(html).toContain('name="code"');
    expect(html).toContain("docker compose logs app");
    expect(html).not.toContain("<script");
  });

  it("shows the next step to a browser with a setup session, and the form to one without", async () => {
    const code = await start();
    const cookie = cookieOf(await enter(code));
    const withSession = await (await open(cookie)).text();
    // The next step names the company.
    expect(withSession).toContain("Name the company");
    expect(withSession).not.toContain('name="code"');
    expect(await (await open("__Host-tiehall-setup=not-a-session")).text()).toContain('name="code"');
  });

  it("does not continue when the browser's origin is not TIEHALL_URL, and names the URL to open instead", async () => {
    await start();
    const page = await route()(
      new Request("http://10.0.0.5:3000/setup", { headers: { host: "10.0.0.5:3000", "x-forwarded-proto": "http" } }),
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain('name="code"');
    expect(html).toContain(`${URL_OF_INSTALL}/setup`);
  });
});

describe("once setup is complete", () => {
  it("prints no code at start, and /setup answers 404 to every browser, the last code's included", async () => {
    const code = await start();
    const cookie = cookieOf(await enter(code));
    await owner.query("UPDATE orgs SET name = 'Acme', setup_completed_at = now()");
    logged = [];
    expect(await startSetup({ database: db, url: URL_OF_INSTALL, logger })).toBeUndefined();
    expect(logged).toEqual([]);
    for (const answer of [await open(), await open(cookie), await enter(code)]) {
      expect(answer.status).toBe(404);
      expect(answer.headers.get("content-type")).toBe("application/problem+json");
    }
  });
});

describe("a trial install on http://localhost", () => {
  it("keeps the session cookie without the Secure-only name, which http cannot set", async () => {
    const started = await startSetup({ database: db, url: "http://localhost:3000", logger });
    const answer = await createSetupRoute({ database: db, url: "http://localhost:3000", logger, secrets })(
      new Request("http://localhost:3000/setup", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: started?.code ?? "" }).toString(),
      }),
    );
    expect(answer.status).toBe(303);
    const cookie = answer.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^tiehall-setup=/);
    expect(cookie).not.toContain("Secure");
  });
});

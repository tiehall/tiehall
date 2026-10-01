import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@tiehall/commands";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";

// The image's admin role (self-host-install: Operator commands on the host;
// self-host-install: Only the migrate step holds the database owner's
// credentials; design.md, Self-hosting decisions: S3). The operator runs its
// commands on the host, for example with `docker compose run --rm app admin
// grant dana-gh`: they work without the web UI and without the confirmation
// step, and connect to the database as the app role, with the settings the app
// reads, never the owner's. Their output is plain text for the operator: what
// the command changed on standard output, and a refusal on standard error,
// with the exit code 0 when the command did what it was asked, 1 when it could
// not, and 2 for a usage error, which reads no setting.

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the entrypoint's admin role with these arguments and only these environment variables, until it exits. */
function runAdmin(args: string[], env: Record<string, string>): Promise<Exit> {
  const child = spawn(process.execPath, [main, "admin", ...args], { env: { PATH: process.env["PATH"] ?? "", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  return new Promise((resolve) =>
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    }),
  );
}

const USAGE = "Usage: main.mjs admin grant <github-login>, or main.mjs admin setup reopen.";

let database: TestDatabase;
let owner: pg.Client;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
/** The settings the app reads, as Compose hands them to the app service: the app role's connection, never the owner's. */
let appSettings: Record<string, string>;
const dana = randomUUID();
/** A member whose account an enterprise manages on GitHub: their login ends in the enterprise's shortcode after an underscore. */
const ana = randomUUID();

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  await owner.query(
    `INSERT INTO users (org_id, id, github_account_id, github_login, sign_in_key) SELECT id, $1, 4242, 'dana-gh', 'github:4242' FROM orgs`,
    [dana],
  );
  await owner.query("INSERT INTO members (org_id, user_id, role) SELECT id, $1, 'member' FROM orgs", [dana]);
  await owner.query(
    `INSERT INTO users (org_id, id, github_account_id, github_login, sign_in_key) SELECT id, $1, 4343, 'ana_acme', 'github:4343' FROM orgs`,
    [ana],
  );
  await owner.query("INSERT INTO members (org_id, user_id, role) SELECT id, $1, 'member' FROM orgs", [ana]);
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  appSettings = {
    TIEHALL_URL: "https://tiehall.example.com",
    TIEHALL_DATABASE_APP_URL: url.toString(),
    TIEHALL_DATABASE_APP_PASSWORD: appRole.password,
    TIEHALL_SECRET_KEY: randomBytes(32).toString("base64url"),
    TIEHALL_AUTH_SECRET: randomBytes(32).toString("base64url"),
  };
});

afterAll(async () => {
  const role = pg.escapeIdentifier(appRole.name);
  await owner.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  await owner.end();
  await database.drop();
});

describe("admin grant", () => {
  it("makes the member an admin through the app role's connection, says so, and exits 0", async () => {
    const run = await runAdmin(["grant", "dana-gh"], appSettings);
    expect(run).toEqual({ code: 0, stdout: "dana-gh is now an admin of this install.\n", stderr: "" });
    expect((await owner.query("SELECT role FROM members WHERE user_id = $1", [dana])).rows).toEqual([{ role: "admin" }]);
    // The role change and its event were written by the app role, which the app's settings name.
    const { rows } = await owner.query<{ actor_kind: string; operator_command: string; data: unknown }>(
      "SELECT actor_kind, operator_command, data FROM events WHERE type = 'member.role_changed'",
    );
    expect(rows).toEqual([{ actor_kind: "operator", operator_command: "admin grant", data: { userId: dana, role: "admin", previousRole: "member" } }]);
  });

  it("says that the member is an admin already, changes nothing and exits 0", async () => {
    const run = await runAdmin(["grant", "dana-gh"], appSettings);
    expect(run).toEqual({ code: 0, stdout: "dana-gh is an admin already, so nothing changed.\n", stderr: "" });
  });

  it("says that no member has the login, changes nothing and exits 1", async () => {
    const roles = (await owner.query("SELECT user_id, role FROM members")).rows;
    const run = await runAdmin(["grant", "no-such-member"], appSettings);
    expect(run).toEqual({
      code: 1,
      stdout: "",
      stderr: "tiehall admin grant: no member of this install has the GitHub login no-such-member, so nothing changed.\n",
    });
    expect((await owner.query("SELECT user_id, role FROM members")).rows).toEqual(roles);
  });

  it("needs no owner credential: it runs with the app's settings alone, and never reads the owner's", async () => {
    const run = await runAdmin(["grant", "dana-gh"], {
      ...appSettings,
      // An owner setting in the environment is not read: a wrong one changes nothing.
      TIEHALL_DATABASE_OWNER_PASSWORD: "not-the-owner-password",
      TIEHALL_DATABASE_OWNER_URL: "postgres://nobody@127.0.0.1:1/none",
    });
    expect(run.code).toBe(0);
  });

  it("makes a member whose account an enterprise manages an admin, by the login with the enterprise's shortcode", async () => {
    const run = await runAdmin(["grant", "ana_acme"], appSettings);
    expect(run).toEqual({ code: 0, stdout: "ana_acme is now an admin of this install.\n", stderr: "" });
    expect((await owner.query("SELECT role FROM members WHERE user_id = $1", [ana])).rows).toEqual([{ role: "admin" }]);
  });

  it("refuses a login GitHub never gives out, as a usage error that reads no setting", async () => {
    for (const login of ["-dana", "_acme", "dana gh", "a".repeat(101), ""]) {
      const run = await runAdmin(["grant", login], {});
      expect(run, login).toEqual({ code: 2, stdout: "", stderr: `tiehall admin grant: ${JSON.stringify(login)} is not a GitHub login.\n${USAGE}\n` });
    }
  });
});

describe("the admin role's usage", () => {
  it.each([[[]], [["grant"]], [["grant", "a", "b"]], [["revoke", "dana-gh"]], [["setup"]], [["setup", "close"]], [["setup", "reopen", "now"]]])(
    "prints its usage for %j, reads no setting and exits 2",
    async (args) => {
      const run = await runAdmin(args, {});
      expect(run).toEqual({ code: 2, stdout: "", stderr: `${USAGE}\n` });
    },
  );

  it("names a missing setting on standard error, without its value, and exits 1", async () => {
    const run = await runAdmin(["grant", "dana-gh"], { ...appSettings, TIEHALL_URL: "" });
    expect(run).toEqual({ code: 1, stdout: "", stderr: "tiehall admin: TIEHALL_URL is not set. Set TIEHALL_URL or TIEHALL_URL_FILE.\n" });
  });
});

describe("setup reopen", () => {
  it("reopens the setup screen's App step, prints a new setup code with the setup screen's URL, and exits 0", async () => {
    const run = await runAdmin(["setup", "reopen"], appSettings);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const code = /enter the setup code ([0-9A-Z-]{34})\./.exec(run.stdout)?.[1];
    expect(code).toBeDefined();
    expect(run.stdout).toBe(
      "The setup screen's GitHub App step is open again. Open https://tiehall.example.com/setup and enter the setup code " +
        `${code}.\n` +
        "The install keeps serving its members with the App in use until a new App is created there. The step closes when an " +
        "admin of the install signs in with GitHub from the setup screen; closing it makes nobody an admin.\n",
    );
    const { rows } = await owner.query<{ actor_kind: string; operator_command: string; data: unknown }>(
      "SELECT actor_kind, operator_command, data FROM events WHERE type = 'setup.reopened'",
    );
    expect(rows).toEqual([{ actor_kind: "operator", operator_command: "setup reopen", data: { alreadyOpen: false } }]);
    expect((await owner.query("SELECT setup_reopened_at IS NOT NULL AS open FROM orgs")).rows).toEqual([{ open: true }]);
    await owner.query("UPDATE orgs SET setup_reopened_at = NULL; DELETE FROM setup_codes");
  });
});

describe("the operator commands before setup completes", () => {
  it("change nothing, say that setup is not complete, and exit 1", async () => {
    await owner.query("UPDATE orgs SET setup_completed_at = NULL");
    try {
      const run = await runAdmin(["grant", "dana-gh"], appSettings);
      expect(run).toEqual({
        code: 1,
        stdout: "",
        stderr:
          "tiehall admin grant: setup is not complete, so the install has no admin to recover; the person who completes " +
          "setup on the setup screen becomes its first admin. Nothing changed.\n",
      });
      const reopen = await runAdmin(["setup", "reopen"], appSettings);
      expect(reopen).toEqual({
        code: 1,
        stdout: "",
        stderr:
          "tiehall admin setup reopen: setup is not complete, so the setup screen is open already: read its setup code " +
          "with `docker compose logs app`. Nothing changed.\n",
      });
      expect((await owner.query("SELECT setup_reopened_at FROM orgs")).rows).toEqual([{ setup_reopened_at: null }]);
    } finally {
      await owner.query("UPDATE orgs SET setup_completed_at = now()");
    }
  });
});

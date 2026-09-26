import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@tiehall/commands";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";

// The entrypoint reads the install settings before it starts a role
// (self-host-install: One `.env` holds the install settings; self-host-install:
// `TIEHALL_URL` and TLS). A role whose settings are missing or unusable does
// not start, and its one log line, JSON on standard output, says why without
// the setting's value. The web role needs the built Next.js server, which the
// image tests start; here the worker role shows that a trial URL starts.

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the entrypoint with only these environment variables, until it exits or SIGTERM is due. */
function runMain(role: string, env: Record<string, string>, stopWhen?: RegExp): Promise<Exit> {
  const child = spawn(process.execPath, [main, role], { env: { PATH: process.env["PATH"] ?? "", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stopWhen?.test(stdout)) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  return new Promise((resolve) =>
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    }),
  );
}

function logLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const INSTALL = {
  TIEHALL_URL: "https://tiehall.example.com",
  TIEHALL_DATABASE_APP_PASSWORD: "app-password",
  TIEHALL_SECRET_KEY: randomBytes(32).toString("base64url"),
  TIEHALL_AUTH_SECRET: randomBytes(32).toString("base64url"),
};

const URL_REFUSAL =
  "TIEHALL_URL must be an https:// URL, or http://localhost with or without a port for a trial on one machine.";

describe("the entrypoint's settings check", () => {
  it.each(["http://tiehall.example.com", "http://127.0.0.1:3000"])("refuses to start with TIEHALL_URL=%s and logs why", async (url) => {
    for (const role of ["web", "worker", "all"]) {
      const run = await runMain(role, { ...INSTALL, TIEHALL_URL: url });
      expect(run.code, role).toBe(1);
      expect(logLines(run.stdout), role).toEqual([
        expect.objectContaining({ level: "error", role, msg: `tiehall ${role}: ${URL_REFUSAL}` }),
      ]);
      expect(run.stdout + run.stderr).not.toContain(url);
    }
  });

  it("names a missing required setting", async () => {
    const run = await runMain("web", {});
    expect(run.code).toBe(1);
    expect(logLines(run.stdout)).toEqual([
      expect.objectContaining({ level: "error", msg: "tiehall web: TIEHALL_URL is not set. Set TIEHALL_URL or TIEHALL_URL_FILE." }),
    ]);
  });

  it("refuses to start migrate without the database owner's password, and never reads the app's keys", async () => {
    const run = await runMain("migrate", { TIEHALL_DATABASE_APP_PASSWORD: "app-password" });
    expect(run.code).toBe(1);
    expect(logLines(run.stdout)).toEqual([
      expect.objectContaining({
        level: "error",
        msg:
          "tiehall migrate: The database owner has no password. Set TIEHALL_DATABASE_OWNER_PASSWORD or " +
          "TIEHALL_DATABASE_OWNER_PASSWORD_FILE, or give it in TIEHALL_DATABASE_OWNER_URL.",
      }),
    ]);
  });
});

describe("a role with a trial URL and secrets in files", () => {
  let database: TestDatabase;
  let owner: pg.Client;
  let secrets: string;
  const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

  beforeAll(async () => {
    database = await createTestDatabase();
    owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
    secrets = mkdtempSync(join(tmpdir(), "tiehall-main-"));
  });

  afterAll(async () => {
    rmSync(secrets, { recursive: true, force: true });
    const role = pg.escapeIdentifier(appRole.name);
    await owner.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await owner.end();
    await database.drop();
  });

  it("starts at http://localhost:3000, with its secrets read from files, and stops on SIGTERM", async () => {
    const url = new URL(database.url);
    url.username = appRole.name;
    url.password = "";
    const file = (name: string, value: string) => {
      writeFileSync(join(secrets, name), `${value}\n`);
      return join(secrets, name);
    };
    const run = await runMain(
      "worker",
      {
        TIEHALL_URL: "http://localhost:3000",
        TIEHALL_DATABASE_APP_URL: url.toString(),
        TIEHALL_DATABASE_APP_PASSWORD_FILE: file("app_password", appRole.password),
        TIEHALL_SECRET_KEY_FILE: file("secret_key", INSTALL.TIEHALL_SECRET_KEY),
        TIEHALL_AUTH_SECRET_FILE: file("auth_secret", INSTALL.TIEHALL_AUTH_SECRET),
      },
      /worker: started/,
    );
    expect(run.code).toBe(0);
    expect(logLines(run.stdout).map(({ msg }) => msg)).toEqual([
      expect.stringMatching(/^tiehall worker: starting as uid/),
      "worker: started, working 1 queue",
      "worker: stopped",
    ]);
    expect(run.stdout).not.toContain(appRole.password);
    expect(run.stdout).not.toContain(INSTALL.TIEHALL_SECRET_KEY);
  });
});

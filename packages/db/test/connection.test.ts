import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { openDatabase } from "../src/index.ts";

// The app's connection pool (design.md, Technical decisions: T4), which the
// web and worker roles keep open for as long as they run. When the database
// restarts, or an operator ends a session, the connections idling in the pool
// end from the database's side. The pool drops each one and opens a new one
// for the next query; the loss is reported to the caller, which logs it, and
// never crashes the process, as an error event that nothing listens to would
// (self-host-install: A restart stops the app gracefully).

const probe = fileURLToPath(new URL("./support/idle-connection-probe.ts", import.meta.url));

let database: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await database.drop();
});

/** Ends every session of this application name from the database's side, as a restart does, and waits until they are gone. */
async function endSessions(applicationName: string): Promise<number> {
  const { rows } = await admin.query<{ ended: boolean }>(
    "SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity WHERE application_name = $1",
    [applicationName],
  );
  return rows.filter(({ ended }) => ended).length;
}

async function until(what: string, check: () => boolean, seconds = 4): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe("the app's connection pool", () => {
  it("reports a connection the database ends while it idles, and opens a new one for the next query", async () => {
    const applicationName = `tiehall probe ${randomBytes(4).toString("hex")}`;
    const lost: Error[] = [];
    const db = openDatabase({ connectionString: database.url }, { applicationName, onIdleError: (error) => lost.push(error) });
    try {
      await db.$client.query("SELECT 1");
      expect(db.$client.idleCount).toBe(1);
      expect(await endSessions(applicationName)).toBe(1);
      await until("the pool to hear of the lost connection", () => lost.length > 0);
      // 57P01: admin_shutdown, which a restart and pg_terminate_backend both send.
      expect(lost).toEqual([expect.objectContaining({ code: "57P01" })]);
      expect(db.$client.totalCount).toBe(0);
      expect((await db.$client.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    } finally {
      await db.$client.end();
    }
  });

  it("does not crash the process when the caller gives nothing to report the loss to", async () => {
    const applicationName = `tiehall probe ${randomBytes(4).toString("hex")}`;
    const child = spawn(process.execPath, [probe], {
      env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: database.url, APPLICATION_NAME: applicationName },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    let exitCode: number | null | undefined;
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => {
        exitCode = code;
        resolve(code);
      }),
    );
    try {
      await until("the probe's connection to idle", () => output.includes("probe: a connection is idle"));
      expect(await endSessions(applicationName)).toBe(1);
      await until(
        "the pool to drop the lost connection",
        () => output.includes("probe: the pool dropped a connection") || exitCode !== undefined,
      );
      // Whatever the loss set off in the probe has run by now.
      await sleep(200);
      if (exitCode === undefined) child.stdin.write("go on\n");
      expect(await exited, output).toBe(0);
      expect(output).toContain('probe: the next query answered [{"one":1}]');
      expect(output).not.toMatch(/Unhandled 'error' event/);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

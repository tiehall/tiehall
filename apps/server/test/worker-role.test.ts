import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messagePosted } from "@tiehall/core";
import {
  createLogger,
  migrate,
  openDatabase,
  openJobQueue,
  write,
  type Database,
  type DatabaseConnection,
  type JobQueue,
} from "@tiehall/commands";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { probeFailing, probeSlow } from "./support/worker-with-probe-job.ts";

// The worker role stops gracefully on SIGTERM (self-host-install: A restart
// stops the app gracefully). Docker sends SIGTERM when Compose stops or
// replaces the app container. The worker then takes no new job, lets active
// jobs finish within its stop timeout, releases the rest and exits 0; a job it
// released runs again once the worker is back. Everything it logs is JSON on
// standard output, with ids and never message text or credentials
// (self-host-install: Logs carry ids, never message text or credentials).

const fixture = fileURLToPath(new URL("./support/worker-with-probe-job.ts", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

let database: TestDatabase;
let owner: pg.Client;
let app: DatabaseConnection;
let db: Database;
let queue: JobQueue;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

interface Running {
  child: ChildProcess;
  /** Standard output and standard error together. */
  output: () => string;
  stdout: () => string;
  exited: Promise<number | null>;
}

/** The install settings an app role reads, apart from its database connection. */
const INSTALL = {
  TIEHALL_URL: "http://localhost:3000",
  TIEHALL_SECRET_KEY: randomBytes(32).toString("base64url"),
  TIEHALL_AUTH_SECRET: randomBytes(32).toString("base64url"),
};

/** Starts the fixture worker as the app role, the way the image starts `main.mjs worker`. */
function startWorkerRole(env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, [fixture], {
    env: {
      PATH: process.env["PATH"] ?? "",
      ...INSTALL,
      TIEHALL_DATABASE_APP_URL: app.connectionString,
      TIEHALL_DATABASE_APP_PASSWORD: app.password ?? "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, output: () => output, stdout: () => stdout, exited };
}

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, seconds = 30): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function jobs(queue = probeSlow.queue): Promise<{ id: string; state: string }[]> {
  return (
    await owner.query<{ id: string; state: string }>("SELECT id, state::text AS state FROM pgboss.job WHERE name = $1", [
      queue,
    ])
  ).rows;
}

/** The JSON log lines among a process's output, parsed. */
function logEntries(output: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  // The thread messages a later task adds, reduced to what the failing probe job reads.
  await owner.query(
    `CREATE TABLE probe_messages (org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), body text NOT NULL,
       PRIMARY KEY (org_id, id))`,
  );
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  app = { connectionString: url.toString(), password: appRole.password };
  db = openDatabase(app);
  queue = await openJobQueue({ connection: app, jobTypes: [probeSlow, probeFailing], logger: createLogger({ write: () => {} }) });
  await owner.query("INSERT INTO orgs (name) VALUES ('Acme')");
});

afterAll(async () => {
  await queue.stop();
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

describe("the worker role on SIGTERM", () => {
  it("releases the job it is running and exits 0, and the job runs again after the restart", async () => {
    const first = startWorkerRole();
    try {
      await until("the worker to start", () => (/worker: started/.test(first.output()) ? true : undefined));
      await write({ database: db, jobs: queue }, { actorKind: "system" }, async (writer) => {
        await writer.record(messagePosted, { requestId: randomUUID(), messageId: randomUUID() });
        await writer.enqueue(probeSlow, { requestId: randomUUID() });
      });
      const id = await until("the job to start", () => /probe: started (\S+)/.exec(first.output())?.[1]);

      first.child.kill("SIGTERM");
      expect(await first.exited).toBe(0);
      expect(logEntries(first.output())).toContainEqual(
        expect.objectContaining({
          level: "info",
          role: "worker",
          msg: "worker: stopped; released 1 active job, which runs again after the restart",
          released: [{ queue: probeSlow.queue, jobId: id }],
        }),
      );
      expect(await jobs()).toEqual([{ id, state: "retry" }]);

      const restarted = startWorkerRole({ PROBE_FINISH: "1" });
      try {
        await until("the released job to run again", () => (restarted.output().includes(`probe: started ${id}`) ? true : undefined));
        await until("the released job to complete", async () => ((await jobs())[0]?.state === "completed" ? true : undefined));
      } finally {
        restarted.child.kill("SIGTERM");
        expect(await restarted.exited).toBe(0);
      }
      expect(restarted.output()).toContain("worker: stopped");
    } finally {
      first.child.kill("SIGKILL");
    }
  });

  it("logs a failing job by its ids, and never the message text or the token it held", async () => {
    const text = `Please rotate the staging keys; canary-${randomBytes(8).toString("hex")}`;
    const token = `th_pat_${randomBytes(20).toString("hex")}`;
    const worker = startWorkerRole({ PROBE_TOKEN: token });
    let messageId = "";
    try {
      await until("the worker to start", () => (/worker: started/.test(worker.output()) ? true : undefined));
      await write({ database: db, jobs: queue }, { actorKind: "system" }, async (writer) => {
        const { rows } = await writer.tx.execute<{ id: string }>(
          `INSERT INTO probe_messages (org_id, body) VALUES ('${writer.orgId}', ${pg.escapeLiteral(text)}) RETURNING id`,
        );
        messageId = rows[0]?.id ?? "";
        await writer.record(messagePosted, { requestId: randomUUID(), messageId });
        await writer.enqueue(probeFailing, { messageId });
      });
      await until("the job to fail", async () => ((await jobs(probeFailing.queue))[0]?.state === "failed" ? true : undefined));
      await until("the failure to be logged", () => (/worker: job failed/.test(worker.output()) ? true : undefined));
    } finally {
      worker.child.kill("SIGTERM");
      await worker.exited;
    }
    const output = worker.output();
    expect(output).not.toContain(text);
    expect(output).not.toContain("canary-");
    expect(output).not.toContain(token);
    expect(output).not.toContain(token.slice("th_pat_".length));
    const [job] = await jobs(probeFailing.queue);
    expect(logEntries(output)).toContainEqual(
      expect.objectContaining({
        level: "error",
        role: "worker",
        msg: "worker: job failed",
        queue: probeFailing.queue,
        jobId: job?.id,
        ids: { messageId },
      }),
    );
    // Every line the worker wrote to standard output is one JSON object with a time, a level and a message.
    const lines = worker.stdout().split("\n").filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ time: expect.any(String), level: expect.any(String), msg: expect.any(String) });
    }
  });

  it("exits 1, saying why, when the job queue's schema is missing because migrate has not run", async () => {
    const empty = await createTestDatabase();
    try {
      const worker = spawn(process.execPath, [fixture], {
        env: { PATH: process.env["PATH"] ?? "", ...INSTALL, TIEHALL_DATABASE_APP_URL: empty.url },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      worker.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      worker.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => worker.on("exit", resolve));
      expect(code).toBe(1);
      expect(output).toContain("tiehall worker: failed to start: pg-boss is not installed");
    } finally {
      await empty.drop();
    }
  });
});

import { createServer, type Server, type Socket } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { openDatabaseHealth } from "../src/health.ts";

// The health check behind /healthz (self-host-install: `/healthz` answers only
// up or down): "up" while the app's database answers, and "down" when it does
// not, within a short timeout, so Docker's health check and an operator's
// monitor see a stopped database without the check hanging. A burst of checks
// shares one connection, so an unauthenticated caller cannot use /healthz to
// open connections to the database.

let database: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  admin = new pg.Client({ connectionString: new URL("/postgres", database.url).toString() });
  await admin.connect();
});

afterAll(async () => {
  await admin.query(`ALTER DATABASE ${pg.escapeIdentifier(databaseName())} ALLOW_CONNECTIONS true`);
  await admin.end();
  await database.drop();
});

function databaseName(): string {
  return new URL(database.url).pathname.slice(1);
}

/** Stops the database for the app: it refuses new connections and drops the ones open. */
async function stopDatabase(): Promise<void> {
  await admin.query(`ALTER DATABASE ${pg.escapeIdentifier(databaseName())} ALLOW_CONNECTIONS false`);
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [
    databaseName(),
  ]);
}

async function startDatabase(): Promise<void> {
  await admin.query(`ALTER DATABASE ${pg.escapeIdentifier(databaseName())} ALLOW_CONNECTIONS true`);
}

describe("the database health check", () => {
  it("is up while the database answers, down while it is stopped, and up again once it is back", async () => {
    const health = openDatabaseHealth({ connectionString: database.url });
    try {
      expect(await health.check()).toBe("up");
      await stopDatabase();
      expect(await health.check()).toBe("down");
      await startDatabase();
      expect(await health.check()).toBe("up");
    } finally {
      await health.close();
    }
  });

  it("is down, within its timeout, when nothing answers at the database's address", async () => {
    // A port that accepts connections and never answers, like a database host that has hung.
    const sockets = new Set<Socket>();
    const silent: Server = createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as { port: number };
    const health = openDatabaseHealth({ connectionString: `postgres://tiehall:x@127.0.0.1:${port}/tiehall` }, { timeoutMs: 300 });
    try {
      const started = Date.now();
      expect(await health.check()).toBe("down");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await health.close();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it("shares one connection among checks that arrive together", async () => {
    const health = openDatabaseHealth({ connectionString: database.url });
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => health.check()));
      expect(new Set(results)).toEqual(new Set(["up"]));
      const { rows } = await admin.query<{ count: string }>(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND application_name = 'tiehall health'",
        [databaseName()],
      );
      expect(Number(rows[0]?.count)).toBeLessThanOrEqual(1);
    } finally {
      await health.close();
    }
  });
});

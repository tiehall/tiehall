import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { inject } from "vitest";

/** The stock image the test suites run against: the same major version as production. */
export const POSTGRES_IMAGE = "postgres:17";

export interface StartedPostgres {
  /** A superuser connection URL for the container's default database. */
  readonly url: string;
  /** The container's id, for `docker exec`. */
  readonly containerId: string;
  stop(): Promise<void>;
}

export interface TestDatabase {
  /** A superuser connection URL for a database nothing else uses. */
  readonly url: string;
  drop(): Promise<void>;
}

/** Starts one Postgres 17 container. The global setup calls it once per Vitest project. */
export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  return {
    url: container.getConnectionUri(),
    containerId: container.getId(),
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * Creates a fresh, empty database in the project's container, so test files
 * running in parallel never see each other's tables. By default the container's
 * superuser owns it; `owner` names an existing role to own it instead. Roles
 * belong to the whole container, so tests that create roles give them unique names.
 */
export async function createTestDatabase(options: { owner?: string } = {}): Promise<TestDatabase> {
  const serverUrl = inject("postgresUrl");
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  const owner = options.owner === undefined ? "" : ` OWNER ${pg.escapeIdentifier(options.owner)}`;
  await runAsAdmin(serverUrl, `CREATE DATABASE ${name}${owner}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => runAsAdmin(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}

/**
 * Dumps a database of the project's container with pg_dump run inside the
 * container, as the release's backup.sh does: in pg_dump's custom format, or
 * as plain SQL to search.
 */
export function dumpDatabase(url: string, format: "custom" | "plain" = "custom"): Buffer {
  return dockerExec(["pg_dump", "--username", userOf(url), "--dbname", databaseOf(url), `--format=${format}`]);
}

/** Restores a custom-format dump into an empty database of the project's container, as restore.sh does. */
export function restoreDatabase(dump: Buffer, url: string): void {
  dockerExec(["pg_restore", "--username", userOf(url), "--dbname", databaseOf(url), "--exit-on-error"], dump);
}

function dockerExec(command: string[], input?: Buffer): Buffer {
  const run = spawnSync("docker", ["exec", ...(input === undefined ? [] : ["--interactive"]), inject("postgresContainer"), ...command], {
    ...(input === undefined ? {} : { input }),
    maxBuffer: 512 * 1024 * 1024,
    timeout: 120_000,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command[0]} exited with ${run.status}: ${run.stderr.toString()}`);
  return run.stdout;
}

function userOf(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

async function runAsAdmin(serverUrl: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

declare module "vitest" {
  export interface ProvidedContext {
    postgresUrl: string;
    postgresContainer: string;
  }
}

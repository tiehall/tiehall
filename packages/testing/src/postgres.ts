import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { inject } from "vitest";

/** The stock image the test suites run against: the same major version as production. */
export const POSTGRES_IMAGE = "postgres:17";

export interface StartedPostgres {
  /** A superuser connection URL for the container's default database. */
  readonly url: string;
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
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * Creates a fresh, empty database in the project's container, so test files
 * running in parallel never see each other's tables.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const serverUrl = inject("postgresUrl");
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  await runAsAdmin(serverUrl, `CREATE DATABASE ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => runAsAdmin(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
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
  }
}

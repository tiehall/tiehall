import type { TestProject } from "vitest/node";
import { startPostgres } from "./postgres.ts";

/**
 * Vitest global setup: one Postgres 17 container per project run. A package
 * opts in by listing this file under `globalSetup` in its vitest.config.ts,
 * and its tests call createTestDatabase().
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const postgres = await startPostgres();
  project.provide("postgresUrl", postgres.url);
  return () => postgres.stop();
}

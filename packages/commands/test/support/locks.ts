import pg from "pg";

// Row locks held from a test, as a slow write in flight holds them, so that two
// writes of the install overlap every time a test runs them, not by chance.

/** A row lock a test holds on its own connection until it lets it go. */
export interface HeldRow {
  release(): Promise<void>;
}

/**
 * Takes a row lock on a connection of its own, as the database owner, inside a
 * transaction that stays open until release(); the statement must lock
 * exactly one row.
 */
export async function holdRow(databaseUrl: string, statement: string, parameters: unknown[] = []): Promise<HeldRow> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(statement, parameters);
    if (rowCount !== 1) throw new Error(`the statement to hold locked ${rowCount} rows, not one`);
  } catch (error) {
    await client.end();
    throw error;
  }
  return {
    async release() {
      try {
        await client.query("COMMIT");
      } finally {
        await client.end();
      }
    },
  };
}

/**
 * How many transactions of this database wait for a lock now. pg_locks and
 * pg_blocking_pids() are live, where pg_stat_activity would show the snapshot
 * a transaction took.
 */
export async function waitingNow(owner: pg.Client): Promise<number> {
  const { rows } = await owner.query<{ waiting: number }>(
    `SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks
      WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND cardinality(pg_blocking_pids(pid)) > 0`,
  );
  return rows[0]?.waiting ?? 0;
}

/**
 * Waits until at least this many transactions wait for a lock, so the calls
 * under test are inside their writes, or until `done` says a call finished
 * without waiting; fails after 10 seconds.
 */
export async function untilWaiting(owner: pg.Client, count: number, done: () => boolean = () => false): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (done() || (await waitingNow(owner)) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fewer than ${count} transactions waited for a lock within 10 seconds`);
}

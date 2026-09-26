import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { migrate, openDatabase, takeEventNumber, withOrg, type Database, type OrgContext } from "../src/index.ts";

// The event sequence (requests: The event log; design.md, Technical decisions:
// T5). Each event takes the next number from one counter row, which stays
// locked until the writing transaction ends. A writer that took number N holds
// every later writer until it commits or rolls back, so numbers follow commit
// order and a rolled-back number is taken again: the sequence has no gaps, and
// a reader that has seen event N never later finds an unseen event numbered N
// or lower. Task 4.8 defines the event table; the writers here record their
// numbers in a probe table the way they will write events.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await owner.query(
    `CREATE TABLE probe_events (org_id uuid NOT NULL, number bigint NOT NULL, PRIMARY KEY (org_id, number));
     CREATE TABLE probe_serial (id bigserial PRIMARY KEY);`,
  );
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  await owner.query("DELETE FROM probe_events; DELETE FROM event_sequence");
});

/** Writes one probe event with the next number, as the write path will write an event. */
async function writeEvent(context: OrgContext): Promise<number> {
  const number = await takeEventNumber(context);
  await context.tx.execute(`INSERT INTO probe_events (org_id, number) VALUES ('${context.orgId}', ${number})`);
  return number;
}

/** A reader that polls for events and remembers every number it has seen. */
function reader(table: string, column: string) {
  const seen = new Set<number>();
  let highest = 0;
  const skipped: number[] = [];
  return {
    seen,
    skipped,
    async poll(): Promise<void> {
      const { rows } = await owner.query<{ number: string }>(`SELECT ${column} AS number FROM ${table} ORDER BY 1`);
      for (const number of rows.map((row) => Number(row.number))) {
        if (seen.has(number)) continue;
        // An unseen number at or below one already seen: an event the reader's cursor has passed.
        if (number <= highest) skipped.push(number);
        seen.add(number);
        highest = Math.max(highest, number);
      }
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Whether a promise is still pending after a short while. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => false), new Promise<boolean>((done) => setTimeout(() => done(true), 300))]);
}

describe("the event sequence", () => {
  it("makes a writer that commits late hold the next writer, so a reader never skips it", async () => {
    const events = reader("probe_events", "number");
    const releaseFirst = deferred();
    const tookFirst = deferred();
    const first = withOrg(db, async (context) => {
      const number = await writeEvent(context);
      tookFirst.resolve();
      await releaseFirst.promise;
      return number;
    });
    // If the first writer fails before it took its number, this fails with it rather than waiting forever.
    await Promise.race([tookFirst.promise, first]);
    const second = withOrg(db, writeEvent);

    // The second writer waits on the counter row the first one holds; nothing is visible yet.
    expect(await stillPending(second)).toBe(true);
    await events.poll();
    expect([...events.seen]).toEqual([]);

    releaseFirst.resolve();
    expect(await first).toBe(1);
    await events.poll();
    expect(await second).toBe(2);
    await events.poll();
    expect([...events.seen]).toEqual([1, 2]);
    expect(events.skipped).toEqual([]);
  });

  it("would let a reader skip a late commit if numbers came from a plain sequence, as bigserial ids do", async () => {
    // The alternative T5 rejects, shown with the same reader: the second writer is not held, so it commits first.
    const ids = reader("probe_serial", "id");
    const releaseFirst = deferred();
    const tookFirst = deferred();
    const first = withOrg(db, async ({ tx }) => {
      await tx.execute("INSERT INTO probe_serial DEFAULT VALUES");
      tookFirst.resolve();
      await releaseFirst.promise;
    });
    await Promise.race([tookFirst.promise, first]);
    await withOrg(db, async ({ tx }) => {
      await tx.execute("INSERT INTO probe_serial DEFAULT VALUES");
    });
    await ids.poll();
    releaseFirst.resolve();
    await first;
    await ids.poll();
    expect(ids.skipped).toEqual([1]);
  });

  it("gives concurrent writers a gap-free sequence, with rolled-back numbers taken again, that readers never skip", async () => {
    const events = reader("probe_events", "number");
    let polling = true;
    const polls = (async () => {
      while (polling) await events.poll();
    })();
    const writers = Array.from({ length: 8 }, (_, writer) =>
      (async () => {
        let committed = 0;
        for (let round = 0; round < 12; round++) {
          const rollBack = (writer + round) % 5 === 0;
          try {
            await withOrg(db, async (context) => {
              await writeEvent(context);
              // Commit at uneven times, so writers finish out of the order they started in.
              await context.tx.execute("SELECT pg_sleep(random() * 0.004)");
              if (rollBack) throw new Error("rolled back on purpose");
            });
            committed++;
          } catch (error) {
            if (!rollBack) throw error;
          }
        }
        return committed;
      })(),
    );
    const committed = (await Promise.all(writers)).reduce((sum, count) => sum + count, 0);
    polling = false;
    await polls;
    await events.poll();

    const { rows } = await owner.query<{ number: string }>("SELECT number FROM probe_events ORDER BY number");
    expect(rows.map(({ number }) => Number(number))).toEqual(Array.from({ length: committed }, (_, index) => index + 1));
    expect((await owner.query("SELECT last_number FROM event_sequence")).rows).toEqual([{ last_number: String(committed) }]);
    expect(events.skipped).toEqual([]);
    expect(events.seen.size).toBe(committed);
  });

  it("keeps one counter row for the install's org", async () => {
    await withOrg(db, writeEvent);
    await withOrg(db, writeEvent);
    const { rows } = await owner.query("SELECT o.name, s.last_number FROM event_sequence s JOIN orgs o ON o.id = s.org_id");
    expect(rows).toEqual([{ name: "Acme", last_number: "2" }]);
  });
});

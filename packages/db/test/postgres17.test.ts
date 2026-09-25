import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";

describe("the shared Postgres test harness", () => {
  let database: TestDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    database = await createTestDatabase();
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await database.drop();
  });

  it("runs Postgres 17", async () => {
    const { rows } = await client.query<{ server_version_num: string }>("SHOW server_version_num");
    expect(Math.floor(Number(rows[0]?.server_version_num) / 10_000)).toBe(17);
  });

  it("writes and reads back a row", async () => {
    await client.query("CREATE TABLE sample (id integer PRIMARY KEY, note text NOT NULL)");
    await client.query("INSERT INTO sample (id, note) VALUES ($1, $2)", [1, "hello"]);
    const { rows } = await client.query("SELECT note FROM sample WHERE id = 1");
    expect(rows).toEqual([{ note: "hello" }]);
  });

  it("gives each createTestDatabase() call its own database", async () => {
    await client.query("CREATE TABLE isolation_probe (id integer)");
    const other = await createTestDatabase();
    const otherClient = new pg.Client({ connectionString: other.url });
    await otherClient.connect();
    try {
      const { rows } = await otherClient.query("SELECT to_regclass('public.isolation_probe') AS found");
      expect(rows).toEqual([{ found: null }]);
    } finally {
      await otherClient.end();
      await other.drop();
    }
  });
});

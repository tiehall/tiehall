// Run as its own process by connection.test.ts: opens the app's pool the way
// the web and worker roles do, runs one query so a connection sits idle in the
// pool, and says so. The test then ends that connection from the database's
// side, as a database restart does, and writes a line to this process's
// standard input, on which it runs a second query and exits 0. A pool that
// lets the lost connection's error go unheard crashes the process instead.
import process from "node:process";
import { openDatabase } from "../../src/connection.ts";

const database = openDatabase(
  { connectionString: process.env["DATABASE_URL"] ?? "" },
  { applicationName: process.env["APPLICATION_NAME"] ?? "" },
);
database.$client.on("remove", () => process.stdout.write("probe: the pool dropped a connection\n"));
await database.$client.query("SELECT 1");
process.stdout.write("probe: a connection is idle\n");
process.stdin.once("data", () => {
  void (async () => {
    const { rows } = await database.$client.query<{ one: number }>("SELECT 1 AS one");
    process.stdout.write(`probe: the next query answered ${JSON.stringify(rows)}\n`);
    await database.$client.end();
    process.stdin.destroy();
  })();
});

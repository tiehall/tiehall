import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { reconcileGitHub, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// The organizations Tiehall saw a member in keep to the lock order
// (event-sequence.ts; sign-in: Leaving the GitHub organization ends access;
// teams-and-roles: Removing a member; design.md, Technical decisions: T5). A
// departure check that finds a member still in their organizations records
// each organization that reports them, adding the ones it had not seen them
// in; an admin removal locks the member's row and deletes it, which deletes
// those records too. Each writer of the records locks the member's row first,
// and writes nothing once the member is gone, so the two take their turns
// instead of waiting on each other. The pair runs here in both orders, as in
// proposal-locks.test.ts: the test holds the member's row, as a write in
// flight would, lets the first write line up behind it, then the second, and
// lets go, so the two take their turns in the order they arrived.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let pia: WebSessionCaller;

beforeEach(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["root-acme", "lee-acme"]) stub.addUser({ login });
  stub.addOrg({ login: "acme", members: { "root-acme": "admin", "lee-acme": "member" } });
  stub.addOrg({ login: "acme-labs", members: { "root-acme": "admin" } });
  harness = await startSignIn(install, stub);
  stub.updateApp(harness.app, { public: true });
  // acme is installed first, so a departure check asks it, and records it, first.
  await stub.install(harness.app, { account: "acme" });
  await stub.install(harness.app, { account: "acme-labs" });
  await harness.connect("acme", "acme-labs");
  install.useGitHub(harness.github);
  pia = sessionOf(await addUser(install.owner, { login: "pia", role: "admin" }));
}, 60_000);

afterEach(async () => {
  await stub?.close();
  await install?.close();
});

/** Holds a row's lock, as a write in flight holds it, until the returned function lets it go. */
async function hold(sql: string, ...params: unknown[]): Promise<() => Promise<void>> {
  await install.owner.query("BEGIN");
  const { rowCount } = await install.owner.query(sql, params);
  expect(rowCount, "the row to hold").toBe(1);
  return async () => {
    await install.owner.query("COMMIT");
  };
}

/** How many transactions of this database wait for a lock now. */
async function waiting(): Promise<number> {
  const { rows } = await install.owner.query<{ waiting: number }>(
    `SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks
      WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND cardinality(pg_blocking_pids(pid)) > 0`,
  );
  return rows[0]?.waiting ?? 0;
}

/** Starts a call and returns once it waits for a lock behind the calls lined up before it, or once it has finished. */
async function lineUp<T>(call: () => Promise<T>, behind: number): Promise<{ answer: Promise<T> }> {
  const inFlight = call();
  let finished = false;
  const settle = () => {
    finished = true;
  };
  inFlight.then(settle, settle);
  const deadline = Date.now() + 30_000;
  while (!finished && (await waiting()) <= behind) {
    if (Date.now() > deadline) throw new Error(`The call neither waited for a lock behind ${behind} others nor finished within 30 seconds.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { answer: inFlight };
}

/** Runs two calls at once in a set order, behind a held row; the answers come in the calls' order. */
async function inTurn<A, B>(row: [sql: string, ...params: unknown[]], first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const release = await hold(...row);
  let lined: [Promise<A>, Promise<B>];
  try {
    const { answer } = await lineUp(first, 0);
    lined = [answer, (await lineUp(second, 1)).answer];
  } finally {
    await release();
  }
  return Promise.all(lined);
}

/** The 15-minute reconciliation, as the worker runs it: a departure check of every member seen in an organization. */
async function reconcile(): Promise<"done"> {
  await reconcileGitHub.handle(
    { id: randomUUID(), queue: reconcileGitHub.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github: harness.github, execute: install.execute, jobs: { send: async () => undefined } },
  );
  return "done";
}

async function seenIn(userId: string): Promise<number> {
  return Number((await install.owner.query("SELECT count(*) AS n FROM member_organizations WHERE user_id = $1", [userId])).rows[0].n);
}

describe("a departure check that records a member's organizations, and an admin removal of that member, at once", () => {
  for (const order of ["the check first", "the removal first"] as const) {
    it(`take their turns with ${order}: neither fails, and the member is gone with every record of their organizations`, { timeout: 60_000 }, async () => {
      // Lee joined through acme; since then acme-labs reports Lee a member too, so the check adds that record.
      const { response, jar } = await harness.signIn("lee-acme");
      expect(response.status).toBe(302);
      const lee = (await harness.sessionOf(jar))!.userId;
      await stub.addMember("acme-labs", "lee-acme", "member", { delivery: "none" });
      expect(await seenIn(lee)).toBe(1);

      const remove = async () => (await install.confirm(pia, "members.remove", { userId: lee })).status;
      const row: [string, string] = ["SELECT 1 FROM members WHERE user_id = $1 FOR UPDATE", lee];
      const [checked, removed] =
        order === "the check first"
          ? await inTurn(row, reconcile, remove)
          : (await inTurn(row, remove, reconcile)).reverse() as ["done", number];

      expect(checked).toBe("done");
      expect(removed).toBe(200);
      expect((await install.owner.query("SELECT 1 FROM members WHERE user_id = $1", [lee])).rows).toEqual([]);
      expect(await seenIn(lee)).toBe(0);
    });
  }
});

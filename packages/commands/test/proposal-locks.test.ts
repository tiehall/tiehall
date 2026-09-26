import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf, type ApiAnswer } from "./support/requests.ts";

// Changes to a proposal and to its request take their locks in one order
// (requests: A confirmed commitment applies only if the request still allows
// it; requests: How a proposal ends without taking effect; design.md,
// Technical decisions: T5). A confirmation, a rejection, a withdrawal and an
// undo lock the request first and then the proposal, as a change to the
// request that cancels its proposals does, so two of them at once take turns
// instead of waiting on each other: neither fails, and the one that comes
// second sees what the first did. Each pair runs here in both orders: the test
// holds the row both calls need, as a write in flight would, lets the first
// call line up behind it, then the second, and lets go, so the two take their
// turns in the order they arrived, whatever the machine's timing.

let install: TestInstall;
let alice: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
});

afterAll(async () => {
  await install.close();
});

/** Holds a row's lock, as a write in flight holds it, until the returned function lets it go; calls made meanwhile line up behind it. */
async function hold(sql: string, ...params: unknown[]): Promise<() => Promise<void>> {
  await install.owner.query("BEGIN");
  const { rowCount } = await install.owner.query(sql, params);
  expect(rowCount, "the row to hold").toBe(1);
  return async () => {
    await install.owner.query("COMMIT");
  };
}

/**
 * How many transactions of this database wait for a lock now: those that hold
 * a lock in it and are blocked. pg_locks and pg_blocking_pids() are live,
 * where pg_stat_activity would show the snapshot the holding transaction took.
 */
async function waiting(): Promise<number> {
  const { rows } = await install.owner.query<{ waiting: number }>(
    `SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks
      WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND cardinality(pg_blocking_pids(pid)) > 0`,
  );
  return rows[0]?.waiting ?? 0;
}

/**
 * Starts a call and returns once it waits for a lock behind the calls lined
 * up before it, or once it has finished; fails after 10 seconds. The call's
 * answer comes wrapped, since a promise returned as is would be waited for.
 */
async function lineUp<T>(call: () => Promise<T>, behind: number): Promise<{ answer: Promise<T> }> {
  const inFlight = call();
  let finished = false;
  const settle = () => {
    finished = true;
  };
  inFlight.then(settle, settle);
  const deadline = Date.now() + 10_000;
  while (!finished && (await waiting()) <= behind) {
    if (Date.now() > deadline) throw new Error(`The call neither waited for a lock behind ${behind} others nor finished within 10 seconds.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { answer: inFlight };
}

/**
 * Runs two calls at once in a set order: holds the row both need, lets the
 * first call line up behind it, then the second, and lets go; the answers
 * come in the calls' order.
 */
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

type Revised = ApiAnswer & { headers: Headers };

describe("the last confirmation and a new revision at once", () => {
  it("take their turns in the order they arrive: neither fails, and the second sees what the first did", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 8; round += 1) {
      const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
      await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
      const proposal = (
        await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
          body: { packet: { ...packetOf(), untrusted: { need: "A scope change." } } },
          headers: { "if-match": '"1"' },
        })
      ).body.proposal.id;
      expect((await install.confirm(sessionOf(alice), "proposals.confirm", { proposal })).status).toBe(200);
      const links = [{ url: `https://wiki.example.com/${round}` }];
      const link = { ...packetOf(), untrusted: { ...(packetOf()["untrusted"] as object), links } };
      // Bob's confirmation is the last one the scope change needs; the revision, a link, is based on revision 1 too.
      const confirm = await install.prepareConfirmation(sessionOf(bob), "proposals.confirm", { proposal });
      const revise = () =>
        sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, { body: { packet: link }, headers: { "if-match": '"1"' } });
      const row: [string, string] = ["SELECT id FROM requests WHERE id = $1 FOR UPDATE", request.id];
      let confirmed: Response;
      let revised: Revised;
      if (round % 2 === 0) [confirmed, revised] = await inTurn(row, confirm, revise);
      else [revised, confirmed] = await inTurn(row, revise, confirm);
      const packet = (await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}/packet`)).body;
      const [stored] = (await install.owner.query<{ state: string; reason: string | null }>("SELECT state, cancel_reason AS reason FROM proposals WHERE id = $1", [proposal])).rows;
      if (round % 2 === 0) {
        // The confirmation applied the scope change as revision 2, so the revision, based on revision 1, is out of date.
        expect(confirmed.status).toBe(200);
        expect(revised.status).toBe(412);
        expect(packet).toMatchObject({ revision: 2, packet: { untrusted: { need: "A scope change." } } });
        expect(stored).toEqual({ state: "applied", reason: null });
      } else {
        // The revision came first and cancelled the proposal as stale, so the confirmation finds it ended.
        expect(revised.status).toBe(200);
        expect(confirmed.status).toBe(409);
        expect(packet).toMatchObject({ revision: 2, packet: { untrusted: { links } } });
        expect(stored).toEqual({ state: "cancelled", reason: "stale" });
      }
      outcomes.add(`${confirmed.status} ${revised.status}`);
    }
    expect([...outcomes].sort()).toEqual(["200 412", "409 200"]);
  }, 60_000);
});

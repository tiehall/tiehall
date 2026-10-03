import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireProposals } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequestInTheWebUi, packetOf, sendApi, sessionOf, tokenOf, type ApiAnswer } from "./support/requests.ts";

// Every write that touches proposals takes its locks in one order
// (requests: A confirmed commitment applies only if the request still allows
// it; requests: How a proposal ends without taking effect; requests: A removed
// member's claims stay and their proposals are cancelled; design.md, Technical
// decisions: T5): the request's row, then its proposals, then, with its first
// event, the org's event counter, which it holds until it commits; nothing is
// locked after that. A confirmation, a rejection, a withdrawal, an undo, a new
// revision, a removal and the expiry job all keep to it, so two of them at
// once take turns instead of waiting on each other: neither fails, and the
// one that comes second sees what the first did. Each pair runs here in both
// orders: the test holds the row both calls need, as a write in flight would,
// lets the first call line up behind it, then the second, and lets go, so the
// two take their turns in the order they arrived, whatever the machine's
// timing.

let install: TestInstall;
let clock = new Date("2026-10-01T09:00:00Z");
let fe: string;
let alice: string;
let bob: string;
let pia: string;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const be = await addTeam(install.owner, "BE");
  fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
});

const at = (time: string) => {
  clock = new Date(time);
};

/** Runs the expiry job once, by the worker's clock. */
function runExpiry(time: string): Promise<void> {
  return expireProposals.handle(
    { id: "expire", queue: expireProposals.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(time) },
  );
}

/** A proposal's state and, when cancelled, the reason, as stored. */
async function stateOf(proposal: string): Promise<{ state: string; reason: string | null }> {
  const { rows } = await install.owner.query<{ state: string; reason: string | null }>("SELECT state, cancel_reason AS reason FROM proposals WHERE id = $1", [proposal]);
  return rows[0] ?? { state: "missing", reason: null };
}

/** The org's event counter, which a write holds from its first event until it commits. */
const COUNTER: [string] = ["SELECT last_number FROM event_sequence WHERE org_id = (SELECT id FROM orgs) FOR UPDATE"];

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
 * up before it, or once it has finished; fails after 30 seconds. The call's
 * answer comes wrapped, since a promise returned as is would be waited for.
 */
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
      const request = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
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
      const stored = await stateOf(proposal);
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

describe("a removal and a confirmation at once", () => {
  it("take their turns: the removal cancels the member's proposal, or finds it applied, and neither fails", async () => {
    at("2026-10-01T09:00:00Z");
    for (let round = 0; round < 8; round += 1) {
      const carol = await addUser(install.owner, { login: `carol${round}` });
      await joinTeams(install.owner, carol, fe);
      const request = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
      const proposal = (await callApi(install, tokenOf(carol), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
      const confirm = await install.prepareConfirmation(sessionOf(carol), "proposals.confirm", { proposal });
      const remove = await install.prepareConfirmation(sessionOf(pia), "members.remove", { userId: carol });
      let confirmed: Response;
      let removed: Response;
      if (round % 2 === 0) [removed, confirmed] = await inTurn(COUNTER, remove, confirm);
      else [confirmed, removed] = await inTurn(COUNTER, confirm, remove);
      expect(removed.status).toBe(200);
      const { state } = (await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}`)).body;
      if (round % 2 === 0) {
        // The removal cancelled the proposal; the confirmation, whose membership re-check came before the removal, finds it ended.
        expect(confirmed.status).toBe(409);
        expect(await stateOf(proposal)).toEqual({ state: "cancelled", reason: "accountable_removed" });
        expect(state).toBe("open");
      } else {
        // The confirmation applied the decline; the removal then found no pending proposal of Carol's.
        expect(confirmed.status).toBe(200);
        expect(await stateOf(proposal)).toEqual({ state: "applied", reason: null });
        expect(state).toBe("declined");
      }
    }
  }, 120_000);
});

describe("expiry and a new revision at once", () => {
  it("take their turns: the proposal ends as stale or as expired, and neither fails", async () => {
    for (let round = 0; round < 8; round += 1) {
      at("2026-10-01T09:00:00Z");
      const request = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
      await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
      const proposal = (
        await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
          body: { packet: { ...packetOf(), untrusted: { need: "A scope change." } } },
          headers: { "if-match": '"1"' },
        })
      ).body.proposal.id;
      const links = [{ url: `https://wiki.example.com/expiry/${round}` }];
      const link = { ...packetOf(), untrusted: { ...(packetOf()["untrusted"] as object), links } };
      const expire = () => runExpiry("2026-10-08T09:01:00Z");
      const revise = () =>
        sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, { body: { packet: link }, headers: { "if-match": '"1"' } });
      let revised: Revised;
      if (round % 2 === 0) [revised] = await inTurn(COUNTER, revise, expire);
      else [, revised] = await inTurn(COUNTER, expire, revise);
      expect(revised.status).toBe(200);
      expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}/packet`)).body).toMatchObject({ revision: 2, packet: { untrusted: { links } } });
      if (round % 2 === 0) {
        // The revision came first and cancelled the proposal as stale; expiry found the request in use and left it to its next run.
        expect(await stateOf(proposal)).toEqual({ state: "cancelled", reason: "stale" });
        await runExpiry("2026-10-08T09:02:00Z");
        expect(await stateOf(proposal)).toEqual({ state: "cancelled", reason: "stale" });
      } else {
        // Expiry came first; the revision then had nothing to cancel.
        expect(await stateOf(proposal)).toEqual({ state: "expired", reason: null });
      }
    }
  }, 120_000);
});

describe("expiry and the last confirmation at once", () => {
  it("take their turns: the other proposal ends as cancelled or as expired, and neither fails", async () => {
    for (let round = 0; round < 8; round += 1) {
      at("2026-10-01T09:00:00Z");
      const request = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
      // The due date's 7 days end at 09:00 on the 8th; the decline's, proposed an hour later, at 10:00.
      const dueDate = (
        await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
          body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
          headers: { "if-match": '"1"' },
        })
      ).body.proposal.id;
      at("2026-10-01T10:00:00Z");
      await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
      const decline = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
      at("2026-10-08T09:30:00Z");
      const confirm = await install.prepareConfirmation(sessionOf(bob), "proposals.confirm", { proposal: decline });
      const expire = () => runExpiry("2026-10-08T09:30:00Z");
      let confirmed: Response;
      if (round % 2 === 0) [confirmed] = await inTurn(COUNTER, confirm, expire);
      else [, confirmed] = await inTurn(COUNTER, expire, confirm);
      expect(confirmed.status).toBe(200);
      expect(await stateOf(decline)).toEqual({ state: "applied", reason: null });
      expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}`)).body.state).toBe("declined");
      if (round % 2 === 0) {
        // The decline came first and cancelled the due date; expiry found the request in use and left it to its next run.
        expect(await stateOf(dueDate)).toEqual({ state: "cancelled", reason: "terminal_state" });
        await runExpiry("2026-10-08T09:31:00Z");
        expect(await stateOf(dueDate)).toEqual({ state: "cancelled", reason: "terminal_state" });
      } else {
        // Expiry came first; the decline then had nothing left to cancel.
        expect(await stateOf(dueDate)).toEqual({ state: "expired", reason: null });
      }
    }
  }, 120_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storePacketRevision, write } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Proposed packet changes record their base revision and go stale
// (handoff-packet: Packet changes that are commitments; requests: How a
// proposal ends without taking effect; design.md, Decisions this change rests
// on: D30 (4)). A proposed due date or scope change records the revision it
// was based on. As soon as the request's current revision moves past it,
// whoever or whatever added the new revision, Tiehall cancels the proposal as
// stale, with an event that names it as cancelled, so what a person confirms is
// always what they reviewed, and the change has to be proposed again on the
// current revision. Other proposals, such as a decline, are not packet changes
// and stay pending.

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

function packetWith(untrusted: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> {
  const packet = packetOf();
  return { ...packet, ...top, untrusted: { ...(packet["untrusted"] as object), ...untrusted } };
}

const addRevision = (user: string, key: string, packet: unknown, revision: number) =>
  sendApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/packet/revisions`, { body: { packet }, headers: { "if-match": `"${revision}"` } });

/** The request's proposals as stored, oldest first, and the endings its events name. */
async function proposalsOf(requestId: string) {
  const { rows } = await install.owner.query(
    `SELECT id, kind, state, base_revision AS "baseRevision", cancel_reason AS "cancelReason", ended_at IS NOT NULL AS ended
       FROM proposals WHERE request_id = $1 ORDER BY created_at, id`,
    [requestId],
  );
  const endings = await install.owner.query(
    `SELECT data->>'proposalId' AS "proposalId", data->>'how' AS how, data->>'reason' AS reason, class
       FROM events WHERE type = 'proposal.ended' AND data->>'requestId' = $1 ORDER BY number`,
    [requestId],
  );
  return { proposals: rows, endings: endings.rows };
}

/** A claimed request with a pending acceptance-criteria change, a pending due date and a pending decline, all on revision 1. */
async function claimedWithProposals() {
  const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
  const scope = await addRevision(alice, request.key, packetWith({ acceptance_criteria: ["New criteria."] }), 1);
  const dueDate = await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-15" }), 1);
  const decline = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
  expect([scope.status, dueDate.status, decline.status]).toEqual([202, 202, 202]);
  return { request, scope: scope.body.proposal.id as string, dueDate: dueDate.body.proposal.id as string, decline: decline.body.proposal.id as string };
}

describe("a proposed packet change", () => {
  it("records the revision it was based on", async () => {
    const { request } = await claimedWithProposals();
    const { proposals } = await proposalsOf(request.id);
    expect(proposals.map(({ kind, baseRevision }) => [kind, baseRevision])).toEqual([
      ["scope", 1],
      ["due_date", 1],
      ["decline", null],
    ]);
  });

  it("is cancelled as stale at once when a revision the requester adds moves the request past its base", async () => {
    const { request, scope, dueDate, decline } = await claimedWithProposals();
    const link = await addRevision(alice, request.key, packetWith({ links: [{ url: "https://wiki.example.com/dark" }] }), 1);
    expect(link.status).toBe(200);
    expect(link.body.revision).toBe(2);
    const { proposals, endings } = await proposalsOf(request.id);
    expect(proposals.map(({ id, state, cancelReason, ended }) => ({ id, state, cancelReason, ended }))).toEqual([
      { id: scope, state: "cancelled", cancelReason: "stale", ended: true },
      { id: dueDate, state: "cancelled", cancelReason: "stale", ended: true },
      { id: decline, state: "pending", cancelReason: null, ended: false },
    ]);
    expect(endings).toEqual([
      { proposalId: scope, how: "cancelled", reason: "stale", class: "domain" },
      { proposalId: dueDate, how: "cancelled", reason: "stale", class: "domain" },
    ]);
  });

  it("is cancelled as stale when a contract report's revision, a system write, moves the request past its base", async () => {
    const { request, scope, dueDate } = await claimedWithProposals();
    const store = { database: install.db, jobs: { send: async () => {} } };
    await write(store, { actorKind: "system", surface: "github" }, (writer) => storePacketRevision(writer, request.id, packetOf("From a contract report.") as never));
    const { proposals } = await proposalsOf(request.id);
    expect(proposals.filter(({ state }) => state === "cancelled").map(({ id }) => id)).toEqual([scope, dueDate]);
  });

  it("based on the current revision is kept while no newer revision comes", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect((await addRevision(alice, request.key, packetWith({ need: "Changed before the claim." }), 1)).status).toBe(200);
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const scope = await addRevision(alice, request.key, packetWith({ need: "Changed after the claim." }), 2);
    expect(scope.status).toBe(202);
    const { proposals } = await proposalsOf(request.id);
    expect(proposals).toMatchObject([{ kind: "scope", state: "pending", baseRevision: 2 }]);
  });

  // Committed as an expected failure until task 14.8 builds the confirmation of a proposal.
  it.fails("is cancelled when another proposal on its base takes effect first, and confirming it then gets 409 and adds no revision", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    for (const [revision, link] of [[1, "a"], [2, "b"]] as const) {
      await addRevision(alice, request.key, packetWith({ links: [{ url: `https://wiki.example.com/${link}` }] }), revision);
    }
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const criteria = (await addRevision(alice, request.key, packetWith({ acceptance_criteria: ["New criteria."] }), 3)).body.proposal.id;
    const dueDate = (await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-15" }), 3)).body.proposal.id;

    for (const [user, proposal] of [[alice, dueDate], [bob, dueDate]] as const) {
      expect((await install.confirm(sessionOf(user), "proposals.confirm", { proposal })).status).toBe(200);
    }
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}/packet`)).body).toMatchObject({
      revision: 4,
      packet: { due_date: "2026-10-15" },
    });
    const { proposals } = await proposalsOf(request.id);
    expect(proposals.find(({ id }) => id === criteria)).toMatchObject({ state: "cancelled", cancelReason: "stale" });

    const refused = await install.confirm(sessionOf(alice), "proposals.confirm", { proposal: criteria });
    expect(refused.status).toBe(409);
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}/packet`)).body.revision).toBe(4);
  });
});

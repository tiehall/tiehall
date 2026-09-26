import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Commitments become proposals (requests: Commitments become proposals;
// handoff-packet: Packet changes that are commitments; requests: Which side
// may act on a request; design.md, Decisions this change rests on: D23, D28
// #14, #15). A commitment started for a user, by an agent on any surface or by
// a person in the web UI, is not applied: execute() creates a proposal
// instead, with that user as its accountable human, and the request is left
// as it was. Declining and marking done through set_status are commitments;
// so are setting or moving the due date after the request was opened, and
// changing its scope, the need, the acceptance criteria or the contract
// section, while it is claimed. A due date in the packet a request is opened
// with, and a scope change while it is unclaimed, apply at once. The side
// rules and the state machine still refuse, with 403 and 409, a commitment the
// caller's side or the request's state does not allow, and then create no
// proposal.

let install: TestInstall;
let alice: string;
let bob: string;
let carol: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const ops = await addTeam(install.owner, "OPS");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  carol = await addUser(install.owner, { login: "carol" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, carol, ops);
});

afterAll(async () => {
  await install.close();
});

/** A packet with these fields under untrusted, and these at its top level, on top of the smallest one. */
function packetWith(untrusted: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> {
  const packet = packetOf();
  return { ...packet, ...top, untrusted: { ...(packet["untrusted"] as object), ...untrusted } };
}

/** The request as stored: its state and claimant, its revisions, its proposals and the types of its events, in order. */
async function stored(requestId: string) {
  const { rows } = await install.owner.query<{ state: string; claimant: string | null; revisions: number }>(
    `SELECT state, claimant_user_id AS claimant, (SELECT count(*)::int FROM packet_revisions WHERE request_id = r.id) AS revisions
       FROM requests r WHERE id = $1`,
    [requestId],
  );
  const proposals = await install.owner.query(
    `SELECT kind, state, accountable_user_id AS "accountableUserId", actor_kind AS "actorKind", surface, base_revision AS "baseRevision"
       FROM proposals WHERE request_id = $1 ORDER BY created_at, id`,
    [requestId],
  );
  const events = await install.owner.query<{ type: string }>("SELECT type FROM events WHERE data->>'requestId' = $1 ORDER BY number", [requestId]);
  return { ...rows[0], proposals: proposals.rows, events: events.rows.map(({ type }) => type) };
}

describe("a decline", () => {
  it("an agent asks for leaves the request as it was and creates a decline proposal, answered with 202", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const answer = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({
      proposal: expect.objectContaining({
        id: expect.any(String),
        request: { id: request.id, key: request.key },
        kind: "decline",
        state: "pending",
        accountableHuman: { id: bob, login: "bob", kind: "human", bot: false },
      }),
    });
    expect(await stored(request.id)).toEqual({
      state: "open",
      claimant: null,
      revisions: 1,
      proposals: [{ kind: "decline", state: "pending", accountableUserId: bob, actorKind: "agent", surface: "api", baseRevision: null }],
      events: ["request.opened", "proposal.created"],
    });
  });

  it("started in the web UI is a proposal too, with the web session's user as its accountable human", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const session = sessionOf(bob);
    const result = await install.web(session).write("requests.set_status", { key: request.key, state: "declined" }, install.fromThePage(session));
    expect(result).toEqual({ ok: true, output: { proposal: expect.objectContaining({ kind: "decline", accountableHuman: expect.objectContaining({ id: bob }) }) } });
    expect(await stored(request.id)).toMatchObject({
      state: "open",
      proposals: [{ kind: "decline", state: "pending", accountableUserId: bob, actorKind: "web_session", surface: "web" }],
    });
  });

  it("by the requester side gets 403 and creates no proposal", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const answer = await callApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    expect(answer.status).toBe(403);
    expect(await stored(request.id)).toMatchObject({ state: "open", proposals: [], events: ["request.opened"] });
  });
});

describe("marking done", () => {
  it("a claimed request becomes a done proposal", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`)).status).toBe(200);
    const answer = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "done" });
    expect(answer.status).toBe(202);
    expect(answer.body.proposal).toMatchObject({ kind: "done", state: "pending" });
    expect(await stored(request.id)).toMatchObject({ state: "claimed", proposals: [{ kind: "done", state: "pending" }] });
  });

  it("an open request gets 409 and no done proposal", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const answer = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "done" });
    expect(answer.status).toBe(409);
    expect(await stored(request.id)).toMatchObject({ state: "open", proposals: [], events: ["request.opened"] });
  });

  it("a request that is done already answers with its current state and no proposal", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await install.owner.query("UPDATE requests SET state = 'done', claimant_user_id = $2 WHERE id = $1", [request.id, bob]);
    const answer = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "done" });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ key: request.key, state: "done" });
    expect(await stored(request.id)).toMatchObject({ proposals: [] });
  });
});

describe("the direct state changes of set_status", () => {
  it("still apply at once, answered with 200", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const answer = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "in_progress" });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ state: "in_progress" });
    expect(await stored(request.id)).toMatchObject({ state: "in_progress", proposals: [] });
  });
});

describe("packet changes", () => {
  const addRevision = (user: string, key: string, packet: unknown, revision = 1) =>
    sendApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/packet/revisions`, { body: { packet }, headers: { "if-match": `"${revision}"` } });

  it("take a due date in the opening packet at once, with no proposal", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: packetWith({}, { due_date: "2026-10-15" }) });
    const packet = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}/packet`);
    expect(packet.body).toMatchObject({ revision: 1, packet: { due_date: "2026-10-15" } });
    expect(await stored(request.id)).toMatchObject({ revisions: 1, proposals: [] });
  });

  it("add a scope change while the request is unclaimed as the next revision at once", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const answer = await addRevision(alice, request.key, packetWith({ need: "A different need.", acceptance_criteria: ["Changed before a claim."] }));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ revision: 2, packet: { untrusted: { need: "A different need." } } });
    expect(await stored(request.id)).toMatchObject({ revisions: 2, proposals: [] });
  });

  it("turn a change of the need after a claim into a scope-change proposal based on the current revision", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const answer = await addRevision(alice, request.key, packetWith({ need: "A need changed after the claim." }));
    expect(answer.status).toBe(202);
    expect(answer.body.proposal).toMatchObject({ kind: "scope", state: "pending", accountableHuman: { id: alice } });
    expect(await stored(request.id)).toMatchObject({
      state: "claimed",
      revisions: 1,
      proposals: [{ kind: "scope", state: "pending", accountableUserId: alice, actorKind: "agent", baseRevision: 1 }],
      events: ["request.opened", "request.claimed", "proposal.created"],
    });
    const packet = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}/packet`);
    expect(packet.body).toMatchObject({ revision: 1, packet: { untrusted: { need: "Add a dark mode to the settings page." } } });
  });

  it("turn setting and moving the due date after the request was opened into due-date proposals", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const set = await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-15" }));
    expect(set.status).toBe(202);
    expect(set.body.proposal).toMatchObject({ kind: "due_date" });
    const moved = await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-01" }));
    expect(moved.status).toBe(202);
    expect(await stored(request.id)).toMatchObject({
      revisions: 1,
      proposals: [
        { kind: "due_date", state: "pending", baseRevision: 1 },
        { kind: "due_date", state: "pending", baseRevision: 1 },
      ],
    });
  });

  it("from anyone but the requester side get 403 and create no proposal", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const answer = await addRevision(carol, request.key, packetWith({}, { due_date: "2026-10-15" }));
    expect(answer.status).toBe(403);
    expect(await stored(request.id)).toMatchObject({ revisions: 1, proposals: [] });
  });
});

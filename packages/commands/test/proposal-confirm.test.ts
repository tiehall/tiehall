import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Confirming a proposal (requests: A confirmed commitment applies only if the
// request still allows it; requests: Cross-team commitments need a
// confirmation from each side; agent-safety: Runaway agent loops flag the
// request needs_human; design.md, Decisions this change rests on: D30 (4);
// design.md, Self-hosting decisions: S7). proposals.confirm is an internal
// command: only the web UI runs it, for a signed-in user, with the
// confirmation step, inside withOrg(). A confirmation is taken only from a
// person who may give it, in order, and only while the request's state still
// allows the commitment; otherwise it gets 403 or 409 and nothing changes. The
// last confirmation a proposal needs applies the commitment: the confirmation,
// the change and their events commit together, or nothing does. Creating a
// proposal and each confirmation append a domain event, and a confirmation is
// a human action on the request, which clears its needs_human flag. A decline,
// a withdrawal or a done proposal that takes effect appends a state-change
// event too (requests: The event log; design.md, Decisions: D45 (4)).

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

function packetWith(untrusted: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> {
  const packet = packetOf();
  return { ...packet, ...top, untrusted: { ...(packet["untrusted"] as object), ...untrusted } };
}

const confirm = (user: string, proposal: string) => install.confirm(sessionOf(user), "proposals.confirm", { proposal });

/** The request's state, flag, revisions and packet due date, its proposals' states and confirmations, and its events with their provenance. */
async function stored(requestId: string) {
  const { rows } = await install.owner.query(
    `SELECT state, needs_human AS "needsHuman", cardinality(agent_write_times) AS "agentWrites",
            (SELECT count(*)::int FROM packet_revisions WHERE request_id = r.id) AS revisions,
            (SELECT packet->>'due_date' FROM packet_revisions WHERE request_id = r.id ORDER BY number DESC LIMIT 1) AS "dueDate"
       FROM requests r WHERE id = $1`,
    [requestId],
  );
  const proposals = await install.owner.query(
    `SELECT p.state, (SELECT count(*)::int FROM proposal_confirmations c WHERE c.proposal_id = p.id) AS confirmations
       FROM proposals p WHERE request_id = $1 ORDER BY created_at, id`,
    [requestId],
  );
  const events = await install.owner.query(
    `SELECT type, actor_kind AS "actorKind", surface, actor_user_id AS "userId", data FROM events WHERE data->>'requestId' = $1 ORDER BY number`,
    [requestId],
  );
  return { ...rows[0], proposals: proposals.rows, events: events.rows };
}

describe("confirming a decline", () => {
  it("applies it on its accountable human's confirmation, with the confirmation's event recorded as a web session", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    const answer = await confirm(bob, proposal);
    expect(answer.status).toBe(200);
    const after = await stored(request.id);
    expect(after).toMatchObject({ state: "declined", proposals: [{ state: "applied", confirmations: 1 }] });
    expect(after.events.map(({ type }: { type: string }) => type)).toEqual([
      "request.opened",
      "proposal.created",
      "proposal.confirmed",
      "request.state_changed",
    ]);
    expect(after.events[2]).toMatchObject({
      actorKind: "web_session",
      surface: "web",
      userId: bob,
      data: { requestId: request.id, proposalId: proposal, step: "accountable_human", applied: true },
    });
    expect(after.events[3]).toMatchObject({ data: { state: "declined", previousState: "open" } });
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/proposals/${proposal}`)).body).toMatchObject({
      state: "applied",
      endedAt: expect.any(String),
      confirmations: { received: [{ step: "accountable_human", user: { id: bob } }] },
    });
  });

  it("is refused with 403 for anyone but its accountable human, and changes nothing", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    const before = await stored(request.id);
    for (const user of [alice, carol]) expect((await confirm(user, proposal)).status).toBe(403);
    expect(await stored(request.id)).toEqual(before);
  });
});

describe("a withdrawal or a done proposal", () => {
  it.each([
    ["a withdrawal Alice, the requester, proposes on an open request", "withdrawn", "open", "proposals", { kind: "withdraw" }],
    ["a done proposal Bob, the claimant, makes on a claimed request", "done", "claimed", "status", { state: "done" }],
  ] as const)("appends a state-change event once confirmed: %s", async (_name, state, previousState, operation, body) => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    if (previousState === "claimed") expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`)).status).toBe(200);
    const proposer = previousState === "claimed" ? bob : alice;
    const proposed = await callApi(install, tokenOf(proposer), "POST", `/api/v1/requests/${request.key}/${operation}`, body);
    expect(proposed.status).toBe(202);
    const proposal = proposed.body.proposal.id;
    expect((await confirm(proposer, proposal)).status).toBe(200);
    const after = await stored(request.id);
    expect(after.state).toBe(state);
    expect(after.events.map(({ type }: { type: string }) => type)).toEqual([
      "request.opened",
      ...(previousState === "claimed" ? ["request.claimed"] : []),
      "proposal.created",
      "proposal.confirmed",
      "request.state_changed",
    ]);
    expect(after.events.at(-1)).toMatchObject({ actorKind: "web_session", userId: proposer, data: { requestId: request.id, state, previousState } });
  });
});

describe("a confirmation", () => {
  it("is refused with 409 once the request's state no longer allows the commitment, and nothing changes", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "done" })).body.proposal.id;
    expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "open" })).status).toBe(200);
    const before = await stored(request.id);
    const answer = await confirm(bob, proposal);
    expect(answer.status).toBe(409);
    expect(await stored(request.id)).toEqual(before);
    expect(before).toMatchObject({ state: "open", proposals: [{ state: "pending", confirmations: 0 }] });
  });

  it("of each side appends its own event, and the other side's applies a due date as the next revision", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (
      await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
        body: { packet: packetWith({}, { due_date: "2026-10-15" }) },
        headers: { "if-match": '"1"' },
      })
    ).body.proposal.id;
    expect((await confirm(bob, proposal)).status).toBe(409);
    expect((await confirm(alice, proposal)).status).toBe(200);
    expect(await stored(request.id)).toMatchObject({ revisions: 1, dueDate: null, proposals: [{ state: "pending", confirmations: 1 }] });
    expect((await confirm(alice, proposal)).status).toBe(409);
    expect((await confirm(bob, proposal)).status).toBe(200);
    const after = await stored(request.id);
    expect(after).toMatchObject({ revisions: 2, dueDate: "2026-10-15", proposals: [{ state: "applied", confirmations: 2 }] });
    expect(after.events.map(({ type, data }: { type: string; data: { step?: string } }) => `${type}${data.step === undefined ? "" : ` ${data.step}`}`)).toEqual([
      "request.opened",
      "proposal.created",
      "proposal.confirmed accountable_human",
      "proposal.confirmed other_side",
      "request.packet_revised",
    ]);
  });

  it("leaves the proposal pending and the request unchanged when writing its event fails", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    const before = await stored(request.id);
    await install.owner.query(`
      CREATE FUNCTION probe_fail_confirmed_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type = 'proposal.confirmed' THEN RAISE EXCEPTION 'the event could not be written'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER probe_fail_confirmed_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION probe_fail_confirmed_event();`);
    try {
      expect((await confirm(bob, proposal)).status).toBe(500);
    } finally {
      await install.owner.query("DROP TRIGGER probe_fail_confirmed_event ON events; DROP FUNCTION probe_fail_confirmed_event()");
    }
    expect(await stored(request.id)).toEqual(before);
    expect(before).toMatchObject({ state: "open", proposals: [{ state: "pending", confirmations: 0 }] });
  });

  it("clears the request's needs_human flag and restarts its counts, even as the first of two", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const proposal = (
      await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
        body: { packet: packetWith({ acceptance_criteria: ["Changed after the claim."] }) },
        headers: { "if-match": '"1"' },
      })
    ).body.proposal.id;
    await install.owner.query("UPDATE requests SET needs_human = true WHERE id = $1", [request.id]);
    expect((await stored(request.id)).agentWrites).toBeGreaterThan(0);
    expect((await confirm(alice, proposal)).status).toBe(200);
    const after = await stored(request.id);
    expect(after).toMatchObject({ needsHuman: false, agentWrites: 0, proposals: [{ state: "pending", confirmations: 1 }] });
    expect(after.events.map(({ type }: { type: string }) => type).slice(-2)).toEqual(["proposal.confirmed", "request.needs_human_cleared"]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// What a proposal records and shows (requests: What a proposal records and
// shows; public-api: Commitments over the API answer 202 with a proposal;
// design.md, Decisions this change rests on: D23, D30 (4)). A proposal records
// who proposed it, the agent client, the surface and the user; the
// confirmations it needs and those it has received, each with the user who gave
// it and the time; when it expires; and, once it has ended without taking
// effect, how it ended. Wherever it is returned it shows all of that, and what
// it proposes. No operation changes what a proposal proposes once it is
// created, which the database also refuses: a different commitment is a new
// proposal, and a confirmation it has received stays valid while it waits.

const CLIENT = "https://claude.example.com/.well-known/oauth-client.json";

let install: TestInstall;
let alice: string;
let bob: string;
let erin: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, erin, fe);
});

afterAll(async () => {
  await install.close();
});

function packetWith(untrusted: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> {
  const packet = packetOf();
  return { ...packet, ...top, untrusted: { ...(packet["untrusted"] as object), ...untrusted } };
}

const addRevision = (user: string, key: string, packet: unknown, revision = 1) =>
  sendApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/packet/revisions`, { body: { packet }, headers: { "if-match": `"${revision}"` } });

const readProposal = (user: string, proposal: string) => callApi(install, tokenOf(user), "GET", `/api/v1/proposals/${proposal}`);

const asUser = (id: string, login: string) => ({ id, login, kind: "human", bot: false });

describe("a proposal read over /api/v1", () => {
  it("names who proposed it, the confirmations it needs, those it has received and its expiry", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const declined = await callApi(install, oauthTokenOf(bob, CLIENT, "cli"), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    expect(declined.status).toBe(202);
    const read = await readProposal(erin, declined.body.proposal.id);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id: declined.body.proposal.id,
      request: { id: request.id, key: request.key },
      kind: "decline",
      state: "pending",
      accountableHuman: asUser(bob, "bob"),
      proposedBy: { user: asUser(bob, "bob"), actorKind: "agent", surface: "cli" },
      change: {},
      confirmations: { needed: [{ step: "accountable_human", user: asUser(bob, "bob"), rules: [], team: null }], received: [] },
      createdAt: declined.body.proposal.createdAt,
      expiresAt: declined.body.proposal.expiresAt,
      endedAt: null,
      cancelReason: null,
      untrusted: { client: CLIENT, packet: null },
    });
  });

  it("shows each confirmation it has received with the user who gave it and the time", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposed = await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-15" }));
    const proposal: string = proposed.body.proposal.id;
    // The confirmation as the confirmation step records it, which task 14.8 builds.
    await install.owner.query(
      `INSERT INTO proposal_confirmations (org_id, proposal_id, step, user_id, confirmed_at)
       SELECT id, $1, 'accountable_human', $2, '2026-10-02T10:00:00Z' FROM orgs`,
      [proposal, alice],
    );
    const read = await readProposal(bob, proposal);
    expect(read.body.confirmations.received).toEqual([{ step: "accountable_human", user: asUser(alice, "alice"), confirmedAt: "2026-10-02T10:00:00.000Z" }]);
    expect(read.body).toMatchObject({ proposedBy: { user: asUser(alice, "alice"), actorKind: "agent", surface: "api" }, change: { dueDate: "2026-10-15" } });
    expect(read.body.untrusted).toEqual({ client: null, packet: packetWith({}, { due_date: "2026-10-15" }) });
  });

  it("shows how it ended once it ended without taking effect", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const proposal = (await addRevision(alice, request.key, packetWith({ need: "A changed need." }))).body.proposal.id;
    await addRevision(alice, request.key, packetWith({ links: [{ url: "https://wiki.example.com/x" }] }));
    const read = await readProposal(alice, proposal);
    expect(read.body).toMatchObject({ state: "cancelled", cancelReason: "stale", endedAt: expect.stringMatching(/Z$/) });
  });

  it("answers 404 for a proposal the install does not have", async () => {
    expect((await readProposal(alice, "5b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")).status).toBe(404);
  });
});

describe("what a proposal proposes", () => {
  it("is a second proposal when the same user proposes again, and the first keeps what it proposed", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const first = await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-15" }));
    const second = await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-01" }));
    expect(first.body.proposal.id).not.toBe(second.body.proposal.id);
    const [again, other] = [await readProposal(bob, first.body.proposal.id), await readProposal(bob, second.body.proposal.id)];
    expect(again.body).toMatchObject({ state: "pending", change: { dueDate: "2026-10-15" }, expiresAt: first.body.proposal.expiresAt, confirmations: first.body.proposal.confirmations });
    expect(other.body).toMatchObject({ state: "pending", change: { dueDate: "2026-10-01" } });
  });

  it("is never changed, not even by the app's own database role", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-15" }))).body.proposal.id;
    for (const change of [
      "kind = 'decline'",
      "change = '{}'::json",
      "base_revision = 7",
      "accountable_side = 'target_team'",
      "second_confirmation = '{}'",
      "created_at = created_at - interval '1 day', expires_at = expires_at - interval '1 day'",
    ]) {
      await expect(install.db.$client.query(`UPDATE proposals SET ${change} WHERE id = $1`, [proposal]), change).rejects.toThrow(/proposals are immutable/i);
    }
    await expect(install.db.$client.query("DELETE FROM proposals WHERE id = $1", [proposal])).rejects.toThrow(/proposals are immutable/i);
    const read = await readProposal(alice, proposal);
    expect(read.body).toMatchObject({ kind: "due_date", change: { dueDate: "2026-10-15" }, state: "pending" });
  });

  it("keeps each confirmation it received: none is changed or removed", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-15" }))).body.proposal.id;
    await install.owner.query(
      `INSERT INTO proposal_confirmations (org_id, proposal_id, step, user_id, confirmed_at) SELECT id, $1, 'accountable_human', $2, now() FROM orgs`,
      [proposal, alice],
    );
    await expect(install.db.$client.query("UPDATE proposal_confirmations SET user_id = $2 WHERE proposal_id = $1", [proposal, bob])).rejects.toThrow();
    await expect(install.db.$client.query("DELETE FROM proposal_confirmations WHERE proposal_id = $1", [proposal])).rejects.toThrow();
  });

  // Committed as an expected failure until task 14.8 builds the confirmation of a proposal.
  it.fails("keeps a received confirmation valid while the claim moves", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const proposal = (await addRevision(alice, request.key, packetWith({ acceptance_criteria: ["Changed after the claim."] }))).body.proposal.id;
    expect((await install.confirm(sessionOf(alice), "proposals.confirm", { proposal })).status).toBe(200);
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "open" });
    await callApi(install, tokenOf(erin), "POST", `/api/v1/requests/${request.key}/claim`);
    const read = await readProposal(alice, proposal);
    expect(read.body.confirmations.received).toEqual([{ step: "accountable_human", user: asUser(alice, "alice"), confirmedAt: expect.any(String) }]);
    expect((await install.confirm(sessionOf(erin), "proposals.confirm", { proposal })).status).toBe(200);
    expect((await readProposal(alice, proposal)).body.state).toBe("applied");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// A removed member's proposals are cancelled (requests: A removed member's
// claims stay and their proposals are cancelled; requests: How a proposal ends
// without taking effect; design.md, Decisions this change rests on: D28 #10).
// When a member is removed, every pending proposal whose accountable human
// they are is cancelled, each with its own event that names it cancelled, in
// the removal's transaction; their claims stay, and any call they make later is
// refused with 403. Proposals of other people, their confirmations by the
// removed member included, stay pending. A removal because the member left
// the GitHub organization cancels them the same way
// (organization-departures.test.ts).

let install: TestInstall;
let alice: string;
let bob: string;
let dana: string;
let pia: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  dana = await addUser(install.owner, { login: "dana" });
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, dana, fe);
});

afterAll(async () => {
  await install.close();
});

describe("removing a member", () => {
  it("cancels the pending proposals they are the accountable human of, each with its event, and keeps their claims", async () => {
    const fe142 = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const fe143 = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(dana), "POST", `/api/v1/requests/${fe142.key}/claim`);
    const done = (await callApi(install, tokenOf(dana), "POST", `/api/v1/requests/${fe142.key}/status`, { state: "done" })).body.proposal.id;
    const decline = (await callApi(install, tokenOf(dana), "POST", `/api/v1/requests/${fe143.key}/status`, { state: "declined" })).body.proposal.id;
    const bobs = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${fe143.key}/proposals`, { kind: "reassign", team: "BE" })).body.proposal.id;
    const alices = (
      await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${fe142.key}/packet/revisions`, {
        body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
        headers: { "if-match": '"1"' },
      })
    ).body.proposal.id;
    expect((await install.confirm(sessionOf(alice), "proposals.confirm", { proposal: alices })).status).toBe(200);

    expect((await install.confirm(sessionOf(pia), "members.remove", { userId: dana })).status).toBe(200);

    const { rows } = await install.owner.query<{ id: string; state: string; cancel_reason: string | null }>(
      "SELECT id, state, cancel_reason FROM proposals WHERE id = ANY($1) ORDER BY created_at",
      [[done, decline, bobs, alices]],
    );
    expect(rows).toEqual([
      { id: done, state: "cancelled", cancel_reason: "accountable_removed" },
      { id: decline, state: "cancelled", cancel_reason: "accountable_removed" },
      { id: bobs, state: "pending", cancel_reason: null },
      { id: alices, state: "pending", cancel_reason: null },
    ]);
    const endings = await install.owner.query<{ proposalId: string; requestId: string; how: string; reason: string; actorUserId: string }>(
      `SELECT data->>'proposalId' AS "proposalId", data->>'requestId' AS "requestId", data->>'how' AS how, data->>'reason' AS reason,
              actor_user_id AS "actorUserId" FROM events WHERE type = 'proposal.ended' ORDER BY number`,
    );
    // One event for each, in the order the removal took their requests, which is by id.
    expect(endings.rows).toHaveLength(2);
    expect(endings.rows).toEqual(
      expect.arrayContaining([
        { proposalId: done, requestId: fe142.id, how: "cancelled", reason: "accountable_removed", actorUserId: pia },
        { proposalId: decline, requestId: fe143.id, how: "cancelled", reason: "accountable_removed", actorUserId: pia },
      ]),
    );
    // Dana's claim stays, and Dana gets 403 on any call, a confirmation included.
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${fe142.key}`)).body).toMatchObject({ state: "claimed", claimant: { id: dana } });
    expect((await install.confirm(sessionOf(dana), "proposals.confirm", { proposal: done })).status).toBe(403);
  });
});

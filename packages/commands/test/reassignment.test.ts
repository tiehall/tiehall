import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Reassignment (requests: Reassignment gives a new key and the old key
// redirects; requests: How a proposal ends without taking effect; requests:
// Which side may act on a request; design.md, Decisions this change rests on:
// D23, D28 #18, D30 (4)). Members of the target team propose to reassign a
// request to another team of the install, which is a commitment: nothing
// changes until the proposal is confirmed. Once it is, the new team becomes the
// request's target team, the request returns to open with no claimant, it gets
// the next key of the new team, its old key names it still, as a read that
// answers under the new key, and every other pending proposal on it is
// cancelled, so none made while the old team owned it can be confirmed for the
// new one.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;
let ravi: string;

beforeAll(async () => {
  install = await startTestInstall();
  for (const key of ["BE", "FE", "MOB"]) team[key] = await addTeam(install.owner, key);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  ravi = await addUser(install.owner, { login: "ravi" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, bob, team["FE"] ?? "");
  await joinTeams(install.owner, ravi, team["MOB"] ?? "");
});

afterAll(async () => {
  await install.close();
});

/** Makes a team's next request take this number. */
async function nextNumber(key: string, number: number): Promise<void> {
  await install.owner.query(
    `INSERT INTO request_counters (org_id, team_id, last_number) SELECT id, $1, $2 FROM orgs
       ON CONFLICT (org_id, team_id) DO UPDATE SET last_number = EXCLUDED.last_number`,
    [team[key], number - 1],
  );
}

const propose = (user: string, key: string, body: Record<string, unknown>) => callApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/proposals`, body);
const read = (key: string) => callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}`);
const confirm = (user: string, proposal: string) => install.confirm(sessionOf(user), "proposals.confirm", { proposal });

describe("a reassignment", () => {
  it("once confirmed makes FE-142 MOB-37, open with no claimant, and cancels every other pending proposal", async () => {
    await nextNumber("FE", 142);
    await nextNumber("MOB", 37);
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect(request.key).toBe("FE-142");
    await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-142/claim");
    await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-142/status", { state: "in_progress" });
    const dueDate = await sendApi(install, tokenOf(alice), "POST", "/api/v1/requests/FE-142/packet/revisions", {
      body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
      headers: { "if-match": '"1"' },
    });
    expect((await confirm(alice, dueDate.body.proposal.id)).status).toBe(200);
    const decline = await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-142/status", { state: "declined" });

    const reassign = await propose(bob, "FE-142", { kind: "reassign", team: "MOB" });
    expect(reassign.status).toBe(202);
    expect(reassign.body.proposal).toMatchObject({ kind: "reassign", change: { team: { id: team["MOB"], key: "MOB" } } });
    expect((await confirm(bob, reassign.body.proposal.id)).status).toBe(200);

    const moved = await read("MOB-37");
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: request.id, key: "MOB-37", state: "open", claimant: null, targetTeam: { key: "MOB" } });
    expect((await read("FE-142")).body).toMatchObject({ id: request.id, key: "MOB-37" });

    const { rows } = await install.owner.query("SELECT id, state, cancel_reason FROM proposals WHERE request_id = $1 ORDER BY created_at", [request.id]);
    expect(rows).toEqual([
      { id: dueDate.body.proposal.id, state: "cancelled", cancel_reason: "reassigned" },
      { id: decline.body.proposal.id, state: "cancelled", cancel_reason: "reassigned" },
      { id: reassign.body.proposal.id, state: "applied", cancel_reason: null },
    ]);
    const events = await install.owner.query<{ type: string; data: Record<string, unknown> }>(
      "SELECT type, data FROM events WHERE data->>'requestId' = $1 AND type IN ('request.reassigned', 'request.state_changed') ORDER BY number",
      [request.id],
    );
    expect(events.rows).toEqual([
      { type: "request.reassigned", data: { requestId: request.id, teamId: team["MOB"], previousTeamId: team["FE"] } },
      { type: "request.state_changed", data: { requestId: request.id, state: "open", previousState: "in_progress" } },
    ]);
    // Ravi of MOB cannot confirm the due date that waited for team FE: the reassignment cancelled it.
    expect((await confirm(ravi, dueDate.body.proposal.id)).status).toBe(409);
    expect((await callApi(install, tokenOf(alice), "GET", "/api/v1/requests/MOB-37/packet")).body.packet.due_date).toBeUndefined();
    // MOB's next request takes the number after it, and FE's number 142 is never taken again.
    expect((await openRequest(install, tokenOf(alice), { targetTeam: "MOB" })).key).toBe("MOB-38");
    expect((await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key).toBe("FE-143");
  });

  it("changes nothing while it is not confirmed", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const reassign = await propose(bob, request.key, { kind: "reassign", team: "MOB" });
    expect(reassign.status).toBe(202);
    expect((await read(request.key)).body).toMatchObject({ key: request.key, targetTeam: { key: "FE" }, state: "open" });
  });

  it("is proposed only by the target team, to another team of the install", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect((await propose(alice, request.key, { kind: "reassign", team: "MOB" })).status).toBe(403);
    expect((await propose(bob, request.key, { kind: "reassign", team: "FE" })).status).toBe(400);
    expect((await propose(bob, request.key, { kind: "reassign", team: "NOPE" })).status).toBe(404);
    const { rows } = await install.owner.query("SELECT count(*)::int AS proposals FROM proposals WHERE request_id = $1", [request.id]);
    expect(rows[0]).toEqual({ proposals: 0 });
  });
});

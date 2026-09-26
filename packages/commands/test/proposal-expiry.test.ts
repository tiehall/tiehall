import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireProposals } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Proposals expire 7 days after they are created (requests: How a proposal
// ends without taking effect; requester-loop: Proposal outcomes reach the
// proposing agent; design.md, Decisions this change rests on: D28 #16, D30
// (4); design.md, Technical decisions: T6). A worker job ends every pending
// proposal whose 7 days are over, with an event that names it expired, recorded
// as a system action; no confirmation restarts the 7 days. A pending proposal
// is also cancelled as soon as its request reaches a terminal state. The clock
// here is the test's.

let install: TestInstall;
let clock = new Date("2026-10-01T09:00:00Z");
let alice: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
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

const at = (time: string) => {
  clock = new Date(time);
};

async function runExpiry(time: string): Promise<void> {
  await expireProposals.handle(
    { id: "expire", queue: expireProposals.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(time) },
  );
}

async function proposalOf(id: string) {
  const { rows } = await install.owner.query(
    `SELECT state, ended_at AS "endedAt", cancel_reason AS "cancelReason",
            (SELECT json_agg(json_build_object('how', e.data->>'how', 'reason', e.data->>'reason', 'actorKind', e.actor_kind))
               FROM events e WHERE e.type = 'proposal.ended' AND e.data->>'proposalId' = p.id::text) AS endings
       FROM proposals p WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function dueDateProposal(): Promise<{ key: string; proposal: string }> {
  const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  const answer = await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
    body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
    headers: { "if-match": '"1"' },
  });
  return { key: request.key, proposal: answer.body.proposal.id };
}

describe("the expiry job", () => {
  it("expires a proposal created at 2026-10-01 09:00 UTC at 2026-10-08 09:00 UTC, though its accountable human confirmed it on 2026-10-07", async () => {
    at("2026-10-01T09:00:00Z");
    const { key, proposal } = await dueDateProposal();
    at("2026-10-07T08:00:00Z");
    expect((await install.confirm(sessionOf(alice), "proposals.confirm", { proposal })).status).toBe(200);

    await runExpiry("2026-10-08T08:59:59Z");
    expect(await proposalOf(proposal)).toMatchObject({ state: "pending", endings: null });

    await runExpiry("2026-10-08T09:00:00Z");
    expect(await proposalOf(proposal)).toEqual({
      state: "expired",
      endedAt: new Date("2026-10-08T09:00:00Z"),
      cancelReason: null,
      endings: [{ how: "expired", reason: null, actorKind: "system" }],
    });

    at("2026-10-08T09:30:00Z");
    expect((await install.confirm(sessionOf(bob), "proposals.confirm", { proposal })).status).toBe(409);
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}/packet`)).body).toMatchObject({ revision: 1 });

    // Running again ends nothing twice.
    await runExpiry("2026-10-09T09:00:00Z");
    expect((await proposalOf(proposal)).endings).toHaveLength(1);
  });

  it("leaves proposals that ended already, and those still within their 7 days, as they are", async () => {
    at("2026-10-01T09:00:00Z");
    const withdrawn = await dueDateProposal();
    const session = sessionOf(alice);
    expect((await install.web(session).write("proposals.withdraw", { proposal: withdrawn.proposal }, install.fromThePage(session))).ok).toBe(true);
    at("2026-10-05T09:00:00Z");
    const recent = await dueDateProposal();
    await runExpiry("2026-10-09T09:00:00Z");
    expect(await proposalOf(withdrawn.proposal)).toMatchObject({ state: "withdrawn", endings: [{ how: "withdrawn" }] });
    expect(await proposalOf(recent.proposal)).toMatchObject({ state: "pending", endings: null });
  });

  it("is scheduled by the worker", () => {
    expect(expireProposals.schedule).toBeDefined();
  });
});

describe("a terminal state", () => {
  it("cancels the request's pending proposals", async () => {
    at("2026-10-02T09:00:00Z");
    const { key, proposal: dueDate } = await dueDateProposal();
    const decline = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/status`, { state: "declined" })).body.proposal.id;
    expect((await install.confirm(sessionOf(bob), "proposals.confirm", { proposal: decline })).status).toBe(200);
    expect(await proposalOf(dueDate)).toMatchObject({ state: "cancelled", cancelReason: "terminal_state", endings: [{ how: "cancelled", reason: "terminal_state" }] });
    expect((await install.confirm(sessionOf(alice), "proposals.confirm", { proposal: dueDate })).status).toBe(409);
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}`)).body.state).toBe("declined");
  });
});

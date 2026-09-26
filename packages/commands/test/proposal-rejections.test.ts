import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Rejecting and withdrawing a proposal (requests: How a proposal ends without
// taking effect; requests: The proposal's confirm page; requests: The event
// log; agent-safety: Actions that need the confirmation step; design.md,
// Decisions this change rests on: D28 #16, D30 (4); design.md, Readings to
// confirm with the founder: R12). proposals.reject and proposals.withdraw are
// internal commands the web UI runs inside withOrg(): a rejection, by the
// accountable human or, once that human has confirmed, by a person who may
// give the other side's confirmation, and a withdrawal, by the user who
// proposed it. Neither is a commitment nor needs the confirmation step, though
// each is a web UI write that passes the CSRF, Origin and Sec-Fetch-Site
// checks. Each ends the proposal without taking effect, with a domain event
// that names how it ended, and the request stays as it was.

let install: TestInstall;
let alice: string;
let bob: string;
let erin: string;
let carol: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const ops = await addTeam(install.owner, "OPS");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  carol = await addUser(install.owner, { login: "carol" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, erin, fe);
  await joinTeams(install.owner, carol, ops);
});

afterAll(async () => {
  await install.close();
});

/** Runs an internal command as the user in the web UI, from a page of the install; answers its status. */
async function inTheWebUi(user: string, command: string, proposal: string): Promise<number> {
  const session = sessionOf(user);
  const result = await install.web(session).write(command, { proposal }, install.fromThePage(session));
  return result.ok ? 200 : result.problem.status;
}

const reject = (user: string, proposal: string) => inTheWebUi(user, "proposals.reject", proposal);
const withdraw = (user: string, proposal: string) => inTheWebUi(user, "proposals.withdraw", proposal);
const confirm = async (user: string, proposal: string) => (await install.confirm(sessionOf(user), "proposals.confirm", { proposal })).status;

async function declineProposal() {
  const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  const proposal: string = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
  return { request, proposal };
}

async function dueDateProposal() {
  const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  const answer = await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
    body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
    headers: { "if-match": '"1"' },
  });
  return { request, proposal: answer.body.proposal.id as string };
}

/** The proposal's state and when it ended, the request's state and packet revisions, and the endings its events name. */
async function stored(requestId: string, proposal: string) {
  const { rows } = await install.owner.query(
    `SELECT p.state, p.ended_at IS NOT NULL AS ended, r.state AS "requestState",
            (SELECT count(*)::int FROM packet_revisions WHERE request_id = r.id) AS revisions
       FROM proposals p JOIN requests r ON r.id = p.request_id WHERE p.id = $1`,
    [proposal],
  );
  const endings = await install.owner.query(
    `SELECT data->>'how' AS how, actor_kind AS "actorKind", actor_user_id AS "userId" FROM events
      WHERE type = 'proposal.ended' AND data->>'requestId' = $1 AND data->>'proposalId' = $2 ORDER BY number`,
    [requestId, proposal],
  );
  return { ...rows[0], endings: endings.rows };
}

describe("a rejection", () => {
  it("by the accountable human ends a decline, which leaves the request's state as it was", async () => {
    const { request, proposal } = await declineProposal();
    expect(await reject(bob, proposal)).toBe(200);
    expect(await stored(request.id, proposal)).toEqual({
      state: "rejected",
      ended: true,
      requestState: "open",
      revisions: 1,
      endings: [{ how: "rejected", actorKind: "web_session", userId: bob }],
    });
    expect(await confirm(bob, proposal)).toBe(409);
    expect((await stored(request.id, proposal)).requestState).toBe("open");
  });

  it("by the other side comes only once the accountable human has confirmed a due date: 409 before, and it ends it after", async () => {
    const { request, proposal } = await dueDateProposal();
    expect(await reject(bob, proposal)).toBe(409);
    expect((await stored(request.id, proposal)).state).toBe("pending");
    expect(await confirm(alice, proposal)).toBe(200);
    expect(await reject(bob, proposal)).toBe(200);
    expect(await stored(request.id, proposal)).toMatchObject({ state: "rejected", revisions: 1, endings: [{ how: "rejected", userId: bob }] });
    expect(await confirm(erin, proposal)).toBe(409);
  });

  it("by anyone else gets 403 and changes nothing", async () => {
    const { request, proposal } = await declineProposal();
    for (const user of [carol, erin, alice]) expect(await reject(user, proposal)).toBe(403);
    expect(await stored(request.id, proposal)).toMatchObject({ state: "pending", endings: [] });
  });

  it("needs no confirmation step, but a write from the install's own page", async () => {
    const { request, proposal } = await declineProposal();
    const session = sessionOf(bob);
    const elsewhere = await install.web(session).write("proposals.reject", { proposal }, { ...install.fromThePage(session), origin: "https://attacker.example" });
    expect(elsewhere).toMatchObject({ ok: false, problem: { status: 403 } });
    expect((await stored(request.id, proposal)).state).toBe("pending");
  });
});

describe("a withdrawal", () => {
  it("by the user who proposed it ends their pending proposal", async () => {
    const { request, proposal } = await dueDateProposal();
    expect(await withdraw(alice, proposal)).toBe(200);
    expect(await stored(request.id, proposal)).toMatchObject({ state: "withdrawn", ended: true, revisions: 1, endings: [{ how: "withdrawn", userId: alice }] });
    expect(await confirm(alice, proposal)).toBe(409);
  });

  it("by anyone else gets 403 and changes nothing", async () => {
    const { request, proposal } = await dueDateProposal();
    expect(await confirm(alice, proposal)).toBe(200);
    for (const user of [bob, carol]) expect(await withdraw(user, proposal)).toBe(403);
    expect(await stored(request.id, proposal)).toMatchObject({ state: "pending", endings: [] });
  });

  it("of a proposal that has ended already gets 409", async () => {
    const { proposal } = await declineProposal();
    expect(await reject(bob, proposal)).toBe(200);
    expect(await withdraw(bob, proposal)).toBe(409);
    expect(await reject(bob, proposal)).toBe(409);
  });
});

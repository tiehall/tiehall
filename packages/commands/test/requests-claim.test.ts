import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Claiming, starting and releasing (requests: Claiming and starting work need
// no proposal; requests: Allowed state changes; requests: Which side may act on
// a request; requests: Request states; design.md, Decisions this change rests
// on: D23, D28 #3, #10, #13; D29 (3)). An agent acting for its own user, or the
// user in the web UI, claims an open request of their team and starts work on
// it without a proposal. The claimant releases the claim, which returns the
// request to open with no claimant, or, while it waits on a blocking question,
// keeps it needs_info with no claimant until the answer returns it to open
// (design.md, Decisions: D46 (1)); any member of the target team may release
// a claim held by someone who is no longer a member, and nobody else may. A
// change the state does not allow gets 409 and one the caller's side does not
// allow 403, and neither changes anything.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;
let erin: string;
let sam: string;
let carol: string;
let dana: string;
/** The request each test acts on, which Alice of team BE opens to team FE before it. */
let key: string;

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE", "OPS"]) team[name] = await addTeam(install.owner, name);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  sam = await addUser(install.owner, { login: "sam" });
  carol = await addUser(install.owner, { login: "carol" });
  dana = await addUser(install.owner, { login: "dana" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, sam, team["BE"] ?? "");
  await joinTeams(install.owner, carol, team["OPS"] ?? "");
  for (const user of [bob, erin, dana]) await joinTeams(install.owner, user, team["FE"] ?? "");
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  key = (await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key;
});

const claim = (user: string, on = key) => callApi(install, tokenOf(user), "POST", `/api/v1/requests/${on}/claim`);
const setStatus = (user: string, state: string, on = key) => callApi(install, tokenOf(user), "POST", `/api/v1/requests/${on}/status`, { state });

/** The request's state and claimant as stored, and the types of the events about it, in order. */
async function stored(on = key): Promise<{ state: string; claimant: string | null; events: string[] }> {
  const { rows } = await install.owner.query<{ id: string; state: string; claimant: string | null }>(
    `SELECT r.id, r.state, r.claimant_user_id AS claimant FROM requests r JOIN teams t ON t.org_id = r.org_id AND t.id = r.target_team_id
      WHERE t.key || '-' || r.number = $1`,
    [on],
  );
  const request = rows[0];
  if (request === undefined) throw new Error(`No request ${on}.`);
  const events = await install.owner.query<{ type: string }>("SELECT type FROM events WHERE data->>'requestId' = $1 ORDER BY number", [request.id]);
  return { state: request.state, claimant: request.claimant, events: events.rows.map(({ type }) => type) };
}

describe("claiming and starting work", () => {
  it("lets an agent claim an open request for its user, a member of the target team, with no proposal", async () => {
    const answer = await claim(bob);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ key, state: "claimed", claimant: { id: bob, login: "bob", kind: "human", bot: false } });
    expect(await stored()).toEqual({ state: "claimed", claimant: bob, events: ["request.opened", "request.claimed"] });
  });

  it("lets the agent move the claimed request to in_progress, with no proposal", async () => {
    await claim(bob);
    const answer = await setStatus(bob, "in_progress");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ state: "in_progress", claimant: { id: bob } });
    expect(await stored()).toEqual({ state: "in_progress", claimant: bob, events: ["request.opened", "request.claimed", "request.started"] });
  });

  it("lets a person do the same in the web UI", async () => {
    const caller = sessionOf(erin);
    expect(await install.web(caller).write("requests.claim", { key }, install.fromThePage(caller))).toMatchObject({
      ok: true,
      output: { state: "claimed", claimant: { id: erin } },
    });
    expect(await install.web(caller).write("requests.set_status", { key, state: "in_progress" }, install.fromThePage(caller))).toMatchObject({
      ok: true,
      output: { state: "in_progress" },
    });
  });

  it("refuses a member of a third team with 403, and the request stays open with no claimant", async () => {
    const answer = await claim(carol);
    expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/forbidden" }) });
    expect(await stored()).toEqual({ state: "open", claimant: null, events: ["request.opened"] });
  });

  it("refuses the requester side with 403, which may not claim either", async () => {
    expect((await claim(alice)).status).toBe(403);
    expect((await stored()).claimant).toBeNull();
  });

  it("refuses a second claim with 409, and Bob stays the claimant", async () => {
    await claim(bob);
    const answer = await claim(erin);
    expect(answer).toEqual({ status: 409, body: expect.objectContaining({ type: "https://tiehall.com/problems/conflict" }) });
    expect(await stored()).toEqual({ state: "claimed", claimant: bob, events: ["request.opened", "request.claimed"] });
  });

  it("lets exactly one of two members who claim at the same moment have the claim; the other gets 409", async () => {
    const answers = await Promise.all([claim(bob), claim(erin)]);
    expect(answers.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = answers[0]?.status === 200 ? bob : erin;
    expect(await stored()).toEqual({ state: "claimed", claimant: winner, events: ["request.opened", "request.claimed"] });
  });

  it("refuses to start work on an open request with 409", async () => {
    expect((await setStatus(bob, "in_progress")).status).toBe(409);
    expect(await stored()).toEqual({ state: "open", claimant: null, events: ["request.opened"] });
  });

  it("refuses a state that set_status does not change directly with 400", async () => {
    await claim(bob);
    for (const state of ["claimed", "needs_info", "closed"]) expect((await setStatus(bob, state)).status, state).toBe(400);
    expect((await stored()).state).toBe("claimed");
  });
});

describe("releasing a claim", () => {
  it("lets the claimant's agent release it: the request is open with no claimant, and no proposal is made", async () => {
    await claim(bob);
    await setStatus(bob, "in_progress");
    const answer = await setStatus(bob, "open");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ state: "open", claimant: null });
    expect(await stored()).toEqual({
      state: "open",
      claimant: null,
      events: ["request.opened", "request.claimed", "request.started", "request.released"],
    });
  });

  it("leaves the released request unclaimed, so another member of the team can claim it", async () => {
    await claim(bob);
    await setStatus(bob, "open");
    expect((await claim(erin)).body).toMatchObject({ state: "claimed", claimant: { id: erin } });
  });

  it("refuses another member of the target team with 403 while the claimant is still a member, and Bob stays the claimant", async () => {
    await claim(bob);
    const answer = await setStatus(erin, "open");
    expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/forbidden" }) });
    expect(await stored()).toMatchObject({ state: "claimed", claimant: bob });
  });

  it("refuses to release an open request, which nobody holds, with 409", async () => {
    expect((await setStatus(bob, "open")).status).toBe(409);
  });

  it("keeps a request that waits on a blocking question in needs_info with no claimant, which nobody can claim until the answer returns it to open", async () => {
    await claim(bob);
    await setStatus(bob, "in_progress");
    const question = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/messages`, { kind: "question", body: "Which browsers?", blocking: true });
    expect(question.status).toBe(200);
    const released = await setStatus(bob, "open");
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ state: "needs_info", claimant: null });
    expect(await claim(erin)).toEqual({ status: 409, body: expect.objectContaining({ type: "https://tiehall.com/problems/conflict" }) });
    expect(await stored()).toMatchObject({ state: "needs_info", claimant: null });
    const answered = await callApi(install, tokenOf(alice), "POST", `/api/v1/requests/${key}/messages`, {
      kind: "answer",
      body: "The last two versions of each.",
      questionId: question.body.message.id,
    });
    expect(answered.status).toBe(200);
    expect(await stored()).toEqual({
      state: "open",
      claimant: null,
      events: [
        "request.opened",
        "request.claimed",
        "request.started",
        "request.message_posted",
        "request.state_changed",
        "request.released",
        "request.message_posted",
        "request.state_changed",
      ],
    });
    expect((await claim(erin)).body).toMatchObject({ state: "claimed", claimant: { id: erin } });
  });

  describe("held by someone no longer a member of the install", () => {
    beforeEach(async () => {
      // Dana, of team FE, claims the request, and then leaves the install.
      await install.owner.query("INSERT INTO members (org_id, user_id, role) SELECT id, $1, 'member' FROM orgs ON CONFLICT DO NOTHING", [dana]);
      await install.owner.query(
        "INSERT INTO team_members (org_id, team_id, user_id) SELECT id, $1, $2 FROM orgs ON CONFLICT DO NOTHING",
        [team["FE"], dana],
      );
      expect((await claim(dana)).status).toBe(200);
      await install.owner.query("DELETE FROM members WHERE user_id = $1", [dana]);
    });

    it("lets any member of the target team release it, with no proposal", async () => {
      const answer = await setStatus(erin, "open");
      expect(answer.status).toBe(200);
      expect(await stored()).toEqual({ state: "open", claimant: null, events: ["request.opened", "request.claimed", "request.released"] });
    });

    it("refuses a member of the requesting team with 403, and Dana stays the claimant", async () => {
      expect((await setStatus(sam, "open")).status).toBe(403);
      expect(await stored()).toMatchObject({ state: "claimed", claimant: dana });
    });

    it("refuses Dana herself, who is no longer a member, with 403", async () => {
      const answer = await setStatus(dana, "open");
      expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/removed-member" }) });
      expect(await stored()).toMatchObject({ claimant: dana });
    });
  });
});

describe("a request in a terminal state", () => {
  it.each(["done", "declined", "withdrawn"])("refuses every change once it is %s, with 409", async (state) => {
    await install.owner.query(
      `UPDATE requests SET state = $1 WHERE id = (SELECT r.id FROM requests r JOIN teams t ON t.org_id = r.org_id AND t.id = r.target_team_id
        WHERE t.key || '-' || r.number = $2)`,
      [state, key],
    );
    for (const [name, answer] of [
      ["claim", await claim(bob)],
      ["in_progress", await setStatus(bob, "in_progress")],
      ["open", await setStatus(bob, "open")],
    ] as const) {
      expect(answer.status, name).toBe(409);
    }
    expect(await stored()).toEqual({ state, claimant: null, events: ["request.opened"] });
  });
});

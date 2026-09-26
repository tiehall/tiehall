import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sessionOf, tokenOf } from "./support/requests.ts";

// Opening a request (requests: A request is addressed to a team of the
// install; requests: The requester picks the requesting team; requests:
// Request states; requests: Per-team request keys; design.md, Decisions this
// change rests on: D25, D28 #11; design.md, Readings to confirm with the
// founder: R14). A request is addressed to one team of the install and records
// the user who opened it and the team they opened it from, which they pick
// among their own teams: their only team is the default, a user in several
// teams who names none gets 400 listing them, and a user in no team, or one
// who names a team they are not in, gets 403. It starts open, with the next key
// of its target team. Every refusal creates nothing.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let sam: string;
let lee: string;

beforeAll(async () => {
  install = await startTestInstall();
  for (const key of ["BE", "FE", "QA", "OPS"]) team[key] = await addTeam(install.owner, key);
  alice = await addUser(install.owner, { login: "alice" });
  sam = await addUser(install.owner, { login: "sam" });
  lee = await addUser(install.owner, { login: "lee" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, sam, team["BE"] ?? "", team["QA"] ?? "");
});

afterAll(async () => {
  await install.close();
});

/** What a refused call must leave as it was: the requests, their packet revisions, the teams' counts and the event log. */
async function everything(): Promise<unknown> {
  const { rows } = await install.owner.query(
    `SELECT (SELECT count(*) FROM requests) AS requests,
            (SELECT count(*) FROM packet_revisions) AS revisions,
            (SELECT coalesce(json_agg(c ORDER BY c.team_id), '[]') FROM request_counters c) AS counters,
            (SELECT count(*) FROM events) AS events`,
  );
  return rows[0];
}

describe("opening a request", () => {
  it("creates it open, addressed to the target team, with the requesting user and their only team as the requester", async () => {
    const created = await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Add a dark mode" });
    expect(created).toEqual({
      id: expect.any(String),
      key: "FE-1",
      state: "open",
      targetTeam: { id: team["FE"], key: "FE" },
      requester: { user: { id: alice, login: "alice", kind: "human", bot: false }, team: { id: team["BE"], key: "BE" } },
      claimant: null,
      createdAt: expect.any(String),
      needsHuman: false,
      untrusted: { title: "Add a dark mode" },
    });
    const { rows } = await install.owner.query(
      "SELECT state, number, claimant_user_id, requesting_user_id, requesting_team_id, target_team_id FROM requests WHERE id = $1",
      [created.id],
    );
    expect(rows).toEqual([
      { state: "open", number: 1, claimant_user_id: null, requesting_user_id: alice, requesting_team_id: team["BE"], target_team_id: team["FE"] },
    ]);
  });

  it("gives each new request the next key of its target team, and each team counts on its own", async () => {
    expect((await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key).toBe("FE-2");
    expect((await openRequest(install, tokenOf(alice), { targetTeam: "OPS" })).key).toBe("OPS-1");
    expect((await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key).toBe("FE-3");
  });

  it("records the team a member of two teams picks", async () => {
    const created = await openRequest(install, tokenOf(sam), { targetTeam: "FE", requestingTeam: "QA" });
    expect(created.requester).toEqual({ user: { id: sam, login: "sam", kind: "human", bot: false }, team: { id: team["QA"], key: "QA" } });
  });

  it("is the same from the web UI, as the signed-in user", async () => {
    const caller = sessionOf(alice);
    const result = await install.web(caller).write("requests.create", { targetTeam: "OPS", title: "Rotate the keys", packet: packetOf() }, install.fromThePage(caller));
    expect(result).toEqual({ ok: true, output: expect.objectContaining({ key: "OPS-2", state: "open" }) });
  });
});

describe("a request that is refused", () => {
  it("gets 404 when it is addressed to a team the install does not have, and creates nothing", async () => {
    const before = await everything();
    const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", { targetTeam: "ZZ", title: "Anything", packet: packetOf() });
    expect(answer).toEqual({ status: 404, body: expect.objectContaining({ type: "https://tiehall.com/problems/record-not-found", status: 404 }) });
    expect(await everything()).toEqual(before);
  });

  it("gets 400 listing the teams to pick from when a member of two teams names none, and creates nothing", async () => {
    const before = await everything();
    const answer = await callApi(install, tokenOf(sam), "POST", "/api/v1/requests", { targetTeam: "FE", title: "Anything", packet: packetOf() });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      type: "https://tiehall.com/problems/invalid-input",
      detail: expect.stringMatching(/BE and QA/),
      errors: [{ path: ["requestingTeam"], message: expect.stringMatching(/BE, QA/) }],
    });
    expect(await everything()).toEqual(before);
  });

  it("gets 403 for a user in no team, and creates nothing", async () => {
    const before = await everything();
    const answer = await callApi(install, tokenOf(lee), "POST", "/api/v1/requests", { targetTeam: "FE", title: "Anything", packet: packetOf() });
    expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/forbidden" }) });
    expect(await everything()).toEqual(before);
  });

  it("gets 403 when the user names a requesting team they are not in, and creates nothing", async () => {
    const before = await everything();
    for (const requestingTeam of ["OPS", "ZZ"]) {
      const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", { targetTeam: "FE", requestingTeam, title: "Anything", packet: packetOf() });
      expect(answer, requestingTeam).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/forbidden" }) });
    }
    expect(await everything()).toEqual(before);
  });

  it.each([
    ["an empty title", { targetTeam: "FE", title: "   ", packet: packetOf() }],
    ["a title of 201 characters", { targetTeam: "FE", title: "x".repeat(201), packet: packetOf() }],
    ["a title with a line break", { targetTeam: "FE", title: "One\nTwo", packet: packetOf() }],
    ["no title", { targetTeam: "FE", packet: packetOf() }],
    ["a target that is not a team key", { targetTeam: "fe", title: "Anything", packet: packetOf() }],
  ])("gets 400 for %s, and creates nothing", async (_name, body) => {
    const before = await everything();
    const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", body);
    expect(answer.status).toBe(400);
    expect(await everything()).toEqual(before);
  });
});

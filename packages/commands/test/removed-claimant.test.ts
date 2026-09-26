import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// A removed member's claims stay (requests: A removed member's claims stay and
// their proposals are cancelled; requests: Allowed state changes;
// teams-and-roles: Removing a member; design.md, Decisions this change rests
// on: D28 #10; D29 (3)). When an admin removes a member, the requests they
// claimed stay claimed by them, so the target team decides what happens next:
// any member of the target team, and only such a member, may release the claim
// without a proposal, and another member can then claim the request. Cancelling
// the removed member's pending proposals comes with the proposals (task 14.12),
// and a removal because a member left the GitHub organization with the
// organization checks (group 10).

let install: TestInstall;
const team: Record<string, string> = {};
let ada: string;
let alice: string;
let sam: string;
let bob: string;
let erin: string;
let carol: string;
let dana: string;
let fe142: string;
let fe143: string;

beforeAll(async () => {
  install = await startTestInstall();
  for (const key of ["BE", "FE", "OPS"]) team[key] = await addTeam(install.owner, key);
  ada = await addUser(install.owner, { login: "ada", role: "admin" });
  alice = await addUser(install.owner, { login: "alice" });
  sam = await addUser(install.owner, { login: "sam" });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  carol = await addUser(install.owner, { login: "carol" });
  dana = await addUser(install.owner, { login: "dana" });
  for (const user of [alice, sam]) await joinTeams(install.owner, user, team["BE"] ?? "");
  for (const user of [bob, erin, dana]) await joinTeams(install.owner, user, team["FE"] ?? "");
  await joinTeams(install.owner, carol, team["OPS"] ?? "");
  await install.owner.query("INSERT INTO request_counters (org_id, team_id, last_number) SELECT id, $1, 141 FROM orgs", [team["FE"]]);
  fe142 = (await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key;
  fe143 = (await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key;
  // Dana claims FE-142 and starts work on it, and claims FE-143; then Ada removes Dana from the install.
  expect((await callApi(install, tokenOf(dana), "POST", `/api/v1/requests/${fe142}/claim`)).status).toBe(200);
  expect((await callApi(install, tokenOf(dana), "POST", `/api/v1/requests/${fe142}/status`, { state: "in_progress" })).status).toBe(200);
  expect((await callApi(install, tokenOf(dana), "POST", `/api/v1/requests/${fe143}/claim`)).status).toBe(200);
  expect((await install.confirm(sessionOf(ada), "members.remove", { userId: dana })).status).toBe(200);
});

afterAll(async () => {
  await install.close();
});

const read = async (key: string) => (await callApi(install, tokenOf(carol), "GET", `/api/v1/requests/${key}`)).body;
const release = (user: string, key: string) => callApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/status`, { state: "open" });

describe("a removed member's claim", () => {
  it("stays theirs: the requests they claimed keep their state and name them as the claimant", async () => {
    expect(fe142).toBe("FE-142");
    expect(await read(fe142)).toMatchObject({ state: "in_progress", claimant: { id: dana, login: "dana", kind: "human", bot: false } });
    expect(await read(fe143)).toMatchObject({ state: "claimed", claimant: { id: dana } });
  });

  it("cannot be released by the removed member, whose calls get 403", async () => {
    const answer = await release(dana, fe142);
    expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/removed-member" }) });
    expect((await read(fe142)).claimant).toMatchObject({ id: dana });
  });

  it.each([
    ["Alice, the requester", () => alice],
    ["Sam, a member of the requesting team", () => sam],
    ["Carol, a member of a third team", () => carol],
    ["Ada, an admin in no team of the request", () => ada],
  ])("cannot be released by %s, who gets 403", async (_name, who) => {
    const answer = await release(who(), fe142);
    expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/forbidden" }) });
    expect((await read(fe142)).claimant).toMatchObject({ id: dana });
  });

  it("is released by Bob, a member of the target team, with no proposal: the request is open with no claimant", async () => {
    const answer = await release(bob, fe142);
    expect(answer.status).toBe(200);
    expect(await read(fe142)).toMatchObject({ state: "open", claimant: null });
    const { rows } = await install.owner.query(
      `SELECT type, data->>'userId' AS whose, actor_kind, actor_user_id FROM events
        WHERE data->>'requestId' = (SELECT r.id::text FROM requests r WHERE r.number = 142) ORDER BY number`,
    );
    expect(rows.map(({ type }) => type)).toEqual(["request.opened", "request.claimed", "request.started", "request.released"]);
    expect(rows.at(-1)).toEqual({ type: "request.released", whose: dana, actor_kind: "agent", actor_user_id: bob });
  });

  it("leaves the request to another member, who can then claim it", async () => {
    const answer = await callApi(install, tokenOf(erin), "POST", `/api/v1/requests/${fe142}/claim`);
    expect(answer.status).toBe(200);
    expect(await read(fe142)).toMatchObject({ state: "claimed", claimant: { id: erin } });
  });

  it("is released from the web UI the same way, after which Bob claims it for himself", async () => {
    const caller = sessionOf(bob);
    expect(await install.web(caller).write("requests.set_status", { key: fe143, state: "open" }, install.fromThePage(caller))).toMatchObject({
      ok: true,
      output: { state: "open", claimant: null },
    });
    expect(await install.web(caller).write("requests.claim", { key: fe143 }, install.fromThePage(caller))).toMatchObject({
      ok: true,
      output: { state: "claimed", claimant: { id: bob } },
    });
  });
});

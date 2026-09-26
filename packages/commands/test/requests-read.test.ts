import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Reading requests (requests: Every member sees every request; requests:
// Request keys that use a renamed team key keep resolving; design.md,
// Decisions this change rests on: D28 #3). Every member of the install sees
// every request, whether or not they belong to its requesting team or its
// target team: requests.get reads one by its key, with its thread, and
// requests.list lists the install's requests, newest first. A key that names no request gets 404, and
// someone who is no longer a member gets 403 and nothing.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;
let carol: string;
let dana: string;
/** FE-142, which Alice of team BE opened to team FE. */
let fe142: { id: string; key: string };

beforeAll(async () => {
  install = await startTestInstall();
  for (const key of ["BE", "FE", "OPS"]) team[key] = await addTeam(install.owner, key);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  carol = await addUser(install.owner, { login: "carol" });
  dana = await addUser(install.owner, { login: "dana", role: null });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, bob, team["FE"] ?? "");
  await joinTeams(install.owner, carol, team["OPS"] ?? "");
  // FE's last request was FE-141.
  await install.owner.query("INSERT INTO request_counters (org_id, team_id, last_number) SELECT id, $1, 141 FROM orgs", [team["FE"]]);
  fe142 = await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Add a dark mode" });
  await openRequest(install, tokenOf(bob), { targetTeam: "OPS", title: "Rotate the keys" });
  await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Fix the login page" });
});

afterAll(async () => {
  await install.close();
});

describe("reading one request", () => {
  it("returns FE-142 to Carol, a member of a third team", async () => {
    expect(fe142.key).toBe("FE-142");
    const answer = await callApi(install, tokenOf(carol), "GET", "/api/v1/requests/FE-142");
    expect(answer).toEqual({
      status: 200,
      body: {
        id: fe142.id,
        key: "FE-142",
        state: "open",
        targetTeam: { id: team["FE"], key: "FE" },
        requester: { user: { id: alice, login: "alice", kind: "human", bot: false }, team: { id: team["BE"], key: "BE" } },
        claimant: null,
        createdAt: expect.any(String),
        untrusted: { title: "Add a dark mode" },
        messages: [],
      },
    });
  });

  it("returns the same request to Carol's web session, and to its target team and its requester", async () => {
    const byApi = (await callApi(install, tokenOf(carol), "GET", "/api/v1/requests/FE-142")).body;
    expect(await install.web(sessionOf(carol)).read("requests.get", { key: "FE-142" })).toEqual({ ok: true, output: byApi });
    for (const reader of [bob, alice]) expect((await callApi(install, tokenOf(reader), "GET", "/api/v1/requests/FE-142")).body).toEqual(byApi);
  });

  it("gets 404 for a key that names no request, and 400 for one that is not a request key", async () => {
    expect((await callApi(install, tokenOf(carol), "GET", "/api/v1/requests/FE-999")).status).toBe(404);
    expect((await callApi(install, tokenOf(carol), "GET", "/api/v1/requests/ZZ-1")).status).toBe(404);
    expect((await callApi(install, tokenOf(carol), "GET", "/api/v1/requests/fe-142")).status).toBe(400);
  });

  it("gets 403 and nothing for someone who is no longer a member", async () => {
    const answer = await callApi(install, tokenOf(dana), "GET", "/api/v1/requests/FE-142");
    expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/removed-member" }) });
  });
});

describe("listing requests", () => {
  it("lists every request of the install to a member of any team, newest first", async () => {
    const answer = await callApi(install, tokenOf(carol), "GET", "/api/v1/requests");
    expect(answer.status).toBe(200);
    expect(answer.body.requests.map(({ key }: { key: string }) => key)).toEqual(["FE-143", "OPS-1", "FE-142"]);
    // Each listed request is what a read of it returns, without its thread.
    const { messages, ...read } = (await callApi(install, tokenOf(carol), "GET", "/api/v1/requests/FE-142")).body;
    expect(messages).toEqual([]);
    expect(answer.body.requests[2]).toEqual(read);
  });

  it("narrows the list to a target team and a state, and pages through it", async () => {
    const keys = async (query: string) =>
      (await callApi(install, tokenOf(carol), "GET", `/api/v1/requests?${query}`)).body.requests.map(({ key }: { key: string }) => key);
    expect(await keys("targetTeam=FE")).toEqual(["FE-143", "FE-142"]);
    expect(await keys("state=open&targetTeam=OPS")).toEqual(["OPS-1"]);
    expect(await keys("state=claimed")).toEqual([]);
    expect(await keys("limit=2")).toEqual(["FE-143", "OPS-1"]);
    expect(await keys("limit=2&offset=2")).toEqual(["FE-142"]);
  });

  it("gets 404 for a team the install does not have, 400 for a limit out of range, and 403 for someone no longer a member", async () => {
    expect((await callApi(install, tokenOf(carol), "GET", "/api/v1/requests?targetTeam=ZZ")).status).toBe(404);
    expect((await callApi(install, tokenOf(carol), "GET", "/api/v1/requests?limit=0")).status).toBe(400);
    expect((await callApi(install, tokenOf(carol), "GET", "/api/v1/requests?limit=201")).status).toBe(400);
    expect((await callApi(install, tokenOf(carol), "GET", "/api/v1/requests?state=closed")).status).toBe(400);
    expect((await callApi(install, tokenOf(dana), "GET", "/api/v1/requests")).status).toBe(403);
  });
});

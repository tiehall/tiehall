import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Reading requests (requests: Every member sees every request; requests:
// Request keys that use a renamed team key keep resolving; design.md,
// Decisions this change rests on: D28 #3). Every member of the install sees
// every request, whether or not they belong to its requesting team or its
// target team: requests.get reads one by its key, with its thread and its
// pending proposals, and requests.list lists the install's requests, newest
// first. A key that names no request gets 404, and someone who is no longer a
// member gets 403 and nothing.

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
        needsHuman: false,
        providerChange: null,
        untrusted: { title: "Add a dark mode" },
        messages: [],
        pendingProposals: [],
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
    const { messages, pendingProposals, ...read } = (await callApi(install, tokenOf(carol), "GET", "/api/v1/requests/FE-142")).body;
    expect(messages).toEqual([]);
    expect(pendingProposals).toEqual([]);
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

// Last, since it opens a request of its own, which the lists above do not expect.
describe("a request's pending proposals", () => {
  // agent-safety: The confirm URL never reaches the model, "A request's markdown holds no confirm URL": the markdown of a request URL renders this read.
  it("lists the request's pending proposals, oldest first, each as proposals.get returns it, and leaves out those that ended", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Add a light mode" });
    const decline = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    const withdraw = await callApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/proposals`, { kind: "withdraw" });
    const reassign = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/proposals`, { kind: "reassign", team: "OPS" });
    for (const answer of [decline, withdraw, reassign]) expect(answer.status).toBe(202);
    const bobs = sessionOf(bob);
    expect(await install.web(bobs).write("proposals.withdraw", { proposal: decline.body.proposal.id }, install.fromThePage(bobs))).toMatchObject({ ok: true });

    const read = await callApi(install, tokenOf(carol), "GET", `/api/v1/requests/${request.key}`);
    expect(read.status).toBe(200);
    const pending = read.body.pendingProposals as { id: string }[];
    expect(pending.map(({ id }) => id)).toEqual([withdraw.body.proposal.id, reassign.body.proposal.id]);
    for (const proposal of pending) expect(proposal).toEqual((await callApi(install, tokenOf(carol), "GET", `/api/v1/proposals/${proposal.id}`)).body);
  });
});

// agent-safety: Every string shown to agents has an origin. A page of a request names, for each packet field, the
// team whose member wrote its text: the team of the latest revision that changed that field. A revision by another
// team that changes one field relabels that field alone, and one that changes no text, such as a due date Tiehall
// records, relabels none.
describe("the packet's fields on a page of the request", () => {
  it("each name the team of the latest revision that changed that field", async () => {
    const opened = await openRequest<{ id: string; key: string }>(install, tokenOf(alice), {
      targetTeam: "FE",
      title: "Add a high-contrast mode",
      packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "A high-contrast mode.", acceptance_criteria: ["It passes WCAG AA."] } },
    });
    // Revision 2: Bob of FE changes the acceptance criteria alone. Revision 3: Tiehall moves the due date, no text.
    await install.owner.query(
      `INSERT INTO packet_revisions (org_id, request_id, number, packet, actor_kind, actor_user_id, surface, team_id)
         SELECT org_id, request_id, 2, jsonb_set(packet::jsonb, '{untrusted,acceptance_criteria}', '["It passes WCAG AAA."]')::json, 'web_session', $2, 'web', $3
           FROM packet_revisions WHERE request_id = $1 AND number = 1`,
      [opened.id, bob, team["FE"]],
    );
    await install.owner.query(
      `INSERT INTO packet_revisions (org_id, request_id, number, packet, actor_kind, surface, team_id)
         SELECT org_id, request_id, 3, jsonb_set(packet::jsonb, '{due_date}', '"2026-12-01"')::json, 'system', NULL, NULL
           FROM packet_revisions WHERE request_id = $1 AND number = 2`,
      [opened.id],
    );
    const page = (await install.execute("requests.read", tokenOf(carol), { request: opened.key, section: "packet" })) as {
      packet: { revision: number; team: { key: string } | null };
      parts: { field: string; team: { key: string } | null }[];
    };
    expect(page.packet).toMatchObject({ revision: 3, team: { key: "FE" } });
    expect(page.parts.map(({ field, team: writer }) => [field, writer?.key ?? null])).toEqual([
      ["need", "BE"],
      ["acceptance_criteria", "FE"],
    ]);
  });
});

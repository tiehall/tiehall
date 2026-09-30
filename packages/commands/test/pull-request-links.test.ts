import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Linking a pull request to a request (requests: Linked PRs and done on
// merge; agent-surfaces: Tools that change a request directly; requests: The
// event log; design.md, Decisions this change rests on: D23; design.md,
// Design rules: Requests and events). An agent acting for its own signed-in
// user links a pull request on GitHub.com to a request, named by its URL, with
// no proposal and no confirmation; the link and its domain event commit
// together. The spec names no side for linking, so any member of the install
// may link, as any member may read the request. A pull request is linked to a
// request once: GitHub names repositories without regard to case, so the
// same pull request written in another case is the same link. A URL that is
// not a pull request's on GitHub.com fails the schema and gets 400. The done
// proposal for a pull request that had already merged comes with close on
// merge (tasks 23.15 and 23.16).

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;
let carol: string;
/** The request each test links to, which Alice of team BE opens to team FE, and Bob of FE claims, before it. */
let key: string;
let requestId: string;

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE", "OPS"]) team[name] = await addTeam(install.owner, name);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  carol = await addUser(install.owner, { login: "carol" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, bob, team["FE"] ?? "");
  await joinTeams(install.owner, carol, team["OPS"] ?? "");
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  const opened = await openRequest<{ id: string; key: string }>(install, tokenOf(alice), { targetTeam: "FE" });
  key = opened.key;
  requestId = opened.id;
  expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/claim`)).status).toBe(200);
});

const link = (user: string, url: string, on = key) => callApi(install, tokenOf(user), "POST", `/api/v1/requests/${on}/pull-requests`, { url });

/** The types of the events about the request, in order, and how many proposals and links it has. */
async function stored(): Promise<{ events: string[]; proposals: number; links: number }> {
  const events = await install.owner.query<{ type: string }>("SELECT type FROM events WHERE data->>'requestId' = $1 ORDER BY number", [requestId]);
  const count = async (table: string) =>
    Number((await install.owner.query(`SELECT count(*) FROM ${table} WHERE request_id = $1`, [requestId])).rows[0].count);
  return { events: events.rows.map(({ type }) => type), proposals: await count("proposals"), links: await count("pull_request_links") };
}

describe("linking a pull request", () => {
  it("links it for an agent's user with no proposal, and records the link's event with the agent's provenance", async () => {
    const answer = await link(bob, "https://github.com/acme/web/pull/88");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      request: expect.objectContaining({ key, state: "claimed" }),
      pullRequest: {
        id: expect.any(String),
        repository: "acme/web",
        number: 88,
        url: "https://github.com/acme/web/pull/88",
        linkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        linkedBy: { id: bob, login: "bob", kind: "human", bot: false },
      },
    });
    expect(await stored()).toEqual({ events: ["request.opened", "request.claimed", "request.pull_request_linked"], proposals: 0, links: 1 });
    const { rows } = await install.owner.query(
      "SELECT actor_kind, actor_user_id, surface, team_id, data FROM events WHERE type = 'request.pull_request_linked' AND data->>'requestId' = $1",
      [requestId],
    );
    expect(rows[0]).toEqual({
      actor_kind: "agent",
      actor_user_id: bob,
      surface: "api",
      team_id: team["FE"],
      data: { requestId, pullRequestLinkId: answer.body.pullRequest.id },
    });
  });

  it("lets the requester side link one too, and a member of neither side, since linking names no side", async () => {
    expect((await link(alice, "https://github.com/acme/api/pull/7")).status).toBe(200);
    expect((await link(carol, "https://github.com/acme/ops/pull/3")).status).toBe(200);
    expect((await stored()).links).toBe(2);
  });

  it("lets a person link one in the web UI, recorded as the web session's", async () => {
    const session = sessionOf(bob);
    const result = await install.web(session).write("requests.link_pr", { key, url: "https://github.com/acme/web/pull/89" }, install.fromThePage(session));
    expect(result.ok).toBe(true);
    const { rows } = await install.owner.query("SELECT actor_kind, surface FROM events WHERE type = 'request.pull_request_linked' AND data->>'requestId' = $1", [
      requestId,
    ]);
    expect(rows).toEqual([{ actor_kind: "web_session", surface: "web" }]);
  });

  it("links a pull request once: linking it again, in any case, answers with the same link and records nothing new", async () => {
    const first = await link(bob, "https://github.com/acme/web/pull/88");
    const again = await link(alice, "https://github.com/Acme/Web/pull/88");
    expect(again.status).toBe(200);
    expect(again.body.pullRequest).toEqual(first.body.pullRequest);
    expect(await stored()).toEqual({ events: ["request.opened", "request.claimed", "request.pull_request_linked"], proposals: 0, links: 1 });
    // The same number in another repository is another pull request.
    expect((await link(bob, "https://github.com/acme/api/pull/88")).body.pullRequest.repository).toBe("acme/api");
  });

  it("refuses a URL that is not a pull request's on GitHub.com with 400, and links nothing", async () => {
    for (const url of [
      "https://github.com/acme/web/issues/88",
      "https://github.example.com/acme/web/pull/88",
      "http://github.com/acme/web/pull/88",
      "https://github.com/acme/web/pull/88/files",
      "https://github.com/acme/web/pull/0",
      "https://github.com/acme/../pull/88",
      "https://github.com/-acme/web/pull/88",
      "acme/web#88",
    ]) {
      const answer = await link(bob, url);
      expect({ url, status: answer.status }).toEqual({ url, status: 400 });
      expect(JSON.stringify(answer.body)).not.toContain(url);
    }
    expect((await stored()).links).toBe(0);
  });

  it("refuses a key that names no request with 404", async () => {
    expect((await link(bob, "https://github.com/acme/web/pull/88", "FE-9999")).status).toBe(404);
  });
});

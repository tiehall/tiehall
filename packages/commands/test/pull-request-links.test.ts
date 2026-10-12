import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addInstallation } from "./support/apis.ts";
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
// proposal for a pull request that had already merged comes with task 23.16;
// close on merge, which reads the links, is close-on-merge.test.ts.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;
let carol: string;
/** Dave, of FE, the target team, who holds no claim. */
let dave: string;
/** acme/web, by GitHub's id, which a connected installation covers, so its merges close requests. */
const ACME_WEB = { id: 9101, fullName: "acme/web" };
/** The request each test links to, which Alice of team BE opens to team FE, and Bob of FE claims, before it. */
let key: string;
let requestId: string;

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE", "OPS"]) team[name] = await addTeam(install.owner, name);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  carol = await addUser(install.owner, { login: "carol" });
  dave = await addUser(install.owner, { login: "dave" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, bob, team["FE"] ?? "");
  await joinTeams(install.owner, carol, team["OPS"] ?? "");
  await joinTeams(install.owner, dave, team["FE"] ?? "");
  await addInstallation(install.owner, { account: "acme", repositories: [ACME_WEB] });
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

// Only the target side's links close on merge (requests: Linked PRs and done on merge; decisions-from-groups-15-28,
// D55 (67); design.md, Technical decisions: T9): a link made by the request's claimant or a member of its target team
// counts, and one by anyone else is recorded and shown, and its merge closes nothing. Whose side a link is on is
// decided when it is made.
describe("a linked pull request's merge", () => {
  let number = 500;

  /** The pull request of acme/web merges a few seconds from now, after the link, as GitHub tells it. */
  async function merges(pullRequest: number): Promise<string[]> {
    const done = (await install.execute(
      "requests.close_on_merge",
      { kind: "integration_event", source: "github" },
      { repositoryId: ACME_WEB.id, repository: ACME_WEB.fullName, number: pullRequest, mergedAt: new Date(Date.now() + 5_000).toISOString(), mentions: [] },
    )) as { done: string[] };
    return done.done;
  }

  it.each([
    ["Alice, of the requester side", () => alice],
    ["Carol, of neither side", () => carol],
  ])("closes nothing for a link by %s, which is recorded and shown", async (_who, linker) => {
    number += 1;
    const answer = await link(linker(), `https://github.com/acme/web/pull/${number}`);
    expect(answer.status).toBe(200);
    expect(answer.body.pullRequest).toMatchObject({ repository: "acme/web", number, linkedBy: { id: linker() } });
    expect((await stored()).events).toContain("request.pull_request_linked");

    expect(await merges(number)).toEqual([]);

    const { rows } = await install.owner.query("SELECT state FROM requests WHERE id = $1", [requestId]);
    expect(rows[0]?.state).toBe("claimed");
  });

  it.each([
    ["Bob, the claimant", () => bob],
    ["Dave, another member of the target team", () => dave],
  ])("closes the request for a link by %s", async (_who, linker) => {
    number += 1;
    expect((await link(linker(), `https://github.com/acme/web/pull/${number}`)).status).toBe(200);

    expect(await merges(number)).toEqual([key]);

    const { rows } = await install.owner.query("SELECT state FROM requests WHERE id = $1", [requestId]);
    expect(rows[0]?.state).toBe("done");
  });

  it("closes the request for a link its claimant made, though they have left the target team since", async () => {
    number += 1;
    expect((await link(bob, `https://github.com/acme/web/pull/${number}`)).status).toBe(200);
    await install.owner.query("DELETE FROM team_members WHERE user_id = $1 AND team_id = $2", [bob, team["FE"]]);
    try {
      expect(await merges(number)).toEqual([key]);
    } finally {
      await joinTeams(install.owner, bob, team["FE"] ?? "");
    }
  });

  it("closes nothing for a link Alice made before they joined the target team", async () => {
    number += 1;
    expect((await link(alice, `https://github.com/acme/web/pull/${number}`)).status).toBe(200);
    await joinTeams(install.owner, alice, team["FE"] ?? "");
    try {
      expect(await merges(number)).toEqual([]);
    } finally {
      await install.owner.query("DELETE FROM team_members WHERE user_id = $1 AND team_id = $2", [alice, team["FE"]]);
    }
  });

  // The requester side linking a pull request first does not keep the target side's link of it from counting
  // (design.md, Risks: the target team can link the same PR): the target side's link of it answers with the same
  // link, which then counts, and is recorded as their link.
  it.each([
    ["Bob, the claimant", () => bob],
    ["Dave, another member of the target team", () => dave],
  ])("closes the request when %s links a pull request the requester side linked first", async (_who, linker) => {
    number += 1;
    const url = `https://github.com/acme/web/pull/${number}`;
    const first = await link(alice, url);
    const again = await link(linker(), url);
    expect(again.status).toBe(200);
    expect(again.body.pullRequest).toEqual(first.body.pullRequest);
    expect((await stored()).links).toBe(1);
    const { rows } = await install.owner.query(
      "SELECT actor_user_id FROM events WHERE type = 'request.pull_request_linked' AND data->>'requestId' = $1 ORDER BY number",
      [requestId],
    );
    expect(rows).toEqual([{ actor_user_id: alice }, { actor_user_id: linker() }]);

    expect(await merges(number)).toEqual([key]);
  });

  it("closes nothing when someone outside the target side links again a pull request the requester side linked", async () => {
    number += 1;
    const url = `https://github.com/acme/web/pull/${number}`;
    expect((await link(alice, url)).status).toBe(200);
    expect((await link(carol, url)).status).toBe(200);
    expect((await stored()).events.filter((type) => type === "request.pull_request_linked")).toHaveLength(1);

    expect(await merges(number)).toEqual([]);
  });

  // A link made before Tiehall recorded its side (migration 0098) counts when its linker is the claimant or a member
  // of the target team at the merge (design.md, Technical decisions: T9).
  it.each([
    ["Bob, the claimant", true, () => bob],
    ["Dave, another member of the target team", true, () => dave],
    ["Alice, of the requester side", false, () => alice],
  ])("for a link by %s made before its side was recorded, closes the request: %s", async (_who, closes, linker) => {
    number += 1;
    expect((await link(linker(), `https://github.com/acme/web/pull/${number}`)).status).toBe(200);
    await install.owner.query("UPDATE pull_request_links SET target_side = NULL WHERE request_id = $1 AND number = $2", [requestId, number]);

    expect(await merges(number)).toEqual(closes ? [key] : []);
  });
});

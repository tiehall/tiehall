import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireProposals, type CiCaller } from "../src/index.ts";
import { changesOf, CONTRACT_WORKFLOW, providerOnStub, reportOf, runDueUpdates } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// What each pull reader covers (requester-loop: What whats_new covers;
// requester-loop: Proposal outcomes reach the proposing agent; design.md,
// Decisions this change rests on: D28 #58, #60, #62; D29 (5); D30 (4)).
// whats_new, which `tiehall updates` runs too, returns the domain events on
// the requests whose requesting user is its user, the requests the user has
// claimed and the requests the user is accountable for, plus the new requests
// addressed to the user's teams; events on every other request of the install
// stay out of it. The web inbox's update feed covers the same, plus the events
// on the requests whose requesting team is one of the user's teams. When the
// accountable human confirms a proposal an agent made, when the other side's
// confirmation makes a two-sided commitment take effect, and when a proposal
// ends without taking effect, the event reaches the whats_new of the user the
// agent acts for.
//
// The tests read whats_new through /api/v1, where it is the operation behind
// the MCP tool and the CLI's command, each time as a new client, whose cursor
// is at the start, and read on to the last page by acknowledging each page, so
// every update in scope is read and nothing else is moved; and the web inbox's
// update feed through the web UI's commands, as the signed-in user. They were
// written first, as expected failures: whats_new waited for task 19.2 and the
// web inbox's update feed for 19.6, which turned them into plain tests.

let install: TestInstall;
let clock = new Date("2026-10-01T09:00:00Z");
const team: Record<string, string> = {};
/** Sam, Lee and Kim are in BE; Dana, Bob and Erin in FE; Oli in OPS; Pia, an admin, in no team. */
const person: Record<string, string> = {};

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  for (const key of ["BE", "FE", "OPS"]) team[key] = await addTeam(install.owner, key);
  for (const [login, teamKey] of [
    ["sam", "BE"],
    ["lee", "BE"],
    ["kim", "BE"],
    ["dana", "FE"],
    ["bob", "FE"],
    ["erin", "FE"],
    ["oli", "OPS"],
  ] as const) {
    person[login] = await addUser(install.owner, { login });
    await joinTeams(install.owner, person[login] ?? "", team[teamKey] ?? "");
  }
});

afterAll(async () => {
  await install?.close();
});

const at = (time: string) => {
  clock = new Date(time);
};

interface Update {
  number: number;
  type: string;
  data: Record<string, unknown>;
  request: { id: string; key: string; url: string };
}

/** The user's id; fails the test on a name the setup did not add. */
function id(login: string): string {
  const found = person[login];
  if (found === undefined) throw new Error(`No person ${login}.`);
  return found;
}

/**
 * Every update in the user's whats_new, as a new client of theirs reads it:
 * page after page, each acknowledged so the next follows it, until no more
 * is waiting. Fails the test when whats_new is refused.
 */
async function whatsNew(login: string): Promise<Update[]> {
  const caller = oauthTokenOf(id(login), `https://agent.example/${randomUUID()}.json`, "api");
  const found: Update[] = [];
  let acknowledge: number | undefined;
  for (;;) {
    const answer = await callApi(install, caller, "POST", "/api/v1/updates", acknowledge === undefined ? {} : { acknowledge });
    if (answer.status !== 200) throw new Error(`whats_new answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    const { events, more } = answer.body as { events: Update[]; more: boolean };
    found.push(...events);
    if (!more || events.length === 0) return found;
    acknowledge = Math.max(...events.map(({ number }) => number));
  }
}

/**
 * Every update in the update feed of the user's web inbox, from its cursor
 * on, read as the web UI reads it; each page is acknowledged so the next
 * follows it. Fails the test when the feed is refused.
 */
async function webInbox(login: string): Promise<Update[]> {
  const session = sessionOf(id(login));
  const web = install.web(session);
  const found: Update[] = [];
  for (;;) {
    const read = await web.read<{ events: Update[]; more: boolean }>("inbox.updates", {});
    if (!read.ok) throw new Error(`The web inbox's update feed answered ${JSON.stringify(read.problem)}`);
    found.push(...read.output.events);
    if (!read.output.more || read.output.events.length === 0) return found;
    const acknowledged = await web.write("inbox.updates", { acknowledge: Math.max(...read.output.events.map(({ number }) => number)) }, install.fromThePage(session));
    if (!acknowledged.ok) throw new Error(`Acknowledging the web inbox's update feed answered ${JSON.stringify(acknowledged.problem)}`);
  }
}

/** The updates on this request, by their type and, for a message, its kind. */
function on(updates: readonly Update[], requestId: string): string[] {
  return updates
    .filter(({ data }) => data["requestId"] === requestId)
    .map(({ type, data }) => (typeof data["kind"] === "string" ? `${type}:${String(data["kind"])}` : type));
}

async function open(login: string, targetTeam: string): Promise<{ id: string; key: string }> {
  return openRequest(install, tokenOf(id(login)), { targetTeam });
}

/** Posts a message through /api/v1 with the user's agent; fails the test on a refusal. */
async function post(login: string, key: string, message: Record<string, unknown>): Promise<{ id: string }> {
  const answer = await callApi(install, tokenOf(id(login)), "POST", `/api/v1/requests/${key}/messages`, message);
  if (answer.status !== 200) throw new Error(`messages.post answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body.message;
}

async function claim(login: string, key: string): Promise<void> {
  const answer = await callApi(install, tokenOf(id(login)), "POST", `/api/v1/requests/${key}/claim`);
  if (answer.status !== 200) throw new Error(`requests.claim answered ${answer.status}: ${JSON.stringify(answer.body)}`);
}

/** A due date the user's agent proposes on the request, at its first revision; returns the proposal's id. */
async function proposeDueDate(login: string, key: string, dueDate = "2026-10-15"): Promise<string> {
  const answer = await sendApi(install, tokenOf(id(login)), "POST", "/api/v1/proposals", {
    body: { kind: "due_date", key, dueDate },
    headers: { "if-match": '"1"' },
  });
  if (answer.status !== 202) throw new Error(`proposals.propose answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body.proposal.id;
}

/** Confirms the proposal on its confirm page, as the user in the web UI; fails the test on a refusal. */
async function confirm(login: string, proposal: string): Promise<void> {
  const answer = await install.confirm(sessionOf(id(login)), "proposals.confirm", { proposal });
  if (answer.status !== 200) throw new Error(`proposals.confirm answered ${answer.status}: ${await answer.text()}`);
}

/** Rejects the proposal, as the user in the web UI; fails the test on a refusal. */
async function reject(login: string, proposal: string): Promise<void> {
  const session = sessionOf(id(login));
  const answer = await install.web(session).write("proposals.reject", { proposal }, install.fromThePage(session));
  if (!answer.ok) throw new Error(`proposals.reject answered ${JSON.stringify(answer.problem)}`);
}

describe("whats_new (task 19.2)", () => {
  // requester-loop: Pull is the contract, "A question reaches the requester's agent by pull".
  it("holds a question the target team asks on a request the user opened", async () => {
    const request = await open("sam", "FE");
    await post("bob", request.key, { kind: "question", body: "Which browsers?" });
    expect(on(await whatsNew("sam"), request.id)).toContain("request.message_posted:question");
  });

  // requester-loop: What whats_new covers, "A request the user claimed".
  it("holds an answer on a request the user claimed, which another user opened", async () => {
    const request = await open("sam", "FE");
    await claim("dana", request.key);
    const question = await post("dana", request.key, { kind: "question", body: "Which browsers?" });
    await post("sam", request.key, { kind: "answer", body: "The last two versions of each.", questionId: question.id });
    expect(on(await whatsNew("dana"), request.id)).toContain("request.message_posted:answer");
  });

  // requester-loop: What whats_new covers, "A new request to the user's team".
  it("holds a new request addressed to one of the user's teams", async () => {
    const request = await open("sam", "FE");
    expect(on(await whatsNew("dana"), request.id)).toEqual(["request.opened"]);
  });

  it("holds the events on a request the user is accountable for, though they neither opened nor claimed it", async () => {
    const request = await open("sam", "FE");
    await claim("dana", request.key);
    // Bob's agent proposes a due date, which makes Bob the proposal's accountable human.
    await proposeDueDate("bob", request.key);
    await post("sam", request.key, { kind: "comment", body: "Thanks for the date." });
    expect(on(await whatsNew("bob"), request.id)).toContain("request.message_posted:comment");
  });

  // requester-loop: What whats_new covers, "A request the user has no part in".
  it("holds no event on a request the user has no part in", async () => {
    const request = await open("lee", "OPS");
    await post("oli", request.key, { kind: "question", body: "Which region?" });
    // The question is in the scope of the request's requester, so the read itself works.
    expect(on(await whatsNew("lee"), request.id)).toContain("request.message_posted:question");
    expect(on(await whatsNew("dana"), request.id)).toEqual([]);
  });

  it("holds only the opening of a new request to the user's team, not the events that follow it", async () => {
    const request = await open("sam", "FE");
    await post("sam", request.key, { kind: "comment", body: "More detail in the design doc." });
    expect(on(await whatsNew("erin"), request.id)).toEqual(["request.opened"]);
  });

  // A request to the user's team reaches them through the team only by its opening and a reassignment into it
  // (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (46)).
  it("holds no comment on an unclaimed request to the user's team, though a member of that team posts it", async () => {
    const request = await open("sam", "FE");
    await post("bob", request.key, { kind: "comment", body: "Looking into it." });
    await post("sam", request.key, { kind: "comment", body: "Thanks." });
    expect(on(await whatsNew("erin"), request.id)).toEqual(["request.opened"]);
  });

  // A user who has acted on a request is accountable for it, much as GitHub's "participating" works
  // (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (45)).
  it("holds for good the events on a request the user commented on, though they neither opened nor claimed it", async () => {
    const request = await open("lee", "OPS");
    // Kim, of the requesting team BE, has no part in the request until they comment on it.
    await post("kim", request.key, { kind: "comment", body: "BE needs this for the billing job too." });
    await claim("oli", request.key);
    const question = await post("oli", request.key, { kind: "question", body: "Which region?" });
    await post("lee", request.key, { kind: "answer", body: "eu-west-1.", questionId: question.id });
    expect(on(await whatsNew("kim"), request.id)).toEqual(
      expect.arrayContaining(["request.claimed", "request.message_posted:question", "request.message_posted:answer"]),
    );
    // Sam, of the same team, never acted on it, so none of it is in Sam's.
    expect(on(await whatsNew("sam"), request.id)).toEqual([]);
  });

  it("holds a request of another team that was reassigned to one of the user's teams", async () => {
    const request = await open("sam", "OPS");
    const answer = await callApi(install, tokenOf(id("oli")), "POST", `/api/v1/requests/${request.key}/proposals`, { kind: "reassign", team: "FE" });
    if (answer.status !== 202) throw new Error(`requests.propose answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    await confirm("oli", answer.body.proposal.id);
    expect(on(await whatsNew("erin"), request.id)).toEqual(["request.reassigned"]);
  });

  // requester-loop: What whats_new covers, "The author of a provider PR gets the consumers' questions", which task 23.9 built.
  describe("on a contract-change request whose provider PR the user authored", () => {
    let stub: GitHubStub;

    beforeAll(async () => {
      stub = await startGitHubStub();
      const provider = await providerOnStub(install, stub, ["deniz"]);
      // Deniz, of BE, signs in with the GitHub account that opens the provider pull request.
      person["deniz"] = await addUser(install.owner, { login: "deniz", githubAccountId: provider.account("deniz") });
      await joinTeams(install.owner, id("deniz"), team["BE"] ?? "");
      const admin = sessionOf(await addUser(install.owner, { role: "admin", login: "pia" }));
      expect((await install.confirm(admin, "apis.register", { name: "payments-api", team: team["BE"], repository: "acme/payments" })).status).toBe(200);
      await install.owner.query(
        `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
           SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
        [team["FE"], id("dana")],
      );
      const pullRequest = await stub.openPullRequest("acme/payments", { title: "New payment fields", head: "payment-fields", author: "deniz" });
      const ci: CiCaller = { kind: "ci", repositoryId: String(provider.repositoryId), repositoryOwnerId: String(provider.ownerId), jobWorkflowRef: CONTRACT_WORKFLOW };
      install.sentJobs.splice(0);
      await install.execute("contract.report", ci, reportOf("payments-api", changesOf("breaking"), { pullRequest: pullRequest.number }));
      at(new Date(clock.getTime() + 3 * 60 * 1000).toISOString());
      await runDueUpdates(install, clock);
    }, 60_000);

    afterAll(async () => {
      await stub?.close();
    });

    it("holds the consumers' questions, though the user did not open the request", async () => {
      const { rows } = await install.owner.query<{ id: string; key: string }>(
        "SELECT r.id, 'FE-' || r.number AS key FROM requests r WHERE r.requesting_user_id = $1",
        [id("deniz")],
      );
      const [request] = rows;
      expect(request).toBeDefined();
      await post("dana", request?.key ?? "", { kind: "question", body: "Does amount move to amount_minor?", blocking: true });
      expect(on(await whatsNew("deniz"), request?.id ?? "")).toContain("request.message_posted:question");
    });
  });
});

describe("the web inbox's update feed (task 19.6)", () => {
  // requester-loop: What whats_new covers, "The web inbox shows the user's updates".
  it("lists an answer on a request the user claimed", async () => {
    const request = await open("sam", "FE");
    await claim("dana", request.key);
    const question = await post("dana", request.key, { kind: "question", body: "Which browsers?" });
    await post("sam", request.key, { kind: "answer", body: "The last two versions of each.", questionId: question.id });
    expect(on(await webInbox("dana"), request.id)).toContain("request.message_posted:answer");
  });

  // requester-loop: What whats_new covers, "The web inbox adds requests whose requester is the user's team".
  it("adds the events on a request whose requesting team is one of the user's teams, which whats_new leaves out", async () => {
    const request = await open("lee", "OPS");
    await post("oli", request.key, { kind: "question", body: "Which region?" });
    expect(on(await webInbox("kim"), request.id)).toContain("request.message_posted:question");
    expect(on(await whatsNew("kim"), request.id)).toEqual([]);
  });

  // requester-loop: What whats_new covers, "A request the user has no part in".
  it("lists no event on a request the user has no part in, though the user can open it", async () => {
    const request = await open("lee", "OPS");
    await post("oli", request.key, { kind: "question", body: "Which region?" });
    expect(on(await webInbox("dana"), request.id)).toEqual([]);
    const read = await install.web(sessionOf(id("dana"))).read<{ key: string }>("requests.get", { key: request.key });
    expect(read).toMatchObject({ ok: true, output: { key: request.key } });
  });
});

describe("proposal outcomes in the proposing user's whats_new (task 19.2)", () => {
  // requester-loop: Proposal outcomes reach the proposing agent, "A confirmed decline".
  it("hold the confirmation of a decline that the user's agent proposed", async () => {
    const request = await open("sam", "FE");
    const answer = await callApi(install, tokenOf(id("dana")), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    expect(answer.status).toBe(202);
    const proposal: string = answer.body.proposal.id;
    await confirm("dana", proposal);
    const updates = (await whatsNew("dana")).filter(({ data }) => data["proposalId"] === proposal);
    expect(updates.map(({ type, data }) => [type, data["step"], data["applied"]])).toContainEqual(["proposal.confirmed", "accountable_human", true]);
  });

  // requester-loop: Proposal outcomes reach the proposing agent, "A due date confirmed by both sides".
  it("hold the user's own confirmation of a due date and then the other side's, with which it took effect", async () => {
    const request = await open("sam", "FE");
    const proposal = await proposeDueDate("dana", request.key);
    await confirm("dana", proposal);
    await confirm("sam", proposal);
    const confirmations = (await whatsNew("dana"))
      .filter(({ type, data }) => type === "proposal.confirmed" && data["proposalId"] === proposal)
      .map(({ data }) => [data["step"], data["applied"]]);
    expect(confirmations).toEqual([
      ["accountable_human", false],
      ["other_side", true],
    ]);
  });

  // requester-loop: Proposal outcomes reach the proposing agent, "The other side's rejection reaches the proposing agent".
  it("hold the other side's rejection of a due date the user confirmed", async () => {
    const request = await open("sam", "FE");
    const proposal = await proposeDueDate("dana", request.key);
    await confirm("dana", proposal);
    await reject("sam", proposal);
    const endings = (await whatsNew("dana")).filter(({ type, data }) => type === "proposal.ended" && data["proposalId"] === proposal);
    expect(endings.map(({ data }) => data["how"])).toEqual(["rejected"]);
  });

  // requester-loop: Proposal outcomes reach the proposing agent, "A half-confirmed due date expires".
  it("hold the expiry of a due date the user confirmed and the other side never did", async () => {
    at("2026-10-01T09:00:00Z");
    const request = await openRequest(install, tokenOf(id("sam")), { targetTeam: "FE" });
    const answer = await sendApi(install, tokenOf(id("sam")), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
      body: { packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "Add a dark mode to the settings page." }, due_date: "2026-10-15" } },
      headers: { "if-match": '"1"' },
    });
    expect(answer.status).toBe(202);
    const proposal: string = answer.body.proposal.id;
    at("2026-10-02T09:00:00Z");
    await confirm("sam", proposal);
    await expireProposals.handle(
      { id: "expire", queue: expireProposals.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date("2026-10-08T09:00:00Z") },
    );
    at("2026-10-08T09:30:00Z");
    const endings = (await whatsNew("sam")).filter(({ type, data }) => type === "proposal.ended" && data["proposalId"] === proposal);
    expect(endings.map(({ data }) => data["how"])).toEqual(["expired"]);
  });
});

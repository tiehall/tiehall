import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// A request's thread (requests: Thread messages and blocking questions;
// requests: Requests only, with questions in the request's thread; design.md,
// Decisions this change rests on: D9, D11, D28 #3, #17; design.md, Readings to
// confirm with the founder: R14). A message is a comment, a question, which
// may be blocking, or an answer, which names the question it answers. Only
// the two sides of the request post on it. A blocking question moves an open,
// claimed or in_progress request to needs_info, where it stays until every
// blocking question has an answer, and then returns to the state it had. A
// comment or a non-blocking question changes no state.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let sam: string;
let bob: string;
let erin: string;
let carol: string;
/** The request each test posts on, which Alice of team BE opens to team FE before it. */
let key: string;

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE", "OPS"]) team[name] = await addTeam(install.owner, name);
  alice = await addUser(install.owner, { login: "alice" });
  sam = await addUser(install.owner, { login: "sam" });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  carol = await addUser(install.owner, { login: "carol" });
  for (const user of [alice, sam]) await joinTeams(install.owner, user, team["BE"] ?? "");
  for (const user of [bob, erin]) await joinTeams(install.owner, user, team["FE"] ?? "");
  await joinTeams(install.owner, carol, team["OPS"] ?? "");
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  key = (await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key;
});

const post = (user: string, message: Record<string, unknown>, on = key) => callApi(install, tokenOf(user), "POST", `/api/v1/requests/${on}/messages`, message);
const read = async (on = key) => (await callApi(install, tokenOf(carol), "GET", `/api/v1/requests/${on}`)).body;
const state = async (on = key) => (await read(on)).state as string;
const claim = (user: string) => callApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/claim`);
const start = (user: string) => callApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/status`, { state: "in_progress" });

/** Posts a message that must be accepted, and returns its id. */
async function posted(user: string, message: Record<string, unknown>): Promise<string> {
  const answer = await post(user, message);
  if (answer.status !== 200) throw new Error(`messages.post answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body.message.id;
}

/** The request's messages as stored, and every message in the install, to show what a refusal left alone. */
async function thread(): Promise<{ here: number; all: number }> {
  const { rows } = await install.owner.query<{ here: string; all: string }>(
    `SELECT (SELECT count(*) FROM messages m JOIN requests r ON r.org_id = m.org_id AND r.id = m.request_id
              JOIN teams t ON t.org_id = r.org_id AND t.id = r.target_team_id WHERE t.key || '-' || r.number = $1) AS here,
            (SELECT count(*) FROM messages) AS all`,
    [key],
  );
  return { here: Number(rows[0]?.here), all: Number(rows[0]?.all) };
}

describe("a message", () => {
  it("goes into the request's own thread, with its body under untrusted and who posted it", async () => {
    const answer = await post(bob, { kind: "question", body: "Which browsers must the dark mode support?" });
    expect(answer.status).toBe(200);
    expect(answer.body.message).toEqual({
      id: expect.any(String),
      kind: "question",
      blocking: false,
      questionId: null,
      answered: false,
      version: 1,
      postedAt: expect.any(String),
      editedAt: null,
      provenance: { actorKind: "agent", surface: "api", user: { id: bob, login: "bob", kind: "human", bot: false }, team: null },
      untrusted: { body: "Which browsers must the dark mode support?", client: null },
    });
    expect(answer.body.request).toMatchObject({ key, state: "open" });
    expect((await read()).messages).toEqual([answer.body.message]);
    // No other conversation is created: the install holds this one message.
    expect(await thread()).toEqual({ here: 1, all: 1 });
  });

  it("is posted by either side: the requester side and the target team", async () => {
    await posted(sam, { kind: "comment", body: "Adding context from BE." });
    await posted(erin, { kind: "comment", body: "Noted." });
    expect((await read()).messages.map(({ untrusted }: { untrusted: { body: string } }) => untrusted.body)).toEqual([
      "Adding context from BE.",
      "Noted.",
    ]);
  });

  it("is refused with 403 for a member of a third team, and nothing is added", async () => {
    const before = await thread();
    const answer = await post(carol, { kind: "comment", body: "Drive-by comment." });
    expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/forbidden" }) });
    expect(await thread()).toEqual(before);
  });

  it("is posted from the web UI the same way", async () => {
    const caller = sessionOf(bob);
    const result = await install.web(caller).write("messages.post", { key, kind: "comment", body: "From the page." }, install.fromThePage(caller));
    expect(result).toMatchObject({ ok: true, output: { message: { kind: "comment", untrusted: { body: "From the page." } } } });
  });

  it.each([
    ["an answer that names no question", { kind: "answer", body: "Chrome and Firefox." }],
    ["an empty body", { kind: "comment", body: "" }],
    ["a body of blanks only", { kind: "comment", body: " \n\t " }],
    ["a body with a NUL character", { kind: "comment", body: "Before\u0000after" }],
    ["a body of 65,537 characters", { kind: "comment", body: "x".repeat(65537) }],
    ["a kind the thread does not have", { kind: "note", body: "Anything." }],
    ["a comment marked blocking", { kind: "comment", body: "Anything.", blocking: true }],
  ])("is refused with 400 for %s, and nothing is added", async (_name, message) => {
    const before = await thread();
    expect((await post(alice, message)).status).toBe(400);
    expect(await thread()).toEqual(before);
  });

  it("gets 404 for an answer that names no question of this request", async () => {
    const elsewhere = (await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key;
    const otherQuestion = (await post(bob, { kind: "question", body: "Elsewhere?" }, elsewhere)).body.message.id;
    const comment = await posted(bob, { kind: "comment", body: "Just a comment." });
    for (const questionId of [otherQuestion, comment, "7a1f0c56-6ad1-4a3e-9b1c-3f0d8f2f2b11"]) {
      expect((await post(alice, { kind: "answer", body: "An answer.", questionId })).status, questionId).toBe(404);
    }
  });
});

describe("a blocking question", () => {
  it("moves a claimed request to needs_info, and the answer that names it returns it to claimed", async () => {
    await claim(bob);
    const question = await posted(bob, { kind: "question", body: "Should it follow the system setting?", blocking: true });
    expect(await state()).toBe("needs_info");
    const answer = await post(alice, { kind: "answer", body: "Yes, follow it.", questionId: question });
    expect(answer.body.request).toMatchObject({ state: "claimed", claimant: { id: bob } });
    expect(await state()).toBe("claimed");
  });

  it("moves an open request to needs_info during triage, and the answer returns it to open", async () => {
    const question = await posted(erin, { kind: "question", body: "Is this for web or mobile?", blocking: true });
    expect(await state()).toBe("needs_info");
    await posted(alice, { kind: "answer", body: "Web.", questionId: question });
    expect(await read()).toMatchObject({ state: "open", claimant: null });
  });

  it("needs every blocking question answered: two questions need two answers", async () => {
    await claim(bob);
    await start(bob);
    const q1 = await posted(bob, { kind: "question", body: "Q1?", blocking: true });
    const q2 = await posted(bob, { kind: "question", body: "Q2?", blocking: true });
    await posted(alice, { kind: "answer", body: "A1.", questionId: q1 });
    expect(await state()).toBe("needs_info");
    // A second answer to the same question does not stand for the other one.
    await posted(sam, { kind: "answer", body: "A1, again.", questionId: q1 });
    expect(await state()).toBe("needs_info");
    await posted(alice, { kind: "answer", body: "A2.", questionId: q2 });
    expect(await state()).toBe("in_progress");
    expect((await read()).messages.filter(({ kind }: { kind: string }) => kind === "question").map(({ answered }: { answered: boolean }) => answered)).toEqual([
      true,
      true,
    ]);
  });

  it("keeps a request waiting until answered, so it cannot be claimed or started meanwhile", async () => {
    await posted(erin, { kind: "question", body: "Blocking?", blocking: true });
    expect((await claim(bob)).status).toBe(409);
    expect(await state()).toBe("needs_info");
  });

  it("is refused with 409 on a request in a terminal state, and nothing is added; a comment is still posted", async () => {
    await install.owner.query(
      `UPDATE requests SET state = 'withdrawn' WHERE id = (SELECT r.id FROM requests r JOIN teams t ON t.org_id = r.org_id AND t.id = r.target_team_id
        WHERE t.key || '-' || r.number = $1)`,
      [key],
    );
    expect((await post(bob, { kind: "question", body: "Still there?", blocking: true })).status).toBe(409);
    expect(await thread()).toMatchObject({ here: 0 });
    expect((await post(bob, { kind: "comment", body: "Closing note." })).status).toBe(200);
    expect(await state()).toBe("withdrawn");
  });
});

describe("a message that changes no state", () => {
  it("is a non-blocking question, which leaves a request in progress alone", async () => {
    await claim(bob);
    await start(bob);
    await posted(bob, { kind: "question", body: "Any preference for the toggle's place?" });
    expect(await state()).toBe("in_progress");
  });

  it("is a comment, or the answer to a question that did not block", async () => {
    const question = await posted(bob, { kind: "question", body: "Non-blocking?", blocking: false });
    await posted(alice, { kind: "comment", body: "Thinking." });
    await posted(alice, { kind: "answer", body: "Yes.", questionId: question });
    expect(await state()).toBe("open");
  });
});

describe("the events of the thread", () => {
  it("name the request and the message, and the state changes a blocking question makes, never the text", async () => {
    await claim(bob);
    const question = await posted(bob, { kind: "question", body: "Secret plan inside?", blocking: true });
    const answer = await posted(alice, { kind: "answer", body: "The secret plan.", questionId: question });
    const { rows } = await install.owner.query<{ type: string; data: Record<string, unknown> }>(
      "SELECT type, data FROM events WHERE data->>'requestId' = (SELECT data->>'requestId' FROM events WHERE data->>'messageId' = $1) ORDER BY number",
      [question],
    );
    const requestId = rows[0]?.data["requestId"];
    expect(rows).toEqual([
      { type: "request.opened", data: expect.objectContaining({ requestId }) },
      { type: "request.claimed", data: { requestId, userId: bob } },
      { type: "request.message_posted", data: { requestId, messageId: question, kind: "question", blocking: true } },
      { type: "request.state_changed", data: { requestId, state: "needs_info", previousState: "claimed" } },
      { type: "request.message_posted", data: { requestId, messageId: answer, kind: "answer", blocking: false, questionId: question } },
      { type: "request.state_changed", data: { requestId, state: "claimed", previousState: "needs_info" } },
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret plan");
  });
});

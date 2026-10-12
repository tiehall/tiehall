import { randomUUID } from "node:crypto";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailQuestion, openMailer, type Mailer } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequestInTheWebUi, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

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
  key = (await openRequestInTheWebUi(install, alice, { targetTeam: "FE" })).key;
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
      provenance: { actorKind: "agent", surface: "api", user: { id: bob, login: "bob", kind: "human", bot: false }, team: { id: team["FE"], key: "FE" } },
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
    const elsewhere = (await openRequestInTheWebUi(install, alice, { targetTeam: "FE" })).key;
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

// requests: The side a message is posted for (findings-from-claude-code-run: design.md, Findings: F4 (7); design.md,
// Technical decisions: T5). Every message is recorded for one side of its request, as the team in its provenance,
// which the server decides from the caller and the request: the claimant, while a member of the target team, posts
// for the target team, even when they opened the request or belong to its requesting team; otherwise the requesting
// user posts for the requesting team, a member of the target team for the target team, and a member of the
// requesting team for the requesting team. An edit keeps the side, a question is asked of the other side, as its
// email shows, and a proposal keeps the side the rules of cross-team commitments give it. Sami and Kim belong to both
// FE and BE; each request here is opened by Sami for FE, to BE.
describe("the side a message is posted for", () => {
  let sami: string;
  let kim: string;
  let dana: string;
  let sink: SmtpSink;
  let mailer: Mailer;

  beforeAll(async () => {
    sami = await addUser(install.owner, { login: "sami" });
    kim = await addUser(install.owner, { login: "kim" });
    dana = await addUser(install.owner, { login: "dana" });
    for (const user of [sami, kim]) await joinTeams(install.owner, user, team["FE"] ?? "", team["BE"] ?? "");
    await joinTeams(install.owner, dana, team["BE"] ?? "");
    for (const [user, login] of [[sami, "sami"], [kim, "kim"], [dana, "dana"]] as const) {
      await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [user, `${login}@example.com`]);
    }
    sink = await startSmtpSink();
    mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });
  });

  afterAll(async () => {
    mailer?.close();
    await sink?.close();
  });

  /** A request Sami opens in the web UI for FE, to BE; returns its key. */
  async function openedBySami(): Promise<string> {
    return (await openRequestInTheWebUi<{ key: string }>(install, sami, { targetTeam: "BE", requestingTeam: "FE" })).key;
  }

  /** Posts a message on the request with the user's agent; returns it as the API answers it. */
  async function postOn(on: string, user: string, message: Record<string, unknown>): Promise<{ id: string; provenance: { team: { key: string } | null } }> {
    const answer = await post(user, message, on);
    if (answer.status !== 200) throw new Error(`messages.post answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    return answer.body.message;
  }

  /** The key of the team a message of the request is recorded for, as get_request shows it. */
  async function sideOf(on: string, messageId: string): Promise<string | undefined> {
    const messages = (await read(on)).messages as { id: string; provenance: { team: { key: string } | null } }[];
    return messages.find(({ id }) => id === messageId)?.provenance.team?.key;
  }

  /** Runs the question emails the posts started, and returns to whom each went. */
  async function questionEmailsTo(): Promise<string[]> {
    const before = sink.messages.length;
    for (const { queue, data } of install.sentJobs.splice(0)) {
      if (queue !== emailQuestion.type.queue) continue;
      await emailQuestion.handle({ id: randomUUID(), queue, data: data as { messageId: string }, signal: new AbortController().signal }, { database: install.db, now: () => new Date(), mailer, installUrl: URL_OF_INSTALL });
    }
    return sink.messages.slice(before).flatMap(({ to }) => to);
  }

  const claimOn = async (on: string, user: string) => expect((await callApi(install, tokenOf(user), "POST", `/api/v1/requests/${on}/claim`)).status).toBe(200);

  it("is the target team for a claimant who opened the request, whose question is then asked of nobody else", async () => {
    const on = await openedBySami();
    await claimOn(on, sami);
    install.sentJobs.splice(0);
    const question = await postOn(on, sami, { kind: "question", body: "Which region?" });
    expect(question.provenance.team?.key).toBe("BE");
    expect(await sideOf(on, question.id)).toBe("BE");
    // Asked of the requester, who is Sami: no one is emailed.
    expect(await questionEmailsTo()).toEqual([]);
  });

  it("is the requesting team for the requester before a claim, in the web UI too", async () => {
    const on = await openedBySami();
    const session = sessionOf(sami);
    const result = await install.web(session).write<{ message: { id: string } }>("messages.post", { key: on, kind: "question", body: "Any news?" }, install.fromThePage(session));
    if (!result.ok) throw new Error(`messages.post answered ${JSON.stringify(result.problem)}`);
    expect(await sideOf(on, result.output.message.id)).toBe("FE");
  });

  it("is the target team for a member of both teams who neither opened nor claimed the request, whose question is asked of the requester", async () => {
    const on = await openedBySami();
    await claimOn(on, dana);
    const comment = await postOn(on, kim, { kind: "comment", body: "BE is on it." });
    expect(await sideOf(on, comment.id)).toBe("BE");
    install.sentJobs.splice(0);
    const question = await postOn(on, kim, { kind: "question", body: "Which region?" });
    expect(await sideOf(on, question.id)).toBe("BE");
    expect(await questionEmailsTo()).toEqual(["sami@example.com"]);
  });

  it("is the requesting team for a claimant who opened the request and has left the target team", async () => {
    const on = await openedBySami();
    await claimOn(on, sami);
    await install.owner.query("DELETE FROM team_members WHERE user_id = $1 AND team_id = $2", [sami, team["BE"]]);
    try {
      const comment = await postOn(on, sami, { kind: "comment", body: "Back on the FE side." });
      expect(await sideOf(on, comment.id)).toBe("FE");
    } finally {
      await joinTeams(install.owner, sami, team["BE"] ?? "");
    }
  });

  it("is kept by an edit, though the poster has claimed the request since", async () => {
    const on = await openedBySami();
    const question = await postOn(on, sami, { kind: "question", body: "Which region?" });
    expect(await sideOf(on, question.id)).toBe("FE");
    await claimOn(on, sami);
    const edited = await callApi(install, tokenOf(sami), "POST", `/api/v1/messages/${question.id}/versions`, { body: "Which region, eu or us?" });
    expect(edited.status).toBe(200);
    expect(await sideOf(on, question.id)).toBe("FE");
    const { rows } = await install.owner.query<{ key: string }>(
      "SELECT t.key FROM events e JOIN teams t ON t.org_id = e.org_id AND t.id = e.team_id WHERE e.type = 'request.message_edited' AND e.data->>'messageId' = $1",
      [question.id],
    );
    expect(rows).toEqual([{ key: "FE" }]);
  });

  it("leaves a proposal's side as the rules of cross-team commitments give it: the requester's, for a claimant who opened the request", async () => {
    const on = await openedBySami();
    await claimOn(on, sami);
    const proposed = await sendApi(install, tokenOf(sami), "POST", "/api/v1/proposals", { body: { kind: "due_date", key: on, dueDate: "2026-12-01" }, headers: { "if-match": '"1"' } });
    expect(proposed.status).toBe(202);
    const { rows } = await install.owner.query<{ key: string }>("SELECT t.key FROM proposals p JOIN teams t ON t.org_id = p.org_id AND t.id = p.team_id WHERE p.id = $1", [
      proposed.body.proposal.id,
    ]);
    expect(rows).toEqual([{ key: "FE" }]);
  });
});

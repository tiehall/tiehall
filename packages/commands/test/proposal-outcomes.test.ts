import { randomUUID } from "node:crypto";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailReceipts, expireProposals, notifyWaitingProposals, openMailer, type Mailer } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Proposal outcomes reach the proposing agent (requester-loop: Proposal
// outcomes reach the proposing agent; requests: How a proposal ends without
// taking effect; design.md, Decisions this change rests on: D23; D28 #16, #61;
// D30 (4); design.md, Self-hosting decisions: S10). When the accountable human
// confirms a proposal an agent made, the confirmation is in whats_new for the
// user the agent acts for; for a commitment that needs both sides, so is the
// other side's confirmation, with which it takes effect. When a proposal ends
// without taking effect, rejected, withdrawn, expired or cancelled, the event
// that names how it ended is in its accountable human's whats_new, also when
// they confirmed it and it waited for the other side. With SMTP set, no email
// is sent for an ending right away: the email jobs the worker runs each minute,
// the proposal notices and the receipts, send nothing about it, and the
// accountable human learns of it by pull.

let install: TestInstall;
let clock = new Date("2026-10-01T09:00:00Z");
let sink: SmtpSink;
let mailer: Mailer;
const person: Record<string, string> = {};

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  for (const [login, team] of [
    ["alice", be],
    ["sam", be],
    ["dana", fe],
    ["bob", fe],
  ] as const) {
    const id = await addUser(install.owner, { login });
    person[login] = id;
    await joinTeams(install.owner, id, team);
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [id, `${login}@acme.example`]);
  }
  sink = await startSmtpSink();
  mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });
});

afterAll(async () => {
  mailer?.close();
  await sink?.close();
  await install?.close();
});

const at = (time: string) => {
  clock = new Date(time);
};

function id(login: string): string {
  const found = person[login];
  if (found === undefined) throw new Error(`No person ${login}.`);
  return found;
}

/** Runs the worker's email jobs once, at the test's clock, as their each-minute schedule does. */
async function runEmailJobs(): Promise<void> {
  for (const job of [notifyWaitingProposals, emailReceipts]) {
    await job.handle({ id: randomUUID(), queue: job.type.queue, data: {}, signal: new AbortController().signal }, { database: install.db, now: () => clock, mailer, installUrl: URL_OF_INSTALL });
  }
}

/** The emails sent to the user so far: each one's subject. */
function emailsTo(login: string): string[] {
  return sink.messages.filter(({ to }) => to.includes(`${login}@acme.example`)).map(({ data }) => /^Subject: (.*)$/m.exec(data)?.[1] ?? "");
}

/** The proposal events in the user's whats_new, read by a new client of theirs from the start, for one proposal. */
async function outcomesIn(login: string, proposal: string): Promise<string[]> {
  const caller = oauthTokenOf(id(login), `https://agent.example/${randomUUID()}.json`, "api");
  const found: string[] = [];
  let acknowledge: number | undefined;
  for (;;) {
    const answer = await callApi(install, caller, "POST", "/api/v1/updates", { limit: 50, ...(acknowledge === undefined ? {} : { acknowledge }) });
    if (answer.status !== 200) throw new Error(`whats_new answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    const events = answer.body.events as { number: number; type: string; data: Record<string, unknown> }[];
    for (const { type, data } of events) {
      if (data["proposalId"] !== proposal) continue;
      found.push(type === "proposal.ended" ? `ended:${String(data["how"])}` : type === "proposal.confirmed" ? `confirmed:${String(data["step"])}:${String(data["applied"])}` : type);
    }
    if (events.length === 0) return found;
    acknowledge = events.at(-1)?.number;
  }
}

async function open(login: string): Promise<{ id: string; key: string }> {
  return openRequest(install, tokenOf(id(login)), { targetTeam: "FE" });
}

/** A due date the user's agent proposes on the request, at its first revision; returns the proposal's id. */
async function proposeDueDate(login: string, key: string): Promise<string> {
  const answer = await sendApi(install, tokenOf(id(login)), "POST", "/api/v1/proposals", {
    body: { kind: "due_date", key, dueDate: "2026-10-15" },
    headers: { "if-match": '"1"' },
  });
  if (answer.status !== 202) throw new Error(`proposals.propose answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body.proposal.id;
}

async function confirm(login: string, proposal: string): Promise<void> {
  const answer = await install.confirm(sessionOf(id(login)), "proposals.confirm", { proposal });
  if (answer.status !== 200) throw new Error(`proposals.confirm answered ${answer.status}: ${await answer.text()}`);
}

async function inTheWebUi(login: string, commandId: string, input: unknown): Promise<void> {
  const session = sessionOf(id(login));
  const answer = await install.web(session).write(commandId, input, install.fromThePage(session));
  if (!answer.ok) throw new Error(`${commandId} answered ${JSON.stringify(answer.problem)}`);
}

// requester-loop: Proposal outcomes reach the proposing agent, "A confirmed decline".
it("a confirmed decline reaches the proposing user's whats_new, and only its receipt is emailed", async () => {
  at("2026-10-01T09:00:00Z");
  const request = await open("sam");
  const answer = await callApi(install, tokenOf(id("dana")), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
  expect(answer.status).toBe(202);
  const proposal: string = answer.body.proposal.id;
  await runEmailJobs();
  expect(emailsTo("dana")).toEqual([`Tiehall: a proposal on ${request.key} waits for your confirmation`]);
  await confirm("dana", proposal);
  await runEmailJobs();
  expect(await outcomesIn("dana", proposal)).toEqual(["proposal.created", "confirmed:accountable_human:true"]);
  expect(emailsTo("dana")).toEqual([
    `Tiehall: a proposal on ${request.key} waits for your confirmation`,
    `Tiehall: receipt for your confirmation on ${request.key}`,
  ]);
});

// requester-loop: Proposal outcomes reach the proposing agent, "A due date confirmed by both sides".
it("both confirmations of a two-sided due date reach the proposing user's whats_new, the second with which it took effect", async () => {
  at("2026-10-02T09:00:00Z");
  const request = await open("sam");
  const proposal = await proposeDueDate("dana", request.key);
  await confirm("dana", proposal);
  await confirm("sam", proposal);
  expect(await outcomesIn("dana", proposal)).toEqual(["proposal.created", "confirmed:accountable_human:false", "confirmed:other_side:true"]);
});

describe("an ending", () => {
  // requester-loop: Proposal outcomes reach the proposing agent, "The other side's rejection reaches the proposing agent".
  it("by the other side's rejection reaches the proposing user's whats_new, and emails nobody", async () => {
    at("2026-10-03T09:00:00Z");
    const request = await open("sam");
    const proposal = await proposeDueDate("dana", request.key);
    await confirm("dana", proposal);
    await runEmailJobs();
    const before = sink.messages.length;
    at("2026-10-03T10:00:00Z");
    await inTheWebUi("sam", "proposals.reject", { proposal });
    at("2026-10-03T10:01:00Z");
    await runEmailJobs();
    expect(await outcomesIn("dana", proposal)).toEqual(["proposal.created", "confirmed:accountable_human:false", "ended:rejected"]);
    expect(sink.messages.length).toBe(before);
  });

  // requester-loop: Proposal outcomes reach the proposing agent, "A half-confirmed due date expires".
  it("by expiry after the user confirmed it reaches the user's whats_new, and no email about it is sent", async () => {
    at("2026-10-01T09:00:00Z");
    const request = await open("alice");
    const revision = await sendApi(install, tokenOf(id("alice")), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
      body: { packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "Add a dark mode to the settings page." }, due_date: "2026-10-15" } },
      headers: { "if-match": '"1"' },
    });
    expect(revision.status).toBe(202);
    const proposal: string = revision.body.proposal.id;
    at("2026-10-02T09:00:00Z");
    await confirm("alice", proposal);
    await runEmailJobs();
    const toAlice = emailsTo("alice");
    const before = sink.messages.length;
    await expireProposals.handle(
      { id: randomUUID(), queue: expireProposals.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date("2026-10-08T09:00:00Z") },
    );
    at("2026-10-08T09:01:00Z");
    await runEmailJobs();
    expect(await outcomesIn("alice", proposal)).toEqual(["proposal.created", "confirmed:accountable_human:false", "ended:expired"]);
    expect(emailsTo("alice")).toEqual(toAlice);
    expect(sink.messages.length).toBe(before);
  });

  it("by withdrawal, or by cancellation when the request ends, reaches the proposing user's whats_new, and emails nobody", async () => {
    at("2026-10-09T09:00:00Z");
    const request = await open("sam");
    const withdrawn = await proposeDueDate("dana", request.key);
    const cancelled = await proposeDueDate("sam", request.key);
    await runEmailJobs();
    const before = sink.messages.length;
    await inTheWebUi("dana", "proposals.withdraw", { proposal: withdrawn });
    const decline = await callApi(install, tokenOf(id("bob")), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    await confirm("bob", decline.body.proposal.id);
    await runEmailJobs();
    expect(await outcomesIn("dana", withdrawn)).toEqual(["proposal.created", "ended:withdrawn"]);
    expect(await outcomesIn("sam", cancelled)).toEqual(["proposal.created", "ended:cancelled"]);
    // The decline's own notice and receipt go to Bob, who confirmed it; nothing is emailed about the endings.
    expect(sink.messages.slice(before).map(({ to }) => to.join(","))).toEqual(sink.messages.slice(before).map(() => "bob@acme.example"));
  });
});

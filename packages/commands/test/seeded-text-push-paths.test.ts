import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { startSmtpSink, type ReceivedMessage, type SmtpSink } from "@tiehall/testing/smtp";
import { run as runTiehall } from "tiehall";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGitHubIssues,
  emailDigests,
  emailQuestion,
  emailReceipts,
  emailWarnDigests,
  notifyWaitingProposals,
  openMailer,
  readInstallations,
  syncMirror,
  type CiCaller,
  type GitHubAppAccess,
  type Mailer,
} from "../src/index.ts";
import { scanForConfirmUrl } from "./support/confirm-url-scan.ts";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { acknowledgeEverything, realSleep, signedInCli, type CliMachine } from "./support/cli.ts";
import { reportOf, runDueUpdates } from "./support/contract.ts";
import { CORPUS, fitted, visible } from "./support/corpus.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, mcpPerson, MODERN, type McpPerson } from "./support/mcp.ts";
import { openRequestInTheWebUi } from "./support/requests.ts";

// The seeded text through every push and outbound path (agent-safety: Notices
// that can reach a model carry only server text; agent-safety: Tracker mirrors
// carry a summary and a link, not the packet; requester-loop: Email for
// people, only when SMTP is set; design.md, Design rules: Agent safety;
// design.md, Self-hosting decisions: S10). Each entry of the injection corpus
// that 26.1 runs through what agents read is seeded, with a tag of its own in
// front, everywhere people and GitHub's CI write about a request: the title,
// the need, the acceptance criteria, the code refs and the links of a request
// team QA opens to team FE, a blocking question, its answer, a comment and its
// edit, team FE's intake notes, and the ids and operations of the
// potentially breaking changes a contract report from the provider's CI on
// GitHub carries. Then every path that pushes to a person or a model, or sends
// outside the install, runs on it: the Claude Code SessionStart digest, the
// Stop-hook waiter and `tiehall watch`, the messages of URL-mode elicitations
// for the decline each request gets, the emails it causes (question notices,
// proposal notices, receipts, the daily digest and FE's WARN digest), and the
// bodies and comments of the requests' GitHub mirror issues, with everything
// else Tiehall sends GitHub. None of them carries any tag or any line of any
// entry; each says what happened in Tiehall's own words, by key. A mirror
// issue's title holds its request's title, which the spec allows, so it is
// left out of the check.

/** How long a wait holds here, instead of 60 seconds. */
const HOLD_MS = 1_500;

/** The tag that marks the seeded text: each entry's own tag is this, a hyphen and its index. */
const TAG = `seed${randomBytes(5).toString("hex")}`;
const seedOf = (index: number) => `${TAG}-${index}`;
/** An entry as seeded: its tag first, so that a field's cut keeps it, then the entry. */
const seeded = (index: number) => `${seedOf(index)} ${CORPUS[index]?.text ?? ""}`;
/** An entry as seeded into a one-line field of at most this many characters, such as a title. */
const seededLine = (index: number, max: number) => fitted(seeded(index), max, { oneLine: true });

/**
 * The pieces of the seeded text no push or outbound text may carry: the tag,
 * and each line of each entry, without the stripped characters, that is long
 * enough to be told from Tiehall's own words.
 */
const PIECES = [
  TAG,
  ...new Set(
    CORPUS.flatMap(({ text }) =>
      visible(text)
        .split(/[\r\n\u2028\u2029]+/)
        .map((line) => line.trim())
        .filter((line) => line.length >= 16),
    ),
  ),
];

/** Checks that a text carries no piece of the seeded text, as it is and without the stripped characters. */
function expectNoSeededText(text: string, what: string): void {
  for (const piece of PIECES) {
    expect(text.includes(piece) || visible(text).includes(piece), `${what} carries "${piece.slice(0, 60)}"`).toBe(false);
  }
}

let shift = 0;
let harness: AgentAccessHarness;
let ada: McpPerson;
let sam: McpPerson;
let dana: McpPerson;
let samCli: CliMachine;
let sink: SmtpSink;
let mailer: Mailer;
let github: GitHubAppAccess;
/** The requests the entries were seeded into, by the entry's index. */
const seededRequests: { id: string; key: string }[] = [];
/** The message of each URL-mode elicitation dana's agent got, by the request it was for. */
const elicitations: { key: string; message: string }[] = [];
/** A request FE claimed and keeps open, on which the waiter and the watch see seeded messages arrive. */
let open: { id: string; key: string };

const now = () => new Date(Date.now() + shift);

/** Syncs the request's GitHub mirror issue now, as the mirror job does. */
const sync = (requestId: string) =>
  syncMirror({ database: harness.install.db, adapters: { github: createGitHubIssues({ app: github, database: harness.install.db }) }, installUrl: URL_OF_INSTALL, logger: harness.install.logger }, requestId);

/** Runs an email job as the worker does at this time, with the SMTP server set. */
async function runEmailJob(job: { handle: (...args: any[]) => Promise<void>; type: { queue: string } }, at: Date, data: unknown = {}): Promise<void> {
  await job.handle({ id: randomUUID(), queue: job.type.queue, data, signal: new AbortController().signal }, { database: harness.install.db, now: () => at, mailer, installUrl: URL_OF_INSTALL });
}

/** Posts a message as the person, in the web UI; returns its id. */
async function post(person: McpPerson, input: Record<string, unknown>): Promise<string> {
  const result = await harness.install.web(person.session).write<{ message: { id: string } }>("messages.post", input, harness.install.fromThePage(person.session));
  if (!result.ok) throw new Error(`messages.post answered ${JSON.stringify(result.problem)}`);
  return result.output.message.id;
}

/** Calls a tool in manual mode, which hands an input-required result back as it came. */
async function callManually(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.request({ method: "tools/call", params: { name, arguments: args } }, { allowInputRequired: true });
  return result as unknown as { resultType?: string; inputRequests?: Record<string, { method: string; params: { mode?: string; message?: string } }> };
}

/** A message as it was sent: its subject and its text, unfolded. */
function read(message: ReceivedMessage): { subject: string; text: string } {
  const end = message.data.indexOf("\r\n\r\n");
  const header = message.data.slice(0, end).replace(/\r\n[ \t]/g, " ");
  const unfolded = `${header}${message.data.slice(end)}`.replace(/=\r\n/g, "").replace(/=3D/g, "=").replace(/\r\n/g, "\n");
  return { subject: /^Subject: (.*)$/m.exec(unfolded)?.[1] ?? "", text: unfolded.slice(unfolded.indexOf("\n\n") + 2) };
}

beforeAll(async () => {
  harness = await startAgentAccess({ wait: { holdMs: HOLD_MS }, now });
  ada = await mcpPerson(harness, "ada", { role: "admin" });
  sam = await mcpPerson(harness, "sam-qa", { teams: ["QA"] });
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  await mcpPerson(harness, "deniz-pay", { teams: ["PAY"] });
  await harness.install.owner.query("UPDATE users SET email = github_login || '@example.com'");
  const teams = await harness.install.owner.query<{ id: string; key: string }>("SELECT id, key FROM teams");
  const teamId = (key: string) => teams.rows.find((team) => team.key === key)?.id ?? "";
  samCli = await signedInCli(harness, sam);
  sink = await startSmtpSink();
  mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });

  // The install's App, installed on acme, covers FE's intake repository, into which FE's requests are mirrored on claim,
  // and the provider's repository of payments-api, which FE consumes.
  const payments = harness.stub.addRepo("acme/payments");
  harness.stub.addRepo("acme/fe-intake");
  await harness.stub.addMember("acme", "ada", "admin");
  await harness.stub.install(harness.signIn.app, { account: "acme", repositories: ["acme/payments", "acme/fe-intake"], by: "ada" });
  harness.install.useGitHub(harness.signIn.github);
  await harness.signIn.connect("acme");
  const app = await harness.signIn.github.app();
  if (app === undefined) throw new Error("The install stores no App.");
  github = app;
  await readInstallations({ database: harness.install.db, app });
  await harness.install.execute("mirrors.map_repository", ada.session, { teamId: teamId("FE"), repository: "acme/fe-intake" });
  expect((await harness.install.confirm(ada.session, "apis.register", { name: "payments-api", team: teamId("PAY"), repository: "acme/payments" })).status).toBe(200);
  const api = (await harness.install.owner.query<{ id: string }>("SELECT id FROM apis WHERE name = 'payments-api'")).rows[0]?.id ?? "";
  await harness.install.execute("apis.declare_consumer", dana.session, { api, team: teamId("FE") });
  const notes = CORPUS.map((_, index) => seeded(index)).join("\n\n");
  const set = await harness.install.web(ada.session).write("teams.set_intake", { teamId: teamId("FE"), notes, requiredFields: [] }, harness.install.fromThePage(ada.session));
  expect(set.ok).toBe(true);

  // Each entry, seeded into a request QA opens to FE, which FE claims, asks about, and declines through dana's agent.
  const agent = await connectMcp(harness, { token: dana.token, version: MODERN, capabilities: { elicitation: { url: {} } } });
  try {
    await agent.listTools();
    for (const [index] of CORPUS.entries()) {
      const request = await openRequestInTheWebUi<{ id: string; key: string }>(harness.install, sam.userId, {
        targetTeam: "FE",
        requestingTeam: "QA",
        title: seededLine(index, 200),
        packet: {
          schema_version: "1-beta",
          kind: "request",
          untrusted: {
            need: seeded(index),
            acceptance_criteria: [fitted(seeded(index), 2000)],
            code_refs: [{ repository: fitted(seeded(index), 200), path: fitted(seeded(index), 1000) }],
            links: [{ url: `https://docs.example.com/${seedOf(index)}`, title: fitted(seeded(index), 200) }],
          },
        },
      });
      seededRequests.push(request);
      await harness.install.execute("requests.claim", dana.session, { key: request.key });
      await sync(request.id);
      const question = await post(dana, { key: request.key, kind: "question", blocking: true, body: seeded(index) });
      await post(sam, { key: request.key, kind: "answer", questionId: question, body: seeded(index) });
      const comment = await post(sam, { key: request.key, kind: "comment", body: seeded(index) });
      const edited = await harness.install.web(sam.session).write("messages.edit", { messageId: comment, body: `${seeded(index)} (edited)` }, harness.install.fromThePage(sam.session));
      expect(edited.ok).toBe(true);
      await sync(request.id);
      const declined = await callManually(agent, "set_status", { key: request.key, state: "declined" });
      expect(declined.resultType).toBe("input_required");
      for (const input of Object.values(declined.inputRequests ?? {})) elicitations.push({ key: request.key, message: input.params.message ?? "" });
    }
  } finally {
    await agent.close();
  }

  // The emails the writes cause: question notices to the requester, and the proposal notices to dana.
  for (const { queue, data } of harness.install.sentJobs.splice(0)) if (queue === emailQuestion.type.queue) await runEmailJob(emailQuestion, now(), data);
  await runEmailJob(notifyWaitingProposals, now());
  // Dana confirms each decline in the web UI: a receipt with its undo page, and each mirror issue closes as not planned.
  for (const request of seededRequests) {
    const { rows } = await harness.install.owner.query<{ id: string }>("SELECT id FROM proposals WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1", [request.id]);
    expect((await harness.install.confirm(dana.session, "proposals.confirm", { proposal: rows[0]?.id ?? "" })).status).toBe(200);
    await sync(request.id);
  }
  await runEmailJob(emailReceipts, now());

  // Each entry, seeded into the id and the operation of a potentially breaking change the provider's CI reports, which
  // goes to FE's daily WARN digest.
  const pullRequest = await harness.stub.openPullRequest("acme/payments", { title: "New payment fields", head: "payment-fields", author: "deniz-pay" });
  const ci: CiCaller = { kind: "ci", repositoryId: String(payments.id), repositoryOwnerId: String(payments.owner.id), jobWorkflowRef: "acme/payments/.github/workflows/contract.yml@refs/heads/main" };
  const changes = CORPUS.map((_, index) => ({ id: seededLine(index, 200), level: "WARN" as const, operation: fitted(seeded(index), 1000) }));
  await harness.install.execute("contract.report", ci, reportOf("payments-api", changes, { pullRequest: pullRequest.number }));
  shift = 3 * 60 * 1000;
  await runDueUpdates(harness.install, now());
  const today = now();
  const nextDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  await runEmailJob(emailWarnDigests, new Date(nextDay + 7 * 60_000));
  // The daily digest of the day these events happened on, once it has ended.
  await runEmailJob(emailDigests, new Date(nextDay + 5 * 60_000));

  // A request FE claimed and keeps open, for the waiter and the watch.
  open = await openRequestInTheWebUi<{ id: string; key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "QA", title: seededLine(0, 200), packet: { schema_version: "1-beta", kind: "request", untrusted: { need: seeded(0) } } });
  await harness.install.execute("requests.claim", dana.session, { key: open.key });
}, 300_000);

afterAll(async () => {
  samCli?.close();
  mailer?.close();
  await sink?.close();
  await harness?.close();
});

describe("the check for the seeded text", () => {
  it("finds each entry's seeded text, whole, cut to a title, and without its stripped characters", () => {
    for (const [index, { name }] of CORPUS.entries()) {
      for (const text of [seeded(index), seededLine(index, 200), visible(seeded(index)), `A text that quotes it: ${seeded(index)}`]) {
        expect(() => expectNoSeededText(text, name), name).toThrow();
      }
    }
  });
});

describe("the seeded text", () => {
  it("is in none of the lines of the Claude Code SessionStart digests, which name the requests by key", async () => {
    // Each new session's digest lists the next updates not announced yet, up to its page, until none is left.
    let printed = "";
    for (let session = 0; session < 20; session += 1) {
      const run = await samCli.run(["hook", "session-start"], { stdin: JSON.stringify({ session_id: `seeded-${session}`, hook_event_name: "SessionStart", source: "startup" }), sleep: realSleep });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      if (run.stdout === "") break;
      printed += run.stdout;
    }
    for (const { key } of seededRequests) expect(printed).toContain(`${key} request.message_edited (team FE)`);
    expectNoSeededText(printed, "the SessionStart digests");
  });

  it("is in none of the lines the Stop-hook waiter wakes Claude with, for a message of each entry", async () => {
    await acknowledgeEverything(samCli);
    for (const [index] of CORPUS.entries()) await post(dana, { key: open.key, kind: "comment", body: seeded(index) });
    const run = await samCli.run(["hook", "wait"], { stdin: JSON.stringify({ session_id: "seeded-wait", hook_event_name: "Stop" }), sleep: realSleep });
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr.split("\n").filter((line) => line.includes(`${open.key} request.message_posted (team FE)`))).toHaveLength(CORPUS.length);
    expectNoSeededText(run.stderr, "the waiter's output");
  }, 60_000);

  it("is in none of the lines tiehall watch prints, for a message of each entry", async () => {
    await acknowledgeEverything(samCli);
    const stop = new AbortController();
    let printed = "";
    let errors = "";
    const calls: string[] = [];
    const watching = runTiehall({
      argv: ["watch"],
      env: { TIEHALL_CONFIG_DIR: samCli.configDir, HOME: samCli.configDir },
      stdout: (text) => void (printed += text),
      stderr: (text) => void (errors += text),
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return harness.handle(request);
      },
      sleep: realSleep,
      interrupted: () => stop.signal,
    });
    try {
      const started = Date.now() + 30_000;
      while (!calls.includes("/api/v1/events/wait") && Date.now() < started) await realSleep(20);
      for (const [index] of CORPUS.entries()) await post(dana, { key: open.key, kind: "comment", body: seeded(index) });
      const until = Date.now() + 30_000;
      while (printed.split("\n").filter((line) => line !== "").length < CORPUS.length && Date.now() < until) await realSleep(20);
    } finally {
      stop.abort();
    }
    expect(await watching).toBe(0);
    expect(errors).toBe("");
    // What the watch prints reaches the model, as a hook's output does: no confirm URL (confirm-url-scan.ts).
    scanForConfirmUrl("hook output", printed, "tiehall watch");
    expect(printed.split("\n").filter((line) => line.startsWith(`Tiehall: ${open.key} request.message_posted (team FE)`))).toHaveLength(CORPUS.length);
    expectNoSeededText(printed, "tiehall watch's output");
  }, 60_000);

  it("is in none of the messages of the URL-mode elicitations, which name only the request key and the kind of commitment", () => {
    expect(elicitations.map(({ key }) => key)).toEqual(seededRequests.map(({ key }) => key));
    for (const { key, message } of elicitations) {
      expect(message).toBe(`Open Tiehall to confirm or reject the proposal to decline ${key}.`);
      expectNoSeededText(message, `the elicitation for ${key}`);
    }
  });

  it("is in no subject and no text of the emails it caused: question notices, proposal notices, receipts and both digests", () => {
    const sent = sink.messages.map(read);
    const kinds = (pattern: RegExp) => sent.filter(({ subject }) => pattern.test(subject)).length;
    expect(kinds(/^Tiehall: [A-Z][A-Z0-9]{1,9}-\d+ request\.message_posted \(team FE\)$/)).toBe(CORPUS.length);
    expect(kinds(/^Tiehall: a proposal on [A-Z][A-Z0-9]{1,9}-\d+ waits for your confirmation$/)).toBe(CORPUS.length);
    expect(kinds(/^Tiehall: receipt for your confirmation on [A-Z][A-Z0-9]{1,9}-\d+$/)).toBe(CORPUS.length);
    expect(kinds(/^Tiehall: your updates of \d{4}-\d{2}-\d{2} \(UTC\)$/)).toBeGreaterThan(0);
    expect(kinds(/^Tiehall: FE's WARN digest of \d{4}-\d{2}-\d{2} \(UTC\)$/)).toBe(1);
    for (const { subject, text } of sent) {
      expectNoSeededText(subject, `the subject "${subject}"`);
      expectNoSeededText(text, `the text of "${subject}"`);
    }
  });

  it("is in no body and no comment of the requests' GitHub mirror issues, nor in anything else Tiehall sent GitHub but their titles", async () => {
    for (const request of seededRequests) {
      const { rows } = await harness.install.owner.query<{ issue: string }>("SELECT issue FROM mirrors WHERE request_id = $1", [request.id]);
      const issue = harness.stub.issue("acme/fe-intake", Number(rows[0]?.issue));
      expect(issue.state).toBe("closed");
      expect(issue.body ?? "").toContain(`${URL_OF_INSTALL}/${request.key}`);
      expect(issue.comments.length).toBeGreaterThanOrEqual(2);
      expectNoSeededText(issue.body ?? "", `the body of ${request.key}'s issue`);
      for (const { body } of issue.comments) expectNoSeededText(body, `a comment on ${request.key}'s issue`);
    }
    const sent = harness.stub.received.filter(({ host, path }) => host === "api" && path.startsWith("/repos/acme/fe-intake/"));
    expect(sent.length).toBeGreaterThan(0);
    for (const call of sent) {
      // The request's title is the one text people wrote that a mirror carries, as its issue's title.
      const body = call.body === "" ? {} : (JSON.parse(call.body) as Record<string, unknown>);
      delete body["title"];
      expectNoSeededText(`${call.path}${call.query}${JSON.stringify(body)}`, `${call.method} ${call.path}`);
    }
  });

  it.todo("is in no body and no comment Tiehall writes into Jira, once the Jira mirror writes them (task 25.6)");
});

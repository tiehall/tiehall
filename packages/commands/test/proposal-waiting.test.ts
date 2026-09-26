import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { notifyWaitingProposals, openMailer, type Mailer } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Where a proposal waits (requests: Where a proposal waits; requester-loop:
// The web inbox; design.md, Decisions this change rests on: D30 (4); design.md,
// Self-hosting decisions: S7 and S10). Who a proposal waits for is decided at
// each moment: its accountable human first, then each person who may give the
// other side's confirmation, following claims, releases, removals and team
// changes. It is listed in the standing list of each of their web inboxes. With
// SMTP set, each of them gets an email when it starts to wait for them, a
// person who becomes able to give a waiting confirmation included; without
// it, Tiehall sends none, and the standing list is where they find it.

let install: TestInstall;
let sink: SmtpSink;
let mailer: Mailer;
const user: Record<string, string> = {};

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  for (const login of ["alice", "bob", "erin", "dana", "pia"]) {
    user[login] = await addUser(install.owner, { login, role: login === "pia" ? "admin" : "member" });
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [user[login], `${login}@acme.example`]);
  }
  await joinTeams(install.owner, user["alice"] ?? "", be);
  for (const login of ["bob", "erin", "dana"]) await joinTeams(install.owner, user[login] ?? "", fe);
});

beforeEach(async () => {
  sink = await startSmtpSink();
  mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });
});

afterEach(async () => {
  mailer.close();
  await sink.close();
});

afterAll(async () => {
  await install.close();
});

const id = (login: string) => user[login] ?? "";

/** The ids of the proposals waiting in the standing list of the user's web inbox. */
async function waitingFor(login: string): Promise<string[]> {
  const result = await install.web(sessionOf(id(login))).read<{ waiting: { id: string }[] }>("inbox.standing_list", {});
  if (!result.ok) throw new Error(`inbox.standing_list answered ${result.problem.status}`);
  return result.output.waiting.map((proposal) => proposal.id);
}

/** Who among these people finds the proposal waiting in their web inbox. */
async function whoFinds(proposal: string, logins = ["alice", "bob", "erin", "dana"]): Promise<string[]> {
  const found: string[] = [];
  for (const login of logins) if ((await waitingFor(login)).includes(proposal)) found.push(login);
  return found;
}

async function notify(with_ = mailer): Promise<void> {
  await notifyWaitingProposals.handle(
    { id: "notify", queue: notifyWaitingProposals.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), mailer: with_, installUrl: URL_OF_INSTALL },
  );
}

/**
 * Who got an email so far about a proposal on this request, in the order of
 * their addresses, with each email's subject and whether its text shows the
 * proposal's expiry.
 */
function emails(key: string, expiresAt?: string) {
  return sink.messages
    .map(({ to, data }) => {
      const subject = /^Subject: (.*)$/im.exec(data.slice(0, data.indexOf("\r\n\r\n")).replace(/\r\n[ \t]+/g, " "))?.[1];
      const text = data.replace(/=\r\n/g, "");
      return { to: to.join(","), subject, showsExpiry: expiresAt === undefined ? undefined : text.includes(expiresAt) };
    })
    .filter(({ subject }) => subject?.includes(` ${key} `))
    .sort((a, b) => a.to.localeCompare(b.to));
}

const confirm = (login: string, proposal: string) => install.confirm(sessionOf(id(login)), "proposals.confirm", { proposal });

async function proposeScopeWhileClaimedBy(claimant: string) {
  const request = await openRequest(install, tokenOf(id("alice")), { targetTeam: "FE" });
  await callApi(install, tokenOf(id(claimant)), "POST", `/api/v1/requests/${request.key}/claim`);
  const answer = await sendApi(install, tokenOf(id("alice")), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
    body: { packet: { ...packetOf(), untrusted: { need: "Changed after the claim." } } },
    headers: { "if-match": '"1"' },
  });
  return { request, proposal: answer.body.proposal as { id: string; expiresAt: string } };
}

describe("a proposal", () => {
  it("started through the CLI waits in its accountable human's web inbox, who gets an email that shows its expiry", async () => {
    const request = await openRequest(install, tokenOf(id("alice")), { targetTeam: "FE" });
    const answer = await callApi(install, oauthTokenOf(id("bob"), "tiehall-cli", "cli"), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    const { id: proposal, expiresAt } = answer.body.proposal;
    expect(await whoFinds(proposal)).toEqual(["bob"]);
    await notify();
    expect(emails(request.key, expiresAt)).toEqual([
      { to: "bob@acme.example", subject: `Tiehall: a proposal on ${request.key} waits for your confirmation`, showsExpiry: true },
    ]);
    await notify();
    expect(emails(request.key)).toHaveLength(1);
  });

  it("sends no email without SMTP, and still waits in the web inbox", async () => {
    const request = await openRequest(install, tokenOf(id("alice")), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(id("bob")), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    await notify(openMailer(undefined));
    expect(sink.connections).toBe(0);
    expect(await whoFinds(proposal)).toEqual(["bob"]);
  });

  it("moves to the other side's web inboxes once its accountable human confirmed a due date, and leaves them once confirmed", async () => {
    const request = await openRequest(install, tokenOf(id("alice")), { targetTeam: "FE" });
    const answer = await sendApi(install, tokenOf(id("alice")), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
      body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
      headers: { "if-match": '"1"' },
    });
    const { id: proposal, expiresAt } = answer.body.proposal;
    expect(await whoFinds(proposal)).toEqual(["alice"]);
    await notify();
    expect((await confirm("alice", proposal)).status).toBe(200);
    expect(await whoFinds(proposal)).toEqual(["bob", "erin", "dana"]);
    await notify();
    expect(emails(request.key, expiresAt).map(({ to, showsExpiry }) => [to, showsExpiry])).toEqual([
      ["alice@acme.example", true],
      ["bob@acme.example", true],
      ["dana@acme.example", true],
      ["erin@acme.example", true],
    ]);
    const read = await callApi(install, tokenOf(id("erin")), "GET", `/api/v1/proposals/${proposal}`);
    expect(read.body.confirmations).toMatchObject({ received: [{ step: "accountable_human", user: { login: "alice" } }], needed: [{}, { rules: ["target_team"] }] });
    expect((await confirm("bob", proposal)).status).toBe(200);
    expect(await whoFinds(proposal)).toEqual([]);
  });

  it("for a scope change follows the claim: nobody while it is released, then the new claimant, who gets an email", async () => {
    const { request, proposal } = await proposeScopeWhileClaimedBy("bob");
    expect((await confirm("alice", proposal.id)).status).toBe(200);
    expect(await whoFinds(proposal.id)).toEqual(["bob"]);
    await notify();
    expect(emails(request.key).map(({ to }) => to)).toEqual(["bob@acme.example"]);
    await callApi(install, tokenOf(id("bob")), "POST", `/api/v1/requests/${request.key}/status`, { state: "open" });
    expect(await whoFinds(proposal.id)).toEqual([]);
    await callApi(install, tokenOf(id("erin")), "POST", `/api/v1/requests/${request.key}/claim`);
    expect(await whoFinds(proposal.id)).toEqual(["erin"]);
    await notify();
    expect(emails(request.key).map(({ to }) => to)).toEqual(["bob@acme.example", "erin@acme.example"]);
  });

  it("passes to the target team when its claimant is removed from the install", async () => {
    const { proposal } = await proposeScopeWhileClaimedBy("dana");
    expect((await confirm("alice", proposal.id)).status).toBe(200);
    expect(await whoFinds(proposal.id)).toEqual(["dana"]);
    expect((await install.confirm(sessionOf(id("pia")), "members.remove", { userId: id("dana") })).status).toBe(200);
    expect(await whoFinds(proposal.id, ["alice", "bob", "erin"])).toEqual(["bob", "erin"]);
  });
});

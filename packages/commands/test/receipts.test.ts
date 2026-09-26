import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { emailReceipts, expireProposals, openMailer, type Mailer } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Receipts (requests: Receipts; requester-loop: The web inbox; design.md,
// Decisions this change rests on: D23, D28 #61, D30 (4); design.md,
// Self-hosting decisions: S7 and S10). After every confirmation, the person who
// gave it gets a receipt that states, in Tiehall's own words, what they
// confirmed: in the standing list of their web inbox and, with SMTP set, by
// email. For a commitment that needs each side, the accountable human's
// receipt says it waits for the other side, and when the other side's
// confirmation makes it take effect, both people get a receipt that says so.
// If it ends without taking effect instead, the accountable human's receipt
// shows how. Receipt emails are transactional: turning off the daily digest
// does not stop them.

let install: TestInstall;
let clock = new Date("2026-10-01T09:00:00Z");
let sink: SmtpSink;
let mailer: Mailer;
let alice: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  for (const [id, login] of [[alice, "alice"], [bob, "bob"]] as const) {
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [id, `${login}@acme.example`]);
  }
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

/** The receipts in the standing list of the user's web inbox about one request, oldest first. */
async function receiptsOf(user: string, key: string): Promise<string[]> {
  const result = await install.web(sessionOf(user)).read<{ receipts: { text: string; proposal: { request: { key: string } } }[] }>("inbox.standing_list", {});
  if (!result.ok) throw new Error(`inbox.standing_list answered ${result.problem.status}`);
  return result.output.receipts.filter((receipt) => receipt.proposal.request.key === key).map(({ text }) => text);
}

async function sendReceipts(with_ = mailer): Promise<void> {
  await emailReceipts.handle(
    { id: "receipts", queue: emailReceipts.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => clock, mailer: with_, installUrl: URL_OF_INSTALL },
  );
}

/** The receipt emails sent about a request: to whom, and the receipt's sentence each holds. */
function receiptEmails(key: string) {
  return sink.messages
    .map(({ to, data }) => ({ to: to.join(","), data: data.replace(/=\r\n/g, "").replace(/\r\n/g, "\n") }))
    .filter(({ data }) => data.includes(`Subject: Tiehall: receipt for your confirmation on ${key}`))
    .map(({ to, data }) => ({ to, text: data.slice(data.indexOf("\n\n") + 2).split("\n")[0] ?? "" }));
}

const confirm = (user: string, proposal: string) => install.confirm(sessionOf(user), "proposals.confirm", { proposal });

async function dueDateProposal() {
  const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  const answer = await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
    body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
    headers: { "if-match": '"1"' },
  });
  return { key: request.key as string, proposal: answer.body.proposal.id as string };
}

describe("a receipt", () => {
  it("follows a decline's confirmation, in the web inbox and by email", async () => {
    clock = new Date("2026-10-01T09:00:00Z");
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    expect((await confirm(bob, proposal)).status).toBe(200);
    const sentence = `${request.key} was declined, with your confirmation.`;
    expect(await receiptsOf(bob, request.key)).toEqual([sentence]);
    await sendReceipts();
    expect(receiptEmails(request.key)).toEqual([{ to: "bob@acme.example", text: sentence }]);
    // It links the decline's undo page, for the 15 minutes it can be undone.
    const email = (sink.messages.at(-1)?.data ?? "").replace(/=\r\n/g, "");
    expect(email).toContain(`You can undo it until 2026-10-01T09:15:00.000Z on its undo page: ${URL_OF_INSTALL}/confirm/${proposal}/undo`);
    await sendReceipts();
    expect(receiptEmails(request.key)).toHaveLength(1);
  });

  it("is listed without SMTP, and no email is sent", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    expect((await confirm(bob, proposal)).status).toBe(200);
    await sendReceipts(openMailer(undefined));
    expect(sink.connections).toBe(0);
    expect(await receiptsOf(bob, request.key)).toEqual([`${request.key} was declined, with your confirmation.`]);
  });

  it("goes to each side for a two-sided due date, and a final one to both when it takes effect", async () => {
    clock = new Date("2026-10-03T09:00:00Z");
    const { key, proposal } = await dueDateProposal();
    clock = new Date("2026-10-03T10:00:00Z");
    expect((await confirm(alice, proposal)).status).toBe(200);
    const waits = `You confirmed setting the due date of ${key} to 2026-10-15; it waits for a confirmation from the other side of the request.`;
    expect(await receiptsOf(alice, key)).toEqual([waits]);
    clock = new Date("2026-10-03T11:00:00Z");
    expect((await confirm(bob, proposal)).status).toBe(200);
    const tookEffect = `The due date of ${key} was set to 2026-10-15, with your confirmation.`;
    expect(await receiptsOf(alice, key)).toEqual([`${waits} The other side confirmed it too.`, tookEffect]);
    expect(await receiptsOf(bob, key)).toEqual([tookEffect]);
    await sendReceipts();
    expect(receiptEmails(key).sort((a, b) => a.to.localeCompare(b.to) || a.text.localeCompare(b.text))).toEqual([
      { to: "alice@acme.example", text: tookEffect },
      // Emailed once Bob had confirmed too, its words say so.
      { to: "alice@acme.example", text: `${waits} The other side confirmed it too.` },
      { to: "bob@acme.example", text: tookEffect },
    ]);
  });

  it("shows that the other side never confirmed once the proposal expired", async () => {
    clock = new Date("2026-10-01T09:00:00Z");
    const { key, proposal } = await dueDateProposal();
    clock = new Date("2026-10-02T09:00:00Z");
    expect((await confirm(alice, proposal)).status).toBe(200);
    await expireProposals.handle(
      { id: "expire", queue: expireProposals.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date("2026-10-08T09:00:00Z") },
    );
    expect(await receiptsOf(alice, key)).toEqual([
      `You confirmed setting the due date of ${key} to 2026-10-15; it waits for a confirmation from the other side of the request. It expired before the other side confirmed it, so it did not take effect.`,
    ]);
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}/packet`)).body.packet.due_date).toBeUndefined();
  });

  it("is emailed to a person who turned off the daily digest", async () => {
    await install.owner.query("UPDATE users SET digest_enabled = false WHERE id = $1", [bob]);
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    expect((await confirm(bob, proposal)).status).toBe(200);
    await sendReceipts();
    expect(receiptEmails(request.key)).toEqual([{ to: "bob@acme.example", text: `${request.key} was declined, with your confirmation.` }]);
  });
});

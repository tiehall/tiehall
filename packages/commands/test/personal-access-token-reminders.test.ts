import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { openMailer, remindPersonalAccessTokenOwners, type Mailer } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";

// PAT owners are reminded before expiry (agent-access: PAT owners are reminded
// before expiry; requester-loop: The web inbox; self-host-install: Optional
// email through SMTP; design.md, Decisions this change rests on: D28 #46;
// design.md, Self-hosting decisions: S10). A job that runs every hour reminds
// the owner of every personal access token on the UTC day 14 days before the
// day it expires, and again 3 days before: each reminder is listed in the
// standing list of the owner's web inbox and, when SMTP is set up, emailed to
// them once. A token that did not exist yet on a reminder's day gets no such
// reminder. The clock is the test's.

let install: TestInstall;
let clock = new Date("2026-10-02T12:00:00Z");
let lee: string;
let kim: string;
let sink: SmtpSink;
let mailer: Mailer;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  lee = await addUser(install.owner, { login: "lee" });
  kim = await addUser(install.owner, { login: "kim" });
  for (const [id, login] of [[lee, "lee"], [kim, "kim"]] as const) {
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

/** Creates a personal access token for the user in the web UI, with the confirmation step, now. */
async function createToken(userId: string, name: string, expiresInDays: number): Promise<void> {
  const answer = await install.confirm(sessionOf(userId), "personal_access_tokens.create", { name, scopes: ["requests:read"], expiresInDays });
  if (answer.status !== 200) throw new Error(`the creation answered ${answer.status}: ${await answer.text()}`);
}

/** Runs the reminder job at this moment, with or without SMTP. */
async function remindAt(at: string, withMailer: Mailer): Promise<void> {
  clock = new Date(at);
  await remindPersonalAccessTokenOwners.handle(
    { id: "reminders", queue: remindPersonalAccessTokenOwners.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => clock, mailer: withMailer, installUrl: URL_OF_INSTALL },
  );
}

/** The reminders in the standing list of the user's web inbox, as their days before expiry and what they say. */
async function remindersOf(userId: string): Promise<{ daysBefore: number; text: string; createdAt: string }[]> {
  const result = await install.web(sessionOf(userId)).read<{ reminders: { daysBefore: number; text: string; createdAt: string }[] }>("inbox.standing_list", {});
  if (!result.ok) throw new Error(`inbox.standing_list answered ${result.problem.status}`);
  return result.output.reminders.map(({ daysBefore, text, createdAt }) => ({ daysBefore, text, createdAt }));
}

/** The reminder emails sent to an address, as their subject and first line. */
function remindersTo(address: string): { subject: string; first: string }[] {
  return sink.messages
    .filter(({ to }) => to.includes(address))
    .map(({ data }) => data.replace(/=\r\n/g, "").replace(/\r\n/g, "\n"))
    .filter((data) => /^Subject: Tiehall: your personal access token expires/m.test(data))
    .map((data) => ({ subject: /^Subject: (.*)$/m.exec(data)?.[1] ?? "", first: data.slice(data.indexOf("\n\n") + 2).split("\n")[0] ?? "" }));
}

describe("a PAT that expires on 2026-12-31, with SMTP set up", () => {
  beforeAll(async () => {
    // Created on 2026-10-02 at noon, for 90 days: it expires on 2026-12-31 at noon.
    clock = new Date("2026-10-02T12:00:00Z");
    await createToken(lee, "Release script", 90);
  });

  it("gives no reminder before 2026-12-17", async () => {
    await remindAt("2026-12-16T23:17:00Z", mailer);
    expect(await remindersOf(lee)).toEqual([]);
    expect(remindersTo("lee@acme.example")).toEqual([]);
  });

  it("gives a reminder on 2026-12-17, in the web inbox and by email, once", async () => {
    await remindAt("2026-12-17T00:17:00Z", mailer);
    await remindAt("2026-12-17T01:17:00Z", mailer);
    expect(await remindersOf(lee)).toEqual([
      {
        daysBefore: 14,
        text: "Your personal access token created on 2026-10-02 expires on 2026-12-31 (UTC), in 14 days. Create a new one on your Connected agents and tokens page before then.",
        createdAt: "2026-12-17T00:17:00.000Z",
      },
    ]);
    expect(remindersTo("lee@acme.example")).toEqual([
      {
        subject: "Tiehall: your personal access token expires on 2026-12-31",
        first: "Your personal access token created on 2026-10-02 expires on 2026-12-31 (UTC), in 14 days.",
      },
    ]);
  });

  it("gives the second reminder on 2026-12-28, in the web inbox and by email, and keeps the first listed", async () => {
    await remindAt("2026-12-27T23:17:00Z", mailer);
    expect((await remindersOf(lee)).map(({ daysBefore }) => daysBefore)).toEqual([14]);
    await remindAt("2026-12-28T00:17:00Z", mailer);
    await remindAt("2026-12-29T00:17:00Z", mailer);
    expect(await remindersOf(lee)).toEqual([
      expect.objectContaining({ daysBefore: 14, createdAt: "2026-12-17T00:17:00.000Z" }),
      {
        daysBefore: 3,
        text: "Your personal access token created on 2026-10-02 expires on 2026-12-31 (UTC), in 3 days. Create a new one on your Connected agents and tokens page before then.",
        createdAt: "2026-12-28T00:17:00.000Z",
      },
    ]);
    expect(remindersTo("lee@acme.example").map(({ first }) => first)).toEqual([
      "Your personal access token created on 2026-10-02 expires on 2026-12-31 (UTC), in 14 days.",
      "Your personal access token created on 2026-10-02 expires on 2026-12-31 (UTC), in 3 days.",
    ]);
  });

  it("lists no reminder of a token once it has expired", async () => {
    await remindAt("2026-12-31T12:00:01Z", mailer);
    expect(await remindersOf(lee)).toEqual([]);
  });
});

describe("a PAT that expires on 2026-12-31, without SMTP", () => {
  it("gives both reminders, which stay in the web inbox, and sends no email", async () => {
    const withoutSmtp = openMailer(undefined);
    clock = new Date("2026-10-02T12:00:00Z");
    await createToken(kim, "Nightly sync", 90);
    await remindAt("2026-12-17T08:17:00Z", withoutSmtp);
    await remindAt("2026-12-28T08:17:00Z", withoutSmtp);
    expect((await remindersOf(kim)).map(({ daysBefore, createdAt }) => ({ daysBefore, createdAt }))).toEqual([
      { daysBefore: 14, createdAt: "2026-12-17T08:17:00.000Z" },
      { daysBefore: 3, createdAt: "2026-12-28T08:17:00.000Z" },
    ]);
    expect(remindersTo("kim@acme.example")).toEqual([]);
  });
});

describe("a PAT created less than 14 days before it expires", () => {
  it("gets no reminder 14 days before, and the one 3 days before", async () => {
    const ivo = await addUser(install.owner, { login: "ivo" });
    // Created on 2027-01-02 for 10 days: it expires on 2027-01-12.
    clock = new Date("2027-01-02T09:00:00Z");
    await createToken(ivo, "Short job", 10);
    await remindAt("2027-01-02T10:17:00Z", openMailer(undefined));
    expect(await remindersOf(ivo)).toEqual([]);
    await remindAt("2027-01-09T10:17:00Z", openMailer(undefined));
    expect((await remindersOf(ivo)).map(({ daysBefore }) => daysBefore)).toEqual([3]);
  });
});

describe("a revoked PAT", () => {
  it("gets no reminder", async () => {
    const uma = await addUser(install.owner, { login: "uma" });
    clock = new Date("2027-02-01T09:00:00Z");
    await createToken(uma, "Old script", 20);
    await install.owner.query("UPDATE personal_access_tokens SET revoked_at = $2 WHERE user_id = $1", [uma, new Date("2027-02-02T09:00:00Z")]);
    await remindAt("2027-02-18T10:17:00Z", openMailer(undefined));
    expect(await remindersOf(uma)).toEqual([]);
    const { rows } = await install.owner.query("SELECT count(*)::int AS n FROM personal_access_token_reminders WHERE user_id = $1", [uma]);
    expect(rows[0].n).toBe(0);
  });
});

// How the reminders are timed (agent-access: PAT owners are reminded before expiry; decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (20)): a reminder whose day came while the job did not run is made at
// its next run; only a member's token is reminded; neither the web inbox nor the email says the token's label, which
// is its owner's own text; and a reminder stays in the standing list only until the token expires or is revoked.

/** Gives the user a GitHub primary verified email, to which reminders are emailed. */
async function withEmail(userId: string, address: string): Promise<void> {
  await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [userId, address]);
}

/** The reminders made for the user, as their days before expiry, whether or not the standing list shows them. */
async function remindersMadeFor(userId: string): Promise<number[]> {
  const { rows } = await install.owner.query<{ days_before: number }>(
    "SELECT days_before FROM personal_access_token_reminders WHERE user_id = $1 ORDER BY created_at, days_before DESC",
    [userId],
  );
  return rows.map(({ days_before }) => days_before);
}

describe("a reminder whose day passed while the job did not run", () => {
  it("is made at the job's next run, in the web inbox and by email, for each reminder it missed", async () => {
    const noa = await addUser(install.owner, { login: "noa" });
    await withEmail(noa, "noa@acme.example");
    // Created on 2027-03-01 for 30 days: it expires on 2027-03-31, and is reminded of on 2027-03-17 and 2027-03-28.
    clock = new Date("2027-03-01T09:00:00Z");
    await createToken(noa, "Catch-up script", 30);
    await remindAt("2027-03-16T10:17:00Z", mailer);
    expect(await remindersOf(noa)).toEqual([]);
    // The worker is stopped from 2027-03-16 until 2027-03-20, over the first reminder's day.
    await remindAt("2027-03-20T10:17:00Z", mailer);
    expect((await remindersOf(noa)).map(({ daysBefore, createdAt }) => ({ daysBefore, createdAt }))).toEqual([
      { daysBefore: 14, createdAt: "2027-03-20T10:17:00.000Z" },
    ]);
    expect(remindersTo("noa@acme.example").map(({ subject }) => subject)).toEqual(["Tiehall: your personal access token expires on 2027-03-31"]);
    // Stopped again over the second reminder's day, 2027-03-28.
    await remindAt("2027-03-27T10:17:00Z", mailer);
    await remindAt("2027-03-30T10:17:00Z", mailer);
    expect((await remindersOf(noa)).map(({ daysBefore, createdAt }) => ({ daysBefore, createdAt }))).toEqual([
      { daysBefore: 14, createdAt: "2027-03-20T10:17:00.000Z" },
      { daysBefore: 3, createdAt: "2027-03-30T10:17:00.000Z" },
    ]);
    expect(remindersTo("noa@acme.example")).toHaveLength(2);
  });
});

describe("a removed member's PAT", () => {
  // A removal revokes the person's tokens in its own write (teams-and-roles: Removing a member); the reminder job
  // also reminds only a member, so a token whose owner's membership is gone is not reminded even where nothing
  // revoked it.
  it("gets no reminder, whether the removal revoked it or only the owner's membership is gone", async () => {
    const admin = await addUser(install.owner, { login: "ada-admin", role: "admin" });
    const rio = await addUser(install.owner, { login: "rio" });
    const sol = await addUser(install.owner, { login: "sol" });
    await withEmail(rio, "rio@acme.example");
    await withEmail(sol, "sol@acme.example");
    // Created on 2027-04-01 for 20 days: they expire on 2027-04-21, and would be reminded of on 2027-04-07.
    clock = new Date("2027-04-01T09:00:00Z");
    await createToken(rio, "Rio's job", 20);
    await createToken(sol, "Sol's job", 20);
    expect((await install.confirm(sessionOf(admin), "members.remove", { userId: rio })).status).toBe(200);
    await install.owner.query("DELETE FROM members WHERE user_id = $1", [sol]);
    const { rows } = await install.owner.query("SELECT count(*)::int AS n FROM personal_access_tokens WHERE user_id = $1 AND revoked_at IS NULL", [sol]);
    expect(rows[0].n).toBe(1);
    await remindAt("2027-04-07T10:17:00Z", mailer);
    await remindAt("2027-04-18T10:17:00Z", mailer);
    expect(await remindersMadeFor(rio)).toEqual([]);
    expect(await remindersMadeFor(sol)).toEqual([]);
    expect(remindersTo("rio@acme.example")).toEqual([]);
    expect(remindersTo("sol@acme.example")).toEqual([]);
  });
});

describe("a reminder of a PAT", () => {
  it("never says the token's label, in the web inbox or by email", async () => {
    const tia = await addUser(install.owner, { login: "tia" });
    await withEmail(tia, "tia@acme.example");
    const label = "Payments deploy bot 7Q";
    clock = new Date("2027-05-01T09:00:00Z");
    await createToken(tia, label, 30);
    await remindAt("2027-05-17T10:17:00Z", mailer);
    const reminders = await remindersOf(tia);
    expect(reminders.map(({ daysBefore }) => daysBefore)).toEqual([14]);
    for (const reminder of reminders) expect(reminder.text).not.toContain("Payments deploy bot");
    const emails = sink.messages.filter(({ to }) => to.includes("tia@acme.example")).map(({ data }) => data.replace(/=\r\n/g, ""));
    expect(emails).toHaveLength(1);
    for (const email of emails) {
      expect(email).toContain("expires on 2027-05-31");
      expect(email).not.toContain("Payments deploy bot");
    }
  });

  it("leaves the standing list once its token is revoked", async () => {
    const uli = await addUser(install.owner, { login: "uli" });
    clock = new Date("2027-06-01T09:00:00Z");
    await createToken(uli, "Uli's job", 30);
    await remindAt("2027-06-17T10:17:00Z", openMailer(undefined));
    expect((await remindersOf(uli)).map(({ daysBefore }) => daysBefore)).toEqual([14]);
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM personal_access_tokens WHERE user_id = $1", [uli]);
    const session = sessionOf(uli);
    const revoked = await install.web(session).write("personal_access_tokens.revoke", { tokenId: rows[0]?.id }, install.fromThePage(session));
    expect(revoked).toMatchObject({ ok: true });
    expect(await remindersOf(uli)).toEqual([]);
    await remindAt("2027-06-28T10:17:00Z", openMailer(undefined));
    expect(await remindersOf(uli)).toEqual([]);
    expect(await remindersMadeFor(uli)).toEqual([14]);
  });
});

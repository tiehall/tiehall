import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { consumersOf, createInboxRoute, openMailer, requestConsumerReconfirmations, withOrg, type Mailer, type WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// Declarations are re-confirmed every 90 days (contract-changes: Declarations
// are re-confirmed every 90 days; requester-loop: The web inbox;
// self-host-install: Optional email through SMTP; design.md, Decisions this
// change rests on: D15, D28 #61, #72, #73; D29 (6); design.md, Self-hosting
// decisions: S10). A daily job asks the consuming team to re-confirm each
// declaration on the UTC day 90 days after the day it was last confirmed: a
// re-confirmation request in the team's inbox, which lists it in the web
// inbox of each member of the team until the declaration is re-confirmed, and,
// when SMTP is set, an email to each member, which the daily digest switch
// does not stop. Any member of the team re-confirms it, which moves its last
// confirmation to that time and changes nothing else; anyone else gets 403. A
// declaration left unconfirmed 30 more days, 120 days after its last
// confirmation, is marked stale until it is re-confirmed, and keeps routing.
// The clock is the test's: the declarations were last confirmed on
// 2026-10-01.

let install: TestInstall;
let clock = new Date("2026-10-01T10:00:00Z");
let sink: SmtpSink;
let mailer: Mailer;
let ada: WebSessionCaller;
let ayse: WebSessionCaller;
let mehmet: WebSessionCaller;
let zeynep: WebSessionCaller;
let fe: string;
let mobile: string;
let paymentsApi: string;
let billingApi: string;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  ayse = sessionOf(await addUser(install.owner, { login: "ayse" }));
  mehmet = sessionOf(await addUser(install.owner, { login: "mehmet" }));
  zeynep = sessionOf(await addUser(install.owner, { login: "zeynep" }));
  for (const [caller, login] of [[ayse, "ayse"], [mehmet, "mehmet"], [zeynep, "zeynep"]] as const) {
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [caller.userId, `${login}@acme.example`]);
  }
  // Mehmet has turned the daily digest off.
  await install.owner.query("UPDATE users SET digest_enabled = false WHERE id = $1", [mehmet.userId]);
  fe = await addTeam(install.owner, "FE");
  mobile = await addTeam(install.owner, "MOBILE");
  const pay = await addTeam(install.owner, "PAY");
  await joinTeams(install.owner, ayse.userId, fe);
  await joinTeams(install.owner, mehmet.userId, fe);
  await joinTeams(install.owner, zeynep.userId, mobile);
  await addInstallation(install.owner, {
    account: "acme",
    repositories: [
      { fullName: "acme/payments", id: 7001 },
      { fullName: "acme/billing", id: 7002 },
    ],
  });
  for (const [name, repository] of [
    ["payments-api", "acme/payments"],
    ["billing-api", "acme/billing"],
  ]) {
    expect((await install.confirm(ada, "apis.register", { name, team: pay, repository })).status).toBe(200);
  }
  const { rows } = await install.owner.query<{ id: string; name: string }>("SELECT id, name FROM apis");
  paymentsApi = rows.find(({ name }) => name === "payments-api")?.id ?? "";
  billingApi = rows.find(({ name }) => name === "billing-api")?.id ?? "";
  sink = await startSmtpSink();
  mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });
}, 60_000);

afterAll(async () => {
  mailer?.close();
  await sink?.close();
  await install?.close();
});

beforeEach(async () => {
  await install.owner.query("DELETE FROM api_consumer_reconfirmation_emails");
  await install.owner.query("DELETE FROM api_consumers");
  // Ayşe declares, on 2026-10-01, that FE consumes payments-api, and Zeynep that MOBILE consumes billing-api.
  clock = new Date("2026-10-01T10:00:00Z");
  await install.execute("apis.declare_consumer", ayse, { api: paymentsApi, team: fe });
  await install.execute("apis.declare_consumer", zeynep, { api: billingApi, team: mobile });
});

/** Runs the daily job at this moment, with SMTP set up, or, given "no SMTP", without. */
async function runJobAt(at: string, smtp: "SMTP" | "no SMTP" = "SMTP"): Promise<void> {
  clock = new Date(at);
  await requestConsumerReconfirmations.handle(
    { id: "reconfirmations", queue: requestConsumerReconfirmations.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => clock, ...(smtp === "SMTP" ? { mailer } : {}), installUrl: URL_OF_INSTALL },
  );
}

/** The re-confirmation requests in the standing list of the person's web inbox, as the API, the team and whether it is stale. */
async function requestsOf(caller: WebSessionCaller): Promise<{ api: string; team: string; stale: boolean; text: string }[]> {
  const result = await install.web(caller).read<{ reconfirmations: { api: { name: string }; team: { key: string }; stale: boolean; text: string }[] }>("inbox.standing_list", {});
  if (!result.ok) throw new Error(`inbox.standing_list answered ${result.problem.status}`);
  return result.output.reconfirmations.map(({ api, team, stale, text }) => ({ api: api.name, team: team.key, stale, text }));
}

/** The re-confirmation emails sent to an address since a count of messages, by subject. */
function emailsTo(address: string, since: number): string[] {
  return sink.messages
    .slice(since)
    .filter(({ to }) => to.includes(address))
    .map(({ data }) => data.replace(/=\r\n/g, "").replace(/\r\n/g, "\n"))
    .filter((data) => /^Subject: Tiehall: .* re-confirm/m.test(data))
    .map((data) => /^Subject: (.*)$/m.exec(data)?.[1] ?? "");
}

/** The last event's number. */
async function lastEvent(): Promise<number> {
  const { rows } = await install.owner.query("SELECT coalesce(max(number), 0)::int AS n FROM events");
  return rows[0].n;
}

/** The events after that number. */
async function eventsSince(number: number): Promise<Record<string, unknown>[]> {
  const { rows } = await install.owner.query("SELECT type, class, actor_kind, actor_user_id, data FROM events WHERE number > $1 ORDER BY number", [number]);
  return rows;
}

/** FE's declaration for payments-api, as stored. */
async function feDeclaration(): Promise<{ declared_by: string; declared_at: Date; last_confirmed_at: Date; stale: boolean; requested: boolean }> {
  const { rows } = await install.owner.query(
    `SELECT declared_by, declared_at, last_confirmed_at, stale_at IS NOT NULL AS stale, reconfirmation_requested_at IS NOT NULL AS requested
       FROM api_consumers WHERE api_id = $1 AND team_id = $2`,
    [paymentsApi, fe],
  );
  return rows[0];
}

describe("a declaration last confirmed on 2026-10-01, with SMTP set", () => {
  it("is not asked to be re-confirmed on 2026-12-29", async () => {
    const before = sink.messages.length;
    await runJobAt("2026-12-29T00:11:00Z");
    await runJobAt("2026-12-29T23:59:00Z");

    expect(await requestsOf(ayse)).toEqual([]);
    expect(emailsTo("ayse@acme.example", before)).toEqual([]);
    expect((await feDeclaration()).requested).toBe(false);
  });

  it("is asked on 2026-12-30: a request in the web inbox of each member of the team, and an email to each, which the digest switch does not stop, once", async () => {
    const before = sink.messages.length;
    await runJobAt("2026-12-30T00:11:00Z");
    await runJobAt("2026-12-30T12:11:00Z");

    for (const member of [ayse, mehmet]) {
      expect(await requestsOf(member)).toEqual([
        {
          api: "payments-api",
          team: "FE",
          stale: false,
          text: "FE declared that it consumes payments-api, last confirmed on 2026-10-01: re-confirm that FE still consumes it, or remove the declaration on FE's page. Unless a member of FE re-confirms it by 2027-01-28, it is marked stale on 2027-01-29, and changes to it still reach FE.",
        },
      ]);
    }
    // MOBILE's declaration of billing-api came due too, for MOBILE alone.
    expect((await requestsOf(zeynep)).map(({ api, team }) => `${team} ${api}`)).toEqual(["MOBILE billing-api"]);
    expect(emailsTo("ayse@acme.example", before)).toEqual(["Tiehall: FE is asked to re-confirm an API it consumes"]);
    expect(emailsTo("mehmet@acme.example", before)).toEqual(["Tiehall: FE is asked to re-confirm an API it consumes"]);
  });

  it("lists the request on the web inbox's page, whose form re-confirms it", async () => {
    await runJobAt("2026-12-30T00:11:00Z");
    const route = createInboxRoute({ execute: install.execute, session: async () => mehmet, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
    const page = await (await route(new Request(`${URL_OF_INSTALL}/inbox`, { headers: { accept: "text/html" } }))).text();
    expect(page).toContain("Declarations to re-confirm");
    expect(page).toContain("FE declared that it consumes payments-api, last confirmed on 2026-10-01");
    expect(page).toContain('<input type="hidden" name="action" value="reconfirm">');

    clock = new Date("2026-12-31T09:00:00Z");
    const posted = await route(
      new Request(`${URL_OF_INSTALL}/inbox`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ action: "reconfirm", api: paymentsApi, team: fe, csrf: install.fromThePage(mehmet).csrfToken ?? "" }).toString(),
      }),
    );

    expect(posted.status).toBe(303);
    expect((await feDeclaration()).last_confirmed_at.toISOString()).toBe("2026-12-31T09:00:00.000Z");
  });

  it("re-confirmed by another member on 2026-12-31 keeps its declarer and changes only its confirmation time, and the request leaves every member's web inbox", async () => {
    await runJobAt("2026-12-30T00:11:00Z");
    const before = await feDeclaration();
    clock = new Date("2026-12-31T09:00:00Z");

    const answer = (await install.execute("apis.reconfirm_consumer", mehmet, { api: paymentsApi, team: fe })) as any;

    expect(answer.declaration).toMatchObject({ declaredBy: { login: "ayse" }, lastConfirmedAt: "2026-12-31T09:00:00.000Z", stale: false });
    expect(await feDeclaration()).toEqual({ ...before, last_confirmed_at: new Date("2026-12-31T09:00:00Z"), requested: false });
    expect(await requestsOf(ayse)).toEqual([]);
    expect(await requestsOf(mehmet)).toEqual([]);
  });

  it("re-confirmed appends a domain event naming the team, the API and the member who re-confirmed it (decisions-from-groups-15-28, D55 (60))", async () => {
    await runJobAt("2026-12-30T00:11:00Z");
    clock = new Date("2026-12-31T09:00:00Z");
    const from = await lastEvent();

    await install.execute("apis.reconfirm_consumer", mehmet, { api: paymentsApi, team: fe });

    expect(await eventsSince(from)).toEqual([
      { type: "api.consumer_reconfirmed", class: "domain", actor_kind: "web_session", actor_user_id: mehmet.userId, data: { apiId: paymentsApi, teamId: fe } },
    ]);
  });

  it("is refused re-confirmation with 403 for a member of another team, and an admin in no team, and its confirmation time stays", async () => {
    const from = await lastEvent();
    await runJobAt("2026-12-30T00:11:00Z");
    clock = new Date("2026-12-31T09:00:00Z");

    await expect(install.execute("apis.reconfirm_consumer", zeynep, { api: paymentsApi, team: fe })).rejects.toMatchObject({ status: 403 });
    await expect(install.execute("apis.reconfirm_consumer", ada, { api: paymentsApi, team: fe })).rejects.toMatchObject({ status: 403 });

    expect((await feDeclaration()).last_confirmed_at.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(await requestsOf(ayse)).toHaveLength(1);
    // A refused re-confirmation appends no event, and neither does the daily job's request to re-confirm.
    expect(await eventsSince(from)).toEqual([]);
  });

  it("left unconfirmed is not stale on 2027-01-28, is marked stale on 2027-01-29, and keeps routing on 2027-02-01", async () => {
    await runJobAt("2026-12-30T00:11:00Z");
    await runJobAt("2027-01-28T00:11:00Z");
    expect((await feDeclaration()).stale).toBe(false);

    await runJobAt("2027-01-29T00:11:00Z");

    expect((await feDeclaration()).stale).toBe(true);
    expect(await requestsOf(ayse)).toEqual([expect.objectContaining({ api: "payments-api", stale: true, text: expect.stringContaining("It is marked stale") })]);
    const page = (await install.execute("apis.list_for_team", ayse, { team: "FE" }, { readOnly: true })) as any;
    expect(page.apis.find(({ id }: { id: string }) => id === paymentsApi).declaration.stale).toBe(true);
    clock = new Date("2027-02-01T08:00:00Z");
    expect((await withOrg(install.db, (context) => consumersOf(context, paymentsApi), { readOnly: true })).map(({ key }) => key)).toEqual(["FE"]);

    // A re-confirmation clears the mark.
    await install.execute("apis.reconfirm_consumer", ayse, { api: paymentsApi, team: fe });
    expect(await feDeclaration()).toMatchObject({ stale: false, requested: false });
  });
});

describe("a declaration that comes due without SMTP", () => {
  it("is listed in the web inbox of each member of the team, and no email is sent", async () => {
    const before = sink.messages.length;

    await runJobAt("2026-12-30T00:11:00Z", "no SMTP");

    expect((await requestsOf(zeynep)).map(({ api }) => api)).toEqual(["billing-api"]);
    expect(sink.messages.length).toBe(before);
  });
});

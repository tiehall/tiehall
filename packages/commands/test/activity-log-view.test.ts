import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_JSON } from "@tiehall/catalog";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { ACTIVITY_LOG_PATH, createActivityLogRoute, pruneSecurityEventOrigins, type WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// The admin view of the activity log (activity-log: The admin view;
// activity-log: The activity log holds domain events and security events;
// activity-log: IP addresses and user agents are kept apart for 90 days;
// activity-log: Security events are shown to admins only; design.md,
// Decisions this change rests on: D28 #4, #9, #48; design.md, Self-hosting
// decisions: S14). An admin views the log in the web UI, newest first, with
// domain and security events, filtered by time, actor, request and event
// type; each event shows its number, time, class, type, the ids it carries
// and who caused it, and a security event its IP address and user agent while
// they are kept. The view is an internal admin operation, activity_log.list,
// offered on no agent surface, and a page at /admin/activity-log.

const USER_AGENT = "Mozilla/5.0 (canary browser)";
const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;
let pia: WebSessionCaller;
let bob: string;
let dana: string;
let lee: string;
let fe1: { id: string; key: string };
let be1: { id: string; key: string };

interface ActivityEvent {
  number: number;
  occurredAt: string;
  class: string;
  type: string;
  data: Record<string, unknown>;
  actor: Record<string, unknown>;
  request?: { id: string; key: string };
  origin?: { ipAddress?: string; userAgent?: string };
  refusedAccount?: { githubAccountId: number; githubLogin: string };
}

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  pia = sessionOf(await addUser(install.owner, { role: "admin", login: "pia" }));
  bob = await addUser(install.owner, { login: "bob" });
  dana = await addUser(install.owner, { login: "dana" });
  lee = await addUser(install.owner, { login: "lee" });
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, dana, be);
  // Domain events: Dana's agent opens FE-1, Bob's agent claims it and asks a question, and Bob's agent opens BE-1.
  fe1 = await openRequest(install, tokenOf(dana), { targetTeam: "FE", title: "Dark mode" });
  expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${fe1.key}/claim`)).status).toBe(200);
  expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${fe1.key}/messages`, { kind: "question", body: "Which endpoint?" })).status).toBe(200);
  be1 = await openRequest(install, tokenOf(bob), { targetTeam: "BE", title: "An index" });
  // Security events: Pia changes Lee's role twice from a browser at 203.0.113.7.
  const origin = { "x-forwarded-for": "203.0.113.7", "user-agent": USER_AGENT };
  expect((await install.confirm(pia, "members.change_role", { userId: lee, role: "admin" }, origin)).status).toBe(200);
  expect((await install.confirm(pia, "members.change_role", { userId: lee, role: "member" }, origin)).status).toBe(200);
});

afterAll(async () => {
  await install.close();
});

/** The admin view as the caller reads it in the web UI. */
async function view(caller: WebSessionCaller, input: Record<string, unknown> = {}) {
  return install.web(caller).read<{ events: ActivityEvent[] }>("activity_log.list", input);
}

async function eventsOf(caller: WebSessionCaller, input: Record<string, unknown> = {}): Promise<ActivityEvent[]> {
  const result = await view(caller, input);
  expect(result).toMatchObject({ ok: true });
  return result.ok ? result.output.events : [];
}

describe("the admin view", () => {
  it("lists domain and security events, newest first, each with its number, time, class, type, ids and actor", async () => {
    const events = await eventsOf(pia);
    expect(events.map(({ number }) => number)).toEqual([...events.map(({ number }) => number)].sort((a, b) => b - a));
    expect(events.map(({ type }) => type)).toEqual([
      "member.role_changed",
      "member.role_changed",
      "request.opened",
      "request.message_posted",
      "request.claimed",
      "request.opened",
    ]);
    const [roleChange] = events;
    expect(roleChange).toMatchObject({
      class: "security",
      type: "member.role_changed",
      data: { userId: lee, role: "member", previousRole: "admin" },
      actor: { kind: "web_session", user: { id: pia.userId, login: "pia", kind: "human", bot: false }, surface: "web" },
      origin: { ipAddress: "203.0.113.7", userAgent: USER_AGENT },
    });
    expect(roleChange?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const claim = events.find(({ type }) => type === "request.claimed");
    expect(claim).toMatchObject({
      class: "domain",
      data: { requestId: fe1.id, userId: bob },
      actor: { kind: "agent", user: { id: bob, login: "bob", kind: "human", bot: false }, surface: "api" },
      request: { id: fe1.id, key: fe1.key },
    });
    expect(claim).not.toHaveProperty("origin");
    const question = events.find(({ type }) => type === "request.message_posted");
    expect(JSON.stringify(question)).not.toContain("Which endpoint?");
  });

  it("filters by request: FE-1's events and no event of any other request, and 404 for a key that names none", async () => {
    const events = await eventsOf(pia, { request: fe1.key });
    expect(events.map(({ type }) => type)).toEqual(["request.message_posted", "request.claimed", "request.opened"]);
    for (const event of events) expect(event.data["requestId"]).toBe(fe1.id);
    expect((await eventsOf(pia, { request: be1.key })).map(({ type }) => type)).toEqual(["request.opened"]);
    expect(await view(pia, { request: "FE-999" })).toMatchObject({ ok: false, problem: { status: 404 } });
  });

  it("filters by actor and type: only the role changes that Pia made", async () => {
    const events = await eventsOf(pia, { actorUserId: pia.userId, type: "member.role_changed" });
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ type: "member.role_changed", actor: { user: { id: pia.userId } } });
    expect(await eventsOf(pia, { actorUserId: bob, type: "member.role_changed" })).toEqual([]);
    expect((await eventsOf(pia, { actorUserId: bob })).map(({ type }) => type)).toEqual(["request.opened", "request.message_posted", "request.claimed"]);
  });

  it("pages newest first: a limit, and the events before a number", async () => {
    const all = await eventsOf(pia);
    const firstPage = await eventsOf(pia, { limit: 2 });
    expect(firstPage).toEqual(all.slice(0, 2));
    const nextPage = await eventsOf(pia, { limit: 2, before: firstPage[1]?.number });
    expect(nextPage).toEqual(all.slice(2, 4));
  });

  it("filters by time: 2026-10-01 from 00:00 to 23:59 UTC shows only events within that range", async () => {
    // The events' times are set as the owner, past the append-only trigger, to known instants.
    const all = await eventsOf(pia);
    const times = ["2026-10-02T00:00:00Z", "2026-10-02T00:00:00Z", "2026-10-01T23:59:00Z", "2026-10-01T12:00:00Z", "2026-10-01T00:00:00Z", "2026-09-30T23:59:59Z"];
    await install.owner.query("BEGIN; SET LOCAL session_replication_role = replica");
    for (const [index, event] of all.entries()) await install.owner.query("UPDATE events SET occurred_at = $1 WHERE number = $2", [times[index], event.number]);
    await install.owner.query("COMMIT");
    const events = await eventsOf(pia, { from: "2026-10-01T00:00:00Z", to: "2026-10-01T23:59:59Z" });
    expect(events.map(({ type }) => type)).toEqual(["request.opened", "request.message_posted", "request.claimed"]);
    for (const { occurredAt } of events) {
      expect(new Date(occurredAt).getTime()).toBeGreaterThanOrEqual(Date.parse("2026-10-01T00:00:00Z"));
      expect(new Date(occurredAt).getTime()).toBeLessThanOrEqual(Date.parse("2026-10-01T23:59:59Z"));
    }
    expect((await eventsOf(pia, { from: "2026-10-02T00:00:00Z" })).map(({ type }) => type)).toEqual(["member.role_changed", "member.role_changed"]);
    expect((await eventsOf(pia, { to: "2026-09-30T23:59:59Z" })).map(({ type }) => type)).toEqual(["request.opened"]);
  });

  it("shows a security event's IP address and user agent while they are kept, and the event without them once they are gone", async () => {
    const before = await eventsOf(pia, { type: "member.role_changed" });
    expect(before.map(({ origin }) => origin)).toEqual([
      { ipAddress: "203.0.113.7", userAgent: USER_AGENT },
      { ipAddress: "203.0.113.7", userAgent: USER_AGENT },
    ]);
    // 91 days after the events, the daily pruning removes them.
    const latest = Math.max(...before.map(({ occurredAt }) => Date.parse(occurredAt)));
    await pruneSecurityEventOrigins.handle(
      { id: "prune", queue: pruneSecurityEventOrigins.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(latest + 91 * DAY) },
    );
    const after = await eventsOf(pia, { type: "member.role_changed" });
    expect(after.map(({ number }) => number)).toEqual(before.map(({ number }) => number));
    for (const event of after) expect(event).not.toHaveProperty("origin");
    expect(JSON.stringify(after)).not.toContain("203.0.113.7");
  });

  it("is offered on no agent surface: neither the OpenAPI document nor the tool list has it, and a token's call gets 404", async () => {
    const document = JSON.parse(OPENAPI_JSON) as { paths: Record<string, Record<string, { operationId?: string }>> };
    const operations = Object.values(document.paths).flatMap((item) => Object.values(item).map(({ operationId }) => operationId));
    expect(operations.length).toBeGreaterThan(0);
    expect(operations).not.toContain("activity_log.list");
    const tools = JSON.parse(readFileSync(new URL("../../../mcp/tools.json", import.meta.url), "utf8")) as { tools: { _meta?: { operationId?: string } }[] };
    expect(tools.tools.map(({ _meta }) => _meta?.operationId)).not.toContain("activity_log.list");
    expect((await callApi(install, tokenOf(pia.userId), "GET", "/api/v1/activity-log")).status).toBe(404);
    await expect(install.execute("activity_log.list", tokenOf(pia.userId), {})).rejects.toMatchObject({ reason: "route-not-found", status: 404 });
  });
});

describe("the page at /admin/activity-log", () => {
  const route = (caller: WebSessionCaller | undefined) =>
    createActivityLogRoute({
      execute: install.execute,
      session: async () => caller,
      url: URL_OF_INSTALL,
      secret: () => install.authSecret,
      logger: { error() {} } as never,
    });

  it("shows an admin the events, with the filters as a form, and cannot be framed", async () => {
    const answer = await route(pia)(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}?request=${fe1.key}`));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await answer.text();
    expect(html).toContain("request.claimed");
    expect(html).toContain("request.opened");
    expect(html).not.toContain("<td>member.role_changed</td>");
    expect(html).toContain(`<td>${fe1.key}</td>`);
    expect(html).toContain("bob");
    expect(html).toMatch(/<form method="get" action="\/admin\/activity-log">/);
    for (const name of ["from", "to", "actor", "request", "type"]) expect(html).toMatch(new RegExp(`name="${name}"`));
    expect(html).not.toContain("Which endpoint?");
  });

  it("shows a security event's IP address and user agent next to it", async () => {
    // The origins are pruned above; a fresh role change has them.
    expect((await install.confirm(pia, "members.change_role", { userId: lee, role: "admin" }, { "x-forwarded-for": "203.0.113.9", "user-agent": USER_AGENT })).status).toBe(200);
    const html = await (await route(pia)(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}?type=member.role_changed`))).text();
    expect(html).toContain("203.0.113.9");
    expect(html).toContain("canary browser");
  });

  it("sends a browser without a session to sign in first, showing nothing, and refuses a bad filter with 400", async () => {
    // agent-surfaces: A browser without a session is sent to sign-in (design.md, Decisions this change rests on: D28 #66).
    const answer = await route(undefined)(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}?type=member.role_changed`));
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(ACTIVITY_LOG_PATH)}`);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await answer.text()).toBe("");
    const post = await route(undefined)(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}`, { method: "POST" }));
    expect(post.status).toBe(404);
    const bad = await route(pia)(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}?from=yesterday`));
    expect(bad.status).toBe(400);
  });
});

// A refused sign-in is named as long as its event (activity-log: IP addresses
// and user agents are kept apart for 90 days; sign-in: Who may sign in;
// D50 (5)). The refused sign-in's security event names a record of the refused
// GitHub account, which holds only the account's numeric id, the login it had
// and the time, and is kept as long as the event: the admin view shows the
// account beside the event, before and after the pruning job deletes the
// refusal's IP address and user agent 91 days later.
describe("a refused sign-in in the admin view", () => {
  const BROWSER = { "x-forwarded-for": "203.0.113.9", "user-agent": "Mozilla/5.0 (refused browser)" };
  let refusedInstall: TestInstall;
  let stub: GitHubStub;
  let harness: SignInHarness;
  let ada: WebSessionCaller;
  let kim: StubUser;
  let marked: StubUser;

  beforeAll(async () => {
    refusedInstall = await startTestInstall();
    stub = await startGitHubStub();
    stub.addOrg({ login: "acme" });
    kim = stub.addUser({ login: "kim-x" });
    // A login with markup, which GitHub never issues, shows that the view escapes whatever the record holds.
    marked = stub.addUser({ login: 'kim<b onclick="x">&amp;' });
    harness = await startSignIn(refusedInstall, stub);
    ada = sessionOf(await addUser(refusedInstall.owner, { role: "admin", login: "ada" }));
    for (const login of [kim.login, marked.login]) expect((await harness.signIn(login, { headers: BROWSER })).response.status).toBe(403);
  }, 60_000);

  afterAll(async () => {
    await stub?.close();
    await refusedInstall?.close();
  });

  async function refusals(): Promise<ActivityEvent[]> {
    const result = await refusedInstall.web(ada).read<{ events: ActivityEvent[] }>("activity_log.list", { type: "sign_in.refused" });
    expect(result).toMatchObject({ ok: true });
    return result.ok ? result.output.events : [];
  }

  const page = async () =>
    (
      await createActivityLogRoute({
        execute: refusedInstall.execute,
        session: async () => ada,
        url: URL_OF_INSTALL,
        secret: () => refusedInstall.authSecret,
        logger: { error() {} } as never,
      })(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}?type=sign_in.refused`))
    ).text();

  it("names the refused account's login and numeric id beside the event, escaped, with its IP address and user agent", async () => {
    const [markedEvent, kimEvent] = await refusals();
    expect(kimEvent).toMatchObject({
      class: "security",
      type: "sign_in.refused",
      refusedAccount: { githubAccountId: kim.id, githubLogin: "kim-x" },
      origin: { ipAddress: "203.0.113.9", userAgent: BROWSER["user-agent"] },
    });
    expect(markedEvent).toMatchObject({ refusedAccount: { githubAccountId: marked.id, githubLogin: marked.login } });
    const html = await page();
    expect(html).toContain("kim-x");
    expect(html).toContain(String(kim.id));
    expect(html).toContain(String(marked.id));
    expect(html).toContain("kim&#60;b onclick=&#34;x&#34;&#62;&#38;amp;");
    expect(html).not.toContain("<b onclick");
    expect(html).toContain("203.0.113.9");
  });

  it("still names the refused account after the pruning job deletes the refusal's IP address and user agent 91 days later, and keeps its record and its event", async () => {
    const before = await refusals();
    const refusalIds = before.map(({ data }) => data["refusalId"]);
    const records = async () =>
      (
        await refusedInstall.owner.query(
          "SELECT id, github_account_id, github_login, refused_at FROM sign_in_refusals WHERE id = ANY($1::uuid[]) ORDER BY refused_at, id",
          [refusalIds],
        )
      ).rows;
    const kept = await records();
    expect(kept).toHaveLength(2);
    const latest = Math.max(...before.map(({ occurredAt }) => Date.parse(occurredAt)));
    await pruneSecurityEventOrigins.handle(
      { id: "prune", queue: pruneSecurityEventOrigins.type.queue, data: {}, signal: new AbortController().signal },
      { database: refusedInstall.db, now: () => new Date(latest + 91 * DAY) },
    );

    const after = await refusals();
    expect(after.map(({ number }) => number)).toEqual(before.map(({ number }) => number));
    for (const event of after) expect(event).not.toHaveProperty("origin");
    expect(after.map(({ refusedAccount }) => refusedAccount)).toEqual(before.map(({ refusedAccount }) => refusedAccount));
    expect(await records()).toEqual(kept);
    const html = await page();
    expect(html).toContain("kim-x");
    expect(html).toContain(String(kim.id));
    expect(html).not.toContain("203.0.113.9");
    expect(html).not.toContain("refused browser");
  });

  it("keeps in a refusal's record only the org, the record's id, the account's numeric id, the login it had and the time", async () => {
    const { rows } = await refusedInstall.owner.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sign_in_refusals' ORDER BY column_name",
    );
    expect(rows.map(({ column_name }) => column_name)).toEqual(["github_account_id", "github_login", "id", "org_id", "refused_at"]);
  });
});

describe("changes to the consumer map in the admin view (decisions-from-groups-15-28, D55 (60))", () => {
  it("are domain events that name the team, the API and who declared, removed or re-confirmed it", async () => {
    const pay = await addTeam(install.owner, "PAY");
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'FE'");
    const fe = rows[0]?.id ?? "";
    await joinTeams(install.owner, lee, fe);
    await addInstallation(install.owner, { account: "acme", repositories: [{ fullName: "acme/payments", id: 7001 }] });
    expect((await install.confirm(pia, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);
    const api = (await install.owner.query<{ id: string }>("SELECT id FROM apis WHERE name = 'payments-api'")).rows[0]?.id ?? "";
    // Bob declares that FE consumes payments-api, Lee re-confirms it, and Bob removes it.
    await install.execute("apis.declare_consumer", sessionOf(bob), { api, team: fe });
    await install.execute("apis.reconfirm_consumer", sessionOf(lee), { api, team: fe });
    await install.execute("apis.remove_consumer", sessionOf(bob), { api, team: fe });

    const events = (await eventsOf(pia, { limit: 3 })).reverse();

    expect(events.map(({ type }) => type)).toEqual(["api.consumer_declared", "api.consumer_reconfirmed", "api.consumer_removed"]);
    const actors = [bob, lee, bob];
    for (const [index, event] of events.entries()) {
      expect(event).toMatchObject({
        class: "domain",
        data: { apiId: api, teamId: fe },
        actor: { kind: "web_session", user: { id: actors[index] }, surface: "web" },
      });
      expect(event).not.toHaveProperty("request");
    }
    expect((await eventsOf(pia, { type: "api.consumer_removed", actorUserId: bob })).map(({ type }) => type)).toEqual(["api.consumer_removed"]);
  });
});

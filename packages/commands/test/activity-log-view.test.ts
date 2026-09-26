import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_JSON } from "@tiehall/catalog";
import { ACTIVITY_LOG_PATH, createActivityLogRoute, pruneSecurityEventOrigins, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

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
    createActivityLogRoute({ execute: install.execute, session: async () => caller, logger: { error() {} } as never });

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

  it("refuses a browser without a session with 401 and shows nothing, and a bad filter with 400", async () => {
    const answer = await route(undefined)(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}`));
    expect(answer.status).toBe(401);
    expect(await answer.text()).not.toContain("request.opened");
    const bad = await route(pia)(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}?from=yesterday`));
    expect(bad.status).toBe(400);
  });
});

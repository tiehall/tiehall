import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTIVITY_LOG_PATH, createActivityLogRoute, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Exporting the activity log (activity-log: Exporting the activity log;
// activity-log: Which actions are security events; activity-log: IP addresses
// and user agents are kept apart for 90 days; agent-safety: Actions that need
// the confirmation step; design.md, Decisions this change rests on: D28 #4;
// design.md, Self-hosting decisions: S7 and S14). An admin exports the whole
// log as JSONL from the web UI, with the confirmation step: the review page of
// activity_log.export at /confirm/activity_log.export, whose form's POST
// answers with the file. Each line carries the event's number, time, class,
// type, the ids it concerns and who caused it, and no message or packet body,
// IP address or user agent. An export without a valid confirmation gets 403
// and exports nothing, and each export is recorded as a security event, in
// the export's own transaction, naming the admin.

const USER_AGENT = "Mozilla/5.0 (canary browser)";

let install: TestInstall;
let pia: WebSessionCaller;
let bob: string;
let lee: string;
let fe1: { id: string; key: string };

interface Line {
  number: number;
  occurredAt: string;
  class: string;
  type: string;
  data: Record<string, unknown>;
  actor: Record<string, unknown>;
}

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  pia = sessionOf(await addUser(install.owner, { role: "admin", login: "pia" }));
  bob = await addUser(install.owner, { login: "bob" });
  lee = await addUser(install.owner, { login: "lee" });
  const dana = await addUser(install.owner, { login: "dana" });
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, dana, be);
  fe1 = await openRequest(install, tokenOf(dana), { targetTeam: "FE", title: "Dark mode" });
  expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${fe1.key}/claim`)).status).toBe(200);
  expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${fe1.key}/messages`, { kind: "question", body: "Which endpoint?" })).status).toBe(200);
  const origin = { "x-forwarded-for": "203.0.113.7", "user-agent": USER_AGENT };
  expect((await install.confirm(pia, "members.change_role", { userId: lee, role: "admin" }, origin)).status).toBe(200);
});

afterAll(async () => {
  await install.close();
});

/** The export events so far, oldest first. */
async function exportEvents(): Promise<{ number: number; actor_kind: string; actor_user_id: string; surface: string; data: unknown }[]> {
  const { rows } = await install.owner.query(
    "SELECT number::int AS number, actor_kind, actor_user_id, surface, data FROM events WHERE type = 'activity_log.exported' ORDER BY number",
  );
  return rows;
}

/** Exports the log as the caller, with the confirmation step; returns the answer and its lines. */
async function exportAs(caller: WebSessionCaller): Promise<{ answer: Response; text: string; lines: Line[] }> {
  const answer = await install.confirm(caller, "activity_log.export", {});
  const text = await answer.text();
  const lines = answer.status === 200 ? text.trimEnd().split("\n").map((line) => JSON.parse(line) as Line) : [];
  return { answer, text, lines };
}

describe("an export with the confirmation step", () => {
  it("gives Pia a JSONL file with one event per line, including the role change and the claim, and the activity log then holds a security event for the export that names Pia", async () => {
    const { answer, text, lines } = await exportAs(pia);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toMatch(/^application\/jsonl/);
    expect(answer.headers.get("content-disposition")).toMatch(/^attachment; filename="tiehall-activity-log-[0-9T:.Z-]+\.jsonl"$/);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(text.endsWith("\n")).toBe(true);
    expect(lines.map(({ number }) => number)).toEqual(lines.map((_, index) => index + 1));
    expect(lines.map(({ type }) => type)).toEqual(["request.opened", "request.claimed", "request.message_posted", "member.role_changed"]);
    expect(lines.find(({ type }) => type === "member.role_changed")).toMatchObject({
      class: "security",
      data: { userId: lee, role: "admin", previousRole: "member" },
      actor: { kind: "web_session", userId: pia.userId, surface: "web" },
    });
    expect(lines.find(({ type }) => type === "request.claimed")).toMatchObject({
      class: "domain",
      data: { requestId: fe1.id, userId: bob },
      actor: { kind: "agent", userId: bob, surface: "api" },
    });
    // The export's own event comes right after the last exported one, and names Pia.
    expect(await exportEvents()).toEqual([
      { number: lines.length + 1, actor_kind: "web_session", actor_user_id: pia.userId, surface: "web", data: { lastNumber: lines.length } },
    ]);
  });

  it("carries on each line the number, time, class, type, the ids it concerns and who caused it, and no body, IP address or user agent", async () => {
    const { text, lines } = await exportAs(pia);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(["actor", "class", "data", "number", "occurredAt", "type"]);
      expect(line.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Object.keys(line.actor)).toContain("kind");
    }
    const question = lines.find(({ type }) => type === "request.message_posted");
    expect(question?.data).toMatchObject({ requestId: fe1.id, messageId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(text).not.toContain("Which endpoint?");
    expect(text).not.toContain("203.0.113.7");
    expect(text).not.toContain(USER_AGENT);
    expect(text).not.toContain("login");
    // The earlier export is in the log now, as a security event.
    expect(lines.filter(({ type }) => type === "activity_log.exported")).toHaveLength(1);
  });

  it("shows on its review page, in Tiehall's words, what the export gives and that it is recorded", async () => {
    const page = await install.confirmRoute(pia)(new Request(`${URL_OF_INSTALL}/confirm/activity_log.export?input=%7B%7D`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Export the activity log");
    expect(html).toContain("JSONL");
    expect(html).toContain("security event");
    expect(html).not.toContain("Which endpoint?");
  });

  it("is linked from the admin view's page", async () => {
    const route = createActivityLogRoute({ execute: install.execute, session: async () => pia, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: { error() {} } as never });
    const html = await (await route(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}`))).text();
    expect(html).toContain('href="/confirm/activity_log.export?input=%7B%7D"');
  });
});

describe("an export without a confirmation", () => {
  it("gets 403 with an RFC 9457 problem when the web UI's form sends only the session and the CSRF token, and exports nothing", async () => {
    const before = (await exportEvents()).length;
    const result = await install.web(pia).write("activity_log.export", {}, install.fromThePage(pia));
    expect(result).toEqual({ ok: false, problem: expect.objectContaining({ status: 403, type: "https://tiehall.com/problems/confirmation-required" }) });
    expect(JSON.stringify(result)).not.toContain("request.opened");
    expect((await exportEvents()).length).toBe(before);
  });

  it("is offered on no agent surface: a token gets 404, an admin's included", async () => {
    await expect(install.execute("activity_log.export", tokenOf(pia.userId), {})).rejects.toMatchObject({ reason: "route-not-found", status: 404 });
  });
});

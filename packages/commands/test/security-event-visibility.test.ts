import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@tiehall/core";
import { ACTIVITY_LOG_PATH, createActivityLogRoute, reconcileTrustState, type Caller, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Security events are shown to admins only (activity-log: Security events are
// shown to admins only; activity-log: The admin view; activity-log: Exporting
// the activity log; requests: Readers get only domain events they may see;
// design.md, Decisions this change rests on: D28 #4; design.md, Self-hosting
// decisions: S14). Security events appear only in the admin view and the
// export, which only admins can open: a member who asks for either gets 403
// with an RFC 9457 problem, and nothing is shown or exported. They reach no
// pull reader, no wait answer and no web inbox, which serve only the requests'
// domain events, not even for an admin.

let install: TestInstall;
let pia: WebSessionCaller;
let bob: string;
let lee: string;
let dana: string;
/** The types of the security events Tiehall defines. */
const SECURITY_TYPES = EVENT_TYPES.filter(({ class: cls }) => cls === "security").map(({ type }) => type);

beforeAll(async () => {
  // A wait with nothing in its reader's scope holds a second here, instead of 60.
  install = await startTestInstall({ wait: { holdMs: 1_000 } });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  pia = sessionOf(await addUser(install.owner, { role: "admin", login: "pia" }));
  bob = await addUser(install.owner, { login: "bob" });
  lee = await addUser(install.owner, { login: "lee" });
  dana = await addUser(install.owner, { login: "dana" });
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, dana, be);
  // A domain event, then security events: a role change Pia confirms, and the nightly comparison's reconciled events.
  await openRequest(install, tokenOf(dana), { targetTeam: "FE", title: "Dark mode" });
  expect((await install.confirm(pia, "members.change_role", { userId: lee, role: "admin" })).status).toBe(200);
  await reconcileTrustState.handle(
    { id: "reconcile", queue: reconcileTrustState.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date() },
  );
  const { rows } = await install.owner.query<{ type: string }>("SELECT DISTINCT type FROM events WHERE class = 'security' ORDER BY type");
  expect(rows.map(({ type }) => type)).toEqual(["activity_log.reconciled", "member.role_changed"]);
});

afterAll(async () => {
  await install.close();
});

const FORBIDDEN = "https://tiehall.com/problems/forbidden";

const adminPage = (caller: WebSessionCaller) =>
  createActivityLogRoute({ execute: install.execute, session: async () => caller, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: { error() {} } as never });

describe("the admin view", () => {
  it("refuses a member with 403 and an RFC 9457 problem, and shows nothing", async () => {
    const result = await install.web(sessionOf(bob)).read("activity_log.list", {});
    expect(result).toEqual({ ok: false, problem: expect.objectContaining({ status: 403, type: FORBIDDEN }) });
    expect(JSON.stringify(result)).not.toMatch(/member\.role_changed|activity_log\.reconciled|request\.opened/);
    const page = await adminPage(sessionOf(bob))(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}`));
    expect(page.status).toBe(403);
    const body = await page.text();
    expect(JSON.parse(body)).toMatchObject({ status: 403, type: FORBIDDEN });
    expect(body).not.toMatch(/member\.role_changed|activity_log\.reconciled|request\.opened/);
  });

  it("shows an admin the security events, the role change and the reconciled events among them", async () => {
    const result = await install.web(pia).read<{ events: { class: string; type: string }[] }>("activity_log.list", {});
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const security = result.output.events.filter(({ class: cls }) => cls === "security").map(({ type }) => type);
    expect(new Set(security)).toEqual(new Set(["member.role_changed", "activity_log.reconciled"]));
  });
});

describe("the export", () => {
  it("refuses a member with 403 and an RFC 9457 problem, and exports nothing", async () => {
    const answer = await install.confirm(sessionOf(bob), "activity_log.export", {});
    expect(answer.status).toBe(403);
    const body = await answer.text();
    expect(JSON.parse(body)).toMatchObject({ status: 403, type: FORBIDDEN });
    expect(body).not.toMatch(/member\.role_changed|activity_log\.reconciled|request\.opened/);
    const { rows } = await install.owner.query("SELECT 1 FROM events WHERE type = 'activity_log.exported'");
    expect(rows).toEqual([]);
  });
});

describe("security events", () => {
  async function typesReadBy(caller: Caller): Promise<string[]> {
    const answer = await callApi(install, caller, "GET", "/api/v1/events", undefined);
    expect(answer.status).toBe(200);
    return answer.body.events.map(({ type }: { type: string }) => type);
  }

  it.each([
    ["Pia's agent on REST, an admin's", () => tokenOf(pia.userId)],
    ["Pia's CLI, an admin's", () => oauthTokenOf(pia.userId, "tiehall-cli", "cli")],
    ["Bob's agent", () => tokenOf(bob)],
  ])("reach no pull reader: %s reads the requests' domain events only", async (_name, caller) => {
    const types = await typesReadBy(caller());
    expect(types).toEqual(["request.opened"]);
    for (const type of types) expect(SECURITY_TYPES).not.toContain(type);
  });

  it("reach no reader in the web UI either, an admin's included", async () => {
    const result = await install.web(pia).read<{ events: { type: string }[] }>("events.read", {});
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.output.events.map(({ type }) => type)).toEqual(["request.opened"]);
  });

  it("reach no one through the web inbox's standing list, which holds proposals and receipts", async () => {
    const result = await install.web(pia).read("inbox.standing_list", {});
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toMatch(/member\.role_changed|activity_log\.reconciled|"security"/);
  });

  // The long-poll wait endpoint (task 19.5) and the web inbox's update feed (task 19.6) serve the same domain
  // events as the pull readers; each case became a plain test when its task landed.
  it.each([
    ["Pia's CLI, an admin's, which holds until the wait ends", () => oauthTokenOf(pia.userId, "tiehall-cli", "cli"), []],
    ["Bob's CLI, which the new request to Bob's team wakes at once", () => oauthTokenOf(bob, "tiehall-cli", "cli"), ["request.opened"]],
  ])("reach no wait answer of GET /api/v1/events/wait: %s", async (_name, caller, expected) => {
    const response = await install.api(caller())(new Request(`${URL_OF_INSTALL}/api/v1/events/wait?cursor=0`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: { type: string }[] };
    expect(body.events.map(({ type }) => type)).toEqual(expected);
    expect(JSON.stringify(body)).not.toMatch(/member\.role_changed|activity_log\.reconciled|"security"/);
  });

  it.each([
    ["Pia's, an admin's", () => pia, []],
    ["Bob's, which lists the new request to Bob's team", () => sessionOf(bob), ["request.opened"]],
  ])("reach no web inbox update feed: %s", async (_name, session, expected) => {
    const result = await install.web(session()).read<{ events: { type: string }[] }>("inbox.updates", {});
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.output.events.map(({ type }) => type)).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/member\.role_changed|activity_log\.reconciled|"security"/);
  });
});

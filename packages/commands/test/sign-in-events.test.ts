import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// The security events of the writes the sign-in service owns (activity-log:
// Writes the sign-in service owns are still recorded; activity-log: Which
// actions are security events; design.md, Technical decisions: T7 and T8;
// design.md, Self-hosting decisions: S14). The sign-in service stores a web
// session itself, so an after-hook appends the sign-in's security event right
// after that write, naming the user. A refused sign-in stores nothing of the
// service's, and Tiehall records it itself: a record of the refused GitHub
// account, which the event names, since an event names only Tiehall's own
// records. Each keeps the client's IP address, the address the trusted
// proxies yield, and its user agent apart from the event, in the side table
// that keeps them for 90 days.

const BROWSER = { "x-forwarded-for": "203.0.113.7", "user-agent": "Mozilla/5.0 (tiehall test browser)" };

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ana: StubUser;
let anaUserId: string;
let pia: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  ana = stub.addUser({ login: "ana-k", email: "ana@acme.example" });
  anaUserId = await addUser(install.owner, { login: "ana-k", githubAccountId: ana.id });
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
  harness = await startSignIn(install, stub);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

interface EventRow {
  number: string;
  class: string;
  type: string;
  data: Record<string, unknown>;
  actor_kind: string;
  actor_user_id: string | null;
  surface: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

async function eventsAfter(number: number, type: string): Promise<EventRow[]> {
  const { rows } = await install.owner.query<EventRow>(
    `SELECT e.number, e.class, e.type, e.data, e.actor_kind, e.actor_user_id, e.surface, host(o.ip_address) AS ip_address, o.user_agent
       FROM events e LEFT JOIN security_event_origins o ON o.org_id = e.org_id AND o.event_number = e.number
      WHERE e.number > $1 AND e.type = $2 ORDER BY e.number`,
    [number, type],
  );
  return rows;
}

async function lastEvent(): Promise<number> {
  return Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
}

describe("a sign-in", () => {
  it("appends a security event naming the user, right after the session is stored, with the client's address and user agent kept apart", async () => {
    const from = await lastEvent();
    const { response, jar } = await harness.signIn("ana-k", { headers: BROWSER });
    expect(response.status).toBe(302);
    const session = await harness.sessionOf(jar);
    const events = await eventsAfter(from, "sign_in.completed");
    expect(events).toEqual([
      {
        number: expect.any(String),
        class: "security",
        type: "sign_in.completed",
        data: { userId: anaUserId },
        actor_kind: "web_session",
        actor_user_id: anaUserId,
        surface: "web",
        ip_address: "203.0.113.7",
        user_agent: BROWSER["user-agent"],
      },
    ]);
    // The session itself carries the same client address.
    const { rows } = await install.owner.query("SELECT ip_address, user_agent FROM web_sessions WHERE id = $1", [session?.sessionId]);
    expect(rows).toEqual([{ ip_address: "203.0.113.7", user_agent: BROWSER["user-agent"] }]);
  });

  it("is shown to admins in the activity log, with its address and user agent", async () => {
    const result = await install.web(sessionOf(pia)).read<{ events: { type: string; data: unknown; origin?: unknown }[] }>("activity_log.list", {
      type: "sign_in.completed",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.problem));
    expect(result.output.events[0]).toMatchObject({
      type: "sign_in.completed",
      data: { userId: anaUserId },
      origin: { ipAddress: "203.0.113.7", userAgent: BROWSER["user-agent"] },
    });
  });
});

describe("a refused sign-in", () => {
  it("appends a security event naming the GitHub account that was refused, and creates no session or user", async () => {
    const kim = stub.addUser({ login: "kim-outside", email: "kim@acme.example" });
    const from = await lastEvent();
    const { response } = await harness.signIn("kim-outside", { headers: BROWSER });
    expect(response.status).toBe(403);
    const events = await eventsAfter(from, "sign_in.refused");
    expect(events).toHaveLength(1);
    const [event] = events as [EventRow];
    expect(event).toMatchObject({ class: "security", actor_kind: "system", actor_user_id: null, ip_address: "203.0.113.7", user_agent: BROWSER["user-agent"] });
    expect(Object.keys(event.data)).toEqual(["refusalId"]);
    const { rows } = await install.owner.query("SELECT github_account_id, github_login FROM sign_in_refusals WHERE id = $1", [event.data["refusalId"]]);
    expect(rows).toEqual([{ github_account_id: String(kim.id), github_login: "kim-outside" }]);
    expect((await install.owner.query("SELECT count(*) FROM users WHERE github_login = 'kim-outside'")).rows[0].count).toBe("0");
    expect((await eventsAfter(from, "sign_in.completed")).length).toBe(0);
  });

  it("of a user who is no longer a member names the user too", async () => {
    const lee = stub.addUser({ login: "lee-gone" });
    const leeUserId = await addUser(install.owner, { login: "lee-gone", role: null, githubAccountId: lee.id });
    const from = await lastEvent();
    expect((await harness.signIn("lee-gone", { headers: BROWSER })).response.status).toBe(403);
    const [event] = (await eventsAfter(from, "sign_in.refused")) as [EventRow];
    expect(event.data).toEqual({ refusalId: expect.any(String), userId: leeUserId });
    const { rows } = await install.owner.query("SELECT github_account_id, github_login FROM sign_in_refusals WHERE id = $1", [event.data["refusalId"]]);
    expect(rows).toEqual([{ github_account_id: String(lee.id), github_login: "lee-gone" }]);
  });
});

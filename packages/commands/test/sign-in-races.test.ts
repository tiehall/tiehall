import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { createHomeRoute, SIGN_IN_REFUSED, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { invite } from "./support/invites.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type CookieJar, type SignInAttempt, type SignInHarness } from "./support/sign-in.ts";
import { shellReader } from "./support/shell.ts";

// Sign-ins that race an admin's change (sign-in: Who may sign in; sign-in:
// Signing out and ending sessions; teams-and-roles: Removing a member;
// activity-log: Which actions are security events). Who may sign in is
// decided before the sign-in service writes anything, and GitHub is asked
// outside any transaction, so an admin's change can commit while GitHub
// answers: here the admin sets the sign-in policy to "invited people only",
// or removes the person, while GitHub answers the sign-in's lookup of the
// person's organization membership. The join, just before the web session is
// stored, checks the admission again, and a member's sign-in checks that they
// are still a member; once the session is stored, the sign-in checks the
// membership once more, waiting for a removal that is committing, so a
// removal either ends the new session or refuses the sign-in. A sign-in that
// no longer holds is refused like any other: 403 with the text that says to
// ask an admin for an invite, no session, no membership, no Tiehall user it
// created, and a security event for the refused sign-in. And a web session
// whose user is not a member serves nothing, nor again after they rejoin.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ada: WebSessionCaller;
let pia: WebSessionCaller;
const accounts = new Map<string, StubUser>();

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["omar-acme", "lee-acme", "lou-acme", "rae-acme", "sam-acme", "kim-acme", "ivy-acme"]) accounts.set(login, stub.addUser({ login }));
  stub.addOrg({
    login: "acme",
    members: { "omar-acme": "admin", "lee-acme": "member", "lou-acme": "member", "rae-acme": "member", "sam-acme": "member", "kim-acme": "member", "ivy-acme": "member" },
  });
  harness = await startSignIn(install, stub);
  await stub.install(harness.app, { account: "acme" });
  await harness.connect("acme");
  install.useGitHub(harness.github);
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  pia = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "pia" }), sessionId: randomUUID() };
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(async () => {
  await install.owner.query("UPDATE install_settings SET sign_in_policy = 'organization_members_and_invited'");
});

async function lastEvent(): Promise<number> {
  return Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
}

async function eventsSince(number: number): Promise<{ type: string; data: Record<string, unknown> }[]> {
  return (await install.owner.query("SELECT type, data FROM events WHERE number > $1 ORDER BY number", [number])).rows;
}

async function recordsOf(login: string): Promise<{ users: number; accounts: number; members: number; sessions: number }> {
  const { rows } = await install.owner.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM users WHERE github_login = $1) AS users,
            (SELECT count(*) FROM sign_in_accounts a JOIN users u ON u.org_id = a.org_id AND u.id = a.user_id WHERE u.github_login = $1) AS accounts,
            (SELECT count(*) FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id WHERE u.github_login = $1) AS members,
            (SELECT count(*) FROM web_sessions s JOIN users u ON u.org_id = s.org_id AND u.id = s.user_id WHERE u.github_login = $1) AS sessions`,
    [login],
  );
  const row = rows[0]!;
  return { users: Number(row["users"]), accounts: Number(row["accounts"]), members: Number(row["members"]), sessions: Number(row["sessions"]) };
}

/** A sign-in as this login, during whose lookup of the login's membership of acme an admin sets the policy to invited people only. */
async function signInWhileThePolicyChanges(login: string): Promise<SignInAttempt> {
  let changed = false;
  const racing = await startSignIn(install, stub, {
    sameAppAs: harness,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!changed && url.pathname === `/orgs/acme/members/${login}`) {
        changed = true;
        expect((await install.confirm(ada, "settings.set_sign_in_policy", { policy: "invited_only" })).status).toBe(200);
      }
      return fetch(input, init);
    },
  });
  const attempt = await racing.signIn(login);
  expect(changed).toBe(true);
  return attempt;
}

describe("a sign-in whose admission is withdrawn before its session is stored", () => {
  it("of a new person is refused with 403, leaves no Tiehall user, and is recorded as a refused sign-in naming the GitHub account", async () => {
    const from = await lastEvent();
    const { response, jar } = await signInWhileThePolicyChanges("lee-acme");

    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail: string }).detail).toBe(SIGN_IN_REFUSED);
    expect(await harness.sessionOf(jar)).toBeUndefined();
    expect(await recordsOf("lee-acme")).toEqual({ users: 0, accounts: 0, members: 0, sessions: 0 });
    const events = await eventsSince(from);
    expect(events.map(({ type }) => type)).toEqual(["settings.sign_in_policy_changed", "sign_in.refused"]);
    const refused = events[1]!.data;
    expect(Object.keys(refused)).toEqual(["refusalId"]);
    const { rows } = await install.owner.query("SELECT github_account_id, github_login FROM sign_in_refusals WHERE id = $1", [refused["refusalId"]]);
    expect(rows).toEqual([{ github_account_id: String(accounts.get("lee-acme")!.id), github_login: "lee-acme" }]);
  });

  it("of a person whose user exists keeps that user, and the refused sign-in names it", async () => {
    // Lou was a member once and left; their user stays, as a removal leaves it.
    const lou = await addUser(install.owner, { login: "lou-acme", githubAccountId: accounts.get("lou-acme")!.id, role: null });
    const from = await lastEvent();
    const { response } = await signInWhileThePolicyChanges("lou-acme");

    expect(response.status).toBe(403);
    expect(await recordsOf("lou-acme")).toEqual({ users: 1, accounts: 1, members: 0, sessions: 0 });
    const events = await eventsSince(from);
    expect(events.map(({ type }) => type)).toEqual(["settings.sign_in_policy_changed", "sign_in.refused"]);
    expect(events[1]!.data).toMatchObject({ userId: lou });
  });
});

async function liveSessionsOf(userId: string): Promise<number> {
  return Number((await install.owner.query("SELECT count(*) AS n FROM web_sessions WHERE user_id = $1 AND ended_at IS NULL", [userId])).rows[0].n);
}

function home(jar: CookieJar): Promise<Response> {
  const route = createHomeRoute({ session: (request) => harness.service.session(request.headers), secret: () => install.authSecret, logger: install.logger, shell: shellReader(install.execute) });
  return route(new Request(`${URL_OF_INSTALL}/`, { headers: { cookie: jar.header() } }));
}

/** What a browser's session gets: the user it signs in, "none" when it holds none, or "refused" with 403. */
async function sessionState(jar: CookieJar): Promise<string> {
  try {
    return (await harness.sessionOf(jar))?.userId ?? "none";
  } catch (error) {
    return (error as { status?: number }).status === 403 ? "refused" : String(error);
  }
}

describe("a member's sign-in that an admin removal races", () => {
  it("committing while GitHub answers is refused with 403, stores no session, and none works after the person rejoins", async () => {
    // Rae joins through membership of acme.
    const joined = await harness.signIn("rae-acme");
    expect(joined.response.status).toBe(302);
    const rae = (await harness.sessionOf(joined.jar))!.userId;

    // Rae signs in again in a second browser; while GitHub answers the membership lookup, Pia removes Rae with the confirmation step.
    let removed = false;
    const racing = await startSignIn(install, stub, {
      sameAppAs: harness,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!removed && url.pathname === "/orgs/acme/members/rae-acme") {
          removed = true;
          expect((await install.confirm(pia, "members.remove", { userId: rae })).status).toBe(200);
        }
        return fetch(input, init);
      },
    });
    const from = await lastEvent();
    const raced = await racing.signIn("rae-acme");
    expect(removed).toBe(true);

    expect(raced.response.status).toBe(403);
    expect(((await raced.response.json()) as { detail: string }).detail).toBe(SIGN_IN_REFUSED);
    expect(await liveSessionsOf(rae)).toBe(0);
    expect((await home(raced.jar)).status).toBe(303);
    expect(await sessionState(raced.jar)).toBe("none");
    expect(await sessionState(joined.jar)).toBe("refused");
    const events = await eventsSince(from);
    expect(events.map(({ type }) => type)).toEqual(["member.removed", "sign_in.refused"]);
    expect(events[1]!.data).toMatchObject({ userId: rae });

    // Pia invites Rae again, and Rae rejoins through it: only the new sign-in's session works.
    expect((await invite(install, pia, "rae-acme")).status).toBe(200);
    const rejoined = await harness.signIn("rae-acme");
    expect(rejoined.response.status).toBe(302);
    expect(await sessionState(rejoined.jar)).toBe(rae);
    expect(await sessionState(raced.jar)).toBe("none");
    expect(await sessionState(joined.jar)).toBe("refused");
    expect(await liveSessionsOf(rae)).toBe(1);
  });

  it("committing between the admission and the session hook stores no session at all: the check before the session is written refuses it", async () => {
    // Ivy is a member. Pia's removal commits while GitHub answers the sign-in's lookup, after the admission was
    // decided and before the sign-in service writes the session. The check made just before the session is stored
    // refuses the sign-in there, so no web_sessions row is ever inserted; the check once it is stored would only
    // end a session already written. A trigger counts every row inserted for Ivy on a sequence, which no rollback
    // takes back, as the database owner, since the app role may not use it.
    const joined = await harness.signIn("ivy-acme");
    expect(joined.response.status).toBe(302);
    const ivy = (await harness.sessionOf(joined.jar))!.userId;
    await install.owner.query("CREATE SEQUENCE ivy_session_inserts");
    await install.owner.query(
      `CREATE FUNCTION count_ivy_session() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
         BEGIN PERFORM nextval('ivy_session_inserts'); RETURN NEW; END $$`,
    );
    await install.owner.query(
      `CREATE TRIGGER count_ivy_session BEFORE INSERT ON web_sessions FOR EACH ROW WHEN (NEW.user_id = '${ivy}') EXECUTE FUNCTION count_ivy_session()`,
    );
    try {
      let removed = false;
      const racing = await startSignIn(install, stub, {
        sameAppAs: harness,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (!removed && url.pathname === "/orgs/acme/members/ivy-acme") {
            removed = true;
            expect((await install.confirm(pia, "members.remove", { userId: ivy })).status).toBe(200);
          }
          return fetch(input, init);
        },
      });
      const raced = await racing.signIn("ivy-acme");
      expect(removed).toBe(true);

      expect(raced.response.status).toBe(403);
      expect(((await raced.response.json()) as { detail: string }).detail).toBe(SIGN_IN_REFUSED);
      const { rows } = await install.owner.query("SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS inserted FROM ivy_session_inserts");
      expect(rows).toEqual([{ inserted: 0 }]);
      expect(await liveSessionsOf(ivy)).toBe(0);
    } finally {
      await install.owner.query("DROP TRIGGER count_ivy_session ON web_sessions; DROP FUNCTION count_ivy_session(); DROP SEQUENCE ivy_session_inserts");
    }
  });

  it("committing while the session is stored ends that session, and the sign-in is refused with 403", async () => {
    // Sam is a member. A removal that commits between the sign-in's last check and its stored session, whose
    // own end of Sam's sessions came too early to see it, is played by a trigger that ends Sam's membership
    // as the session row is written.
    const sam = await addUser(install.owner, { login: "sam-acme", githubAccountId: accounts.get("sam-acme")!.id });
    await install.owner.query(
      `CREATE FUNCTION remove_while_stored() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN DELETE FROM members WHERE org_id = NEW.org_id AND user_id = NEW.user_id; RETURN NEW; END $$`,
    );
    await install.owner.query(
      `CREATE TRIGGER remove_while_stored BEFORE INSERT ON web_sessions FOR EACH ROW WHEN (NEW.user_id = '${sam}') EXECUTE FUNCTION remove_while_stored()`,
    );
    try {
      const from = await lastEvent();
      const raced = await harness.signIn("sam-acme");

      expect(raced.response.status).toBe(403);
      expect(((await raced.response.json()) as { detail: string }).detail).toBe(SIGN_IN_REFUSED);
      expect(Number((await install.owner.query("SELECT count(*) AS n FROM web_sessions WHERE user_id = $1", [sam])).rows[0].n)).toBe(0);
      expect(await sessionState(raced.jar)).toBe("none");
      const events = await eventsSince(from);
      expect(events.map(({ type }) => type)).toEqual(["sign_in.refused"]);
      expect(events[0]!.data).toMatchObject({ userId: sam });
    } finally {
      await install.owner.query("DROP TRIGGER remove_while_stored ON web_sessions; DROP FUNCTION remove_while_stored()");
    }
  });
});

describe("a web session whose user is not a member, which no removal ended", () => {
  it("serves nothing, the home page included, and still nothing after the person rejoins", async () => {
    const first = await harness.signIn("kim-acme");
    expect(first.response.status).toBe(302);
    const kim = (await harness.sessionOf(first.jar))!.userId;
    // Kim's membership goes without the end of Kim's sessions that a removal makes.
    await install.owner.query("DELETE FROM members WHERE user_id = $1", [kim]);

    expect(await sessionState(first.jar)).toBe("refused");
    const page = await home(first.jar);
    expect(page.status).toBe(403);
    expect(await page.json()).toMatchObject({ type: "https://tiehall.com/problems/removed-member" });

    // Kim joins again through membership of acme: the session from before stays refused.
    const again = await harness.signIn("kim-acme");
    expect(again.response.status).toBe(302);
    expect(await sessionState(again.jar)).toBe(kim);
    expect(await sessionState(first.jar)).toBe("refused");
    expect((await home(first.jar)).status).toBe(403);
    expect(await liveSessionsOf(kim)).toBe(1);
  });
});

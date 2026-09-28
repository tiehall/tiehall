import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { csrfTokenFor, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, tokenOf } from "./support/requests.ts";
import { CookieJar, startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Signing out (sign-in: Signing out and ending sessions; agent-safety: One
// confirmation approves one action). A signed-in user signs out with the web
// UI's sign-out form, which passes the checks every web UI write passes: the
// session's CSRF token, an Origin equal to TIEHALL_URL and Sec-Fetch-Site:
// same-origin. It ends that web session at once, and only that one: the
// user's other browsers stay signed in, and their agents' grants and tokens
// keep working, since signing out revokes none of them. Ending a removed
// member's sessions is the removal's (member-removal.test.ts).

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ana: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const account = stub.addUser({ login: "ana-k", email: "ana@acme.example" });
  ana = await addUser(install.owner, { login: "ana-k", githubAccountId: account.id });
  await joinTeams(install.owner, ana, await addTeam(install.owner, "BE"));
  await addTeam(install.owner, "FE");
  harness = await startSignIn(install, stub);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

/** Posts the sign-out form of a page of the install, from the browser with these cookies. */
function signOut(jar: CookieJar, session: WebSessionCaller | undefined, headers: Record<string, string> = {}): Promise<Response> {
  const csrf = session === undefined ? "" : csrfTokenFor(install.authSecret, session.sessionId);
  return harness.service.signOut(
    new Request(`${URL_OF_INSTALL}/sign-out`, {
      method: "POST",
      headers: {
        cookie: jar.header(),
        origin: URL_OF_INSTALL,
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({ csrf }).toString(),
    }),
  );
}

async function sessionRows(sessionId: string): Promise<number> {
  return Number((await install.owner.query("SELECT count(*) FROM web_sessions WHERE id = $1", [sessionId])).rows[0].count);
}

describe("signing out", () => {
  it("ends that web session at once: the browser is no longer signed in, and its old cookie names no session", async () => {
    const { jar } = await harness.signIn("ana-k");
    const session = await harness.sessionOf(jar);
    expect(session?.userId).toBe(ana);
    const before = jar.copy();

    const answer = await signOut(jar, session);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/sign-in");
    jar.take(answer);
    expect(await harness.sessionOf(jar)).toBeUndefined();
    // Even a copy of the cookie from before names no session: the session itself is gone.
    expect(await sessionRows(session!.sessionId)).toBe(0);
    expect(await harness.sessionOf(before)).toBeUndefined();
  });

  it("ends only that session: the user's other browser stays signed in", async () => {
    const laptop = await harness.signIn("ana-k");
    const phone = await harness.signIn("ana-k");
    const laptopSession = await harness.sessionOf(laptop.jar);
    expect((await signOut(laptop.jar, laptopSession)).status).toBe(303);
    expect(await harness.sessionOf(phone.jar)).toMatchObject({ userId: ana });
  });

  it("leaves the user's agents working, whose grants and tokens it does not revoke", async () => {
    const { jar } = await harness.signIn("ana-k");
    expect((await signOut(jar, await harness.sessionOf(jar))).status).toBe(303);
    const opened = await openRequest(install, tokenOf(ana), { targetTeam: "FE" });
    expect((await callApi(install, tokenOf(ana, "cli"), "GET", `/api/v1/requests/${opened.key}`)).status).toBe(200);
    expect((await callApi(install, oauthTokenOf(ana, "tiehall-cli", "cli"), "GET", `/api/v1/requests/${opened.key}`)).status).toBe(200);
  });

  it("is refused with 403, and ends nothing, without the session's CSRF token or from another origin", async () => {
    const { jar } = await harness.signIn("ana-k");
    const session = await harness.sessionOf(jar);
    for (const answer of [
      await signOut(jar, undefined),
      await signOut(jar, session, { origin: "https://evil.example" }),
      await signOut(jar, session, { "sec-fetch-site": "cross-site" }),
    ]) {
      expect(answer.status).toBe(403);
      expect(answer.headers.getSetCookie()).toEqual([]);
    }
    expect(await harness.sessionOf(jar)).toMatchObject({ userId: ana });
  });

  it("from a browser that is not signed in just leads to the sign-in page", async () => {
    const answer = await signOut(new CookieJar(), undefined);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/sign-in");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { createHomeRoute, csrfTokenFor } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";
import { CookieJar, startSignIn, type SignInHarness } from "./support/sign-in.ts";

// The home page (sign-in: GitHub is the only way to sign in; sign-in: Signing
// out and ending sessions). A person who is not signed in is sent to the
// sign-in page, which offers sign-in with GitHub only; a signed-in member gets
// the web UI, with a link to the members page and the sign-out form, which
// carries the session's CSRF token;
// a browser whose session a removal ended gets 403 and no data.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ana: string;
let pia: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const account = stub.addUser({ login: "ana-k" });
  ana = await addUser(install.owner, { login: "ana-k", githubAccountId: account.id });
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
  harness = await startSignIn(install, stub);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

function home(jar: CookieJar): Promise<Response> {
  const route = createHomeRoute({ session: (request) => harness.service.session(request.headers), secret: () => install.authSecret, logger: install.logger });
  return route(new Request(`${URL_OF_INSTALL}/`, { headers: { cookie: jar.header() } }));
}

describe("the home page", () => {
  it("sends a person who is not signed in to the sign-in page", async () => {
    const answer = await home(new CookieJar());
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/sign-in");
  });

  it("gives a signed-in member the web UI, with the sign-out form and the session's CSRF token", async () => {
    const { jar } = await harness.signIn("ana-k");
    const session = await harness.sessionOf(jar);
    const answer = await home(jar);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await answer.text();
    expect(html).toContain('<form method="post" action="/sign-out">');
    expect(html).toContain(`<input type="hidden" name="csrf" value="${csrfTokenFor(install.authSecret, session!.sessionId)}">`);
    expect(html).toContain(`<button type="submit">Sign out</button>`);
    // The members page, which every member may open, and from which an admin reaches the admin pages.
    expect(html).toContain('<a href="/members">Members</a>');
  });

  it("answers a browser whose session a removal ended with 403 and no data", async () => {
    const { jar } = await harness.signIn("ana-k");
    expect((await install.confirm(sessionOf(pia), "members.remove", { userId: ana })).status).toBe(200);
    const answer = await home(jar);
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/removed-member" });
  });
});

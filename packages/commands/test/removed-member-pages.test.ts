import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { createConsentRoute, createDeviceApprovalRoute, createGitHubAdminRoute, createHomeRoute, createMembersRoute } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";
import { CookieJar, startSignIn, type SignInHarness } from "./support/sign-in.ts";

// A removed member's browser, on the web UI's pages (public-api: One error
// model for Tiehall's own refusals; design.md, Design rules: Teams and
// roles). A removal ends the member's web sessions, so the browser is no
// longer signed in: its refusal page leads to the sign-in page, as for a
// browser that is not signed in, never back to the page that refused it,
// which would refuse it again.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let pia: string;
let people = 0;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
  harness = await startSignIn(install, stub);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

/** A member, of the role given, who signed in in a browser, and whom an admin then removed; the browser's cookies. */
async function removedMembersBrowser(role: "member" | "admin" = "member"): Promise<CookieJar> {
  people += 1;
  const login = `removed-${people}`;
  const account = stub.addUser({ login });
  const userId = await addUser(install.owner, { login, githubAccountId: account.id, role });
  const { jar } = await harness.signIn(login);
  expect((await install.confirm(sessionOf(pia), "members.remove", { userId })).status).toBe(200);
  return jar;
}

const session = (request: Request, renewal?: Headers) => harness.service.session(request.headers, renewal);
const pageOptions = () => ({ execute: install.execute, session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });

const PAGES: [string, () => (request: Request) => Promise<Response>, string][] = [
  ["the home page", () => createHomeRoute({ session, secret: () => install.authSecret, logger: install.logger }), "/"],
  ["the members page", () => createMembersRoute(pageOptions()), "/members"],
  ["the GitHub admin page", () => createGitHubAdminRoute(pageOptions()), "/admin/github"],
  ["a review page", () => install.confirmRouteFor(session), `/confirm/members.change_role?input=${encodeURIComponent(JSON.stringify({ userId: "5b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", role: "admin" }))}`],
  ["the device approval page", () => createDeviceApprovalRoute({ step: install.step, session, url: URL_OF_INSTALL, secret: install.authSecret, logger: install.logger }), "/device"],
  [
    "the consent screen",
    () => createConsentRoute({ step: install.step, session, secret: install.authSecret, logger: install.logger }),
    "/consent?response_type=code&client_id=a-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Fcallback&scope=requests%3Aread",
  ],
];

describe("a removed member's browser", () => {
  it.each(PAGES)("gets a refusal of %s that leads to the sign-in page, not back to the page", async (_page, route, target) => {
    const jar = await removedMembersBrowser("admin");
    const answer = await route()(new Request(`${URL_OF_INSTALL}${target}`, { headers: { cookie: jar.header(), accept: "text/html" } }));
    expect(answer.status).toBe(403);
    const html = await answer.text();
    expect(html).toContain("https://tiehall.com/problems/removed-member");
    expect(html).toContain('<a href="/sign-in">Go to the sign-in page</a>');
  });
});

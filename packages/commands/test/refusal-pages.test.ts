import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_JSON, CATALOG } from "@tiehall/catalog";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import {
  ACTIVITY_LOG_PATH,
  createActivityLogRoute,
  createConsentRoute,
  createGitHubAdminRoute,
  createHomeRoute,
  createInvitesRoute,
  createMembersRoute,
  createRestHandler,
  createSetupGate,
  createSetupRoute,
  createSignInPolicyRoute,
  createTeamsRoute,
  csrfTokenFor,
  GITHUB_ADMIN_PATH,
  INVITES_PATH,
  MEMBERS_PATH,
  SIGN_IN_POLICY_PATH,
  TEAMS_PATH,
  type WebSessionCaller,
} from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Refusals to browsers are pages (public-api: One error model for Tiehall's
// own refusals; sign-in: Who may sign in; github-layer-hardening: design.md,
// Decisions this change rests on: D50 (7); Technical decisions: T5). On the
// routes that serve the web UI's pages, the setup screen, the review pages and
// confirmations under /confirm/…, the consent screen and GitHub's return to
// either sign-in callback, a refusal to a request whose Accept header names text/html is an
// HTML page: the refusal's status, its title and detail escaped, its problem
// type in the markup, a link on, and the page headers (no script, nothing
// loaded, no framing). The same request asking for JSON gets the RFC 9457
// problem, as does every call to /api/v1 and /mcp, whatever it accepts. The
// setup gate's answers before setup completes are unchanged.

/** What a browser sends, which names text/html. */
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const JSON_CLIENT = "application/json";

let install: TestInstall;
let fresh: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ada: WebSessionCaller;
let dana: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addUser({ login: "kim-outside" });
  stub.addOrg({ login: "acme" });
  harness = await startSignIn(install, stub);
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  dana = { kind: "web_session", userId: await addUser(install.owner, { role: "member", login: "dana" }), sessionId: randomUUID() };
  // An install whose setup is not complete, for the setup screen's steps and the setup gate.
  fresh = await startTestInstall();
  await fresh.owner.query("UPDATE orgs SET name = NULL, setup_completed_at = NULL");
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
  await fresh?.close();
});

/** Text for HTML, escaped as the install's pages escape it. */
function escaped(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

type Route = (request: Request) => Promise<Response>;

const pageOptions = (session: WebSessionCaller | undefined) => ({
  execute: install.execute,
  session: async () => session,
  url: URL_OF_INSTALL,
  secret: () => install.authSecret,
  logger: install.logger,
});

/** A form of the install's page, posted from it with the session's CSRF token. */
function form(path: string, session: WebSessionCaller | undefined, fields: Record<string, string>): RequestInit & { path: string } {
  return {
    path,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ ...(session === undefined ? {} : { csrf: csrfTokenFor(install.authSecret, session.sessionId) }), ...fields }).toString(),
  };
}

interface Case {
  name: string;
  route: () => Route;
  /** The request, made when the test runs, once the install's people exist. */
  request: () => RequestInit & { path: string };
  status: number;
  /** Where the page's link leads on. */
  wayOn: () => string;
}

const reviewOfARole = `/confirm/members.change_role?input=${encodeURIComponent(JSON.stringify({ userId: "not-a-user", role: "admin" }))}`;
const confirmationWithoutNonce = {
  path: "/confirm/members.change_role",
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
  body: "",
};

const CASES: Case[] = [
  {
    name: "a form of the members page that names no action of the page",
    route: () => createMembersRoute(pageOptions(ada)),
    request: () => form(MEMBERS_PATH, ada, { action: "remove" }),
    status: 404,
    wayOn: () => MEMBERS_PATH,
  },
  { name: "the invites page, to a member", route: () => createInvitesRoute(pageOptions(dana)), request: () => ({ path: INVITES_PATH }), status: 403, wayOn: () => INVITES_PATH },
  { name: "the teams page, to a member", route: () => createTeamsRoute(pageOptions(dana)), request: () => ({ path: TEAMS_PATH }), status: 403, wayOn: () => TEAMS_PATH },
  {
    name: "the sign-in policy page, to a member",
    route: () => createSignInPolicyRoute(pageOptions(dana)),
    request: () => ({ path: SIGN_IN_POLICY_PATH }),
    status: 403,
    wayOn: () => SIGN_IN_POLICY_PATH,
  },
  { name: "the GitHub page, to a member", route: () => createGitHubAdminRoute(pageOptions(dana)), request: () => ({ path: GITHUB_ADMIN_PATH }), status: 403, wayOn: () => GITHUB_ADMIN_PATH },
  {
    name: "a form of the invites page from a browser that is not signed in",
    route: () => createInvitesRoute(pageOptions(undefined)),
    request: () => form(INVITES_PATH, undefined, { action: "revoke", invite: randomUUID() }),
    status: 401,
    wayOn: () => "/sign-in",
  },
  {
    name: "the activity log's admin view, with a filter its schema refuses",
    route: () => createActivityLogRoute(pageOptions(ada)),
    request: () => ({ path: `${ACTIVITY_LOG_PATH}?from=yesterday` }),
    status: 400,
    wayOn: () => ACTIVITY_LOG_PATH,
  },
  { name: "a review page whose input its schema refuses", route: () => install.confirmRoute(ada), request: () => ({ path: reviewOfARole }), status: 400, wayOn: () => reviewOfARole },
  {
    name: "a confirmation without its nonce",
    route: () => install.confirmRoute(ada),
    request: () => ({
      ...confirmationWithoutNonce,
      body: new URLSearchParams({ input: JSON.stringify({ userId: dana.userId, role: "admin" }), csrf: csrfTokenFor(install.authSecret, ada.sessionId) }).toString(),
    }),
    status: 403,
    wayOn: () => `/confirm/members.change_role?input=${encodeURIComponent(JSON.stringify({ userId: dana.userId, role: "admin" }))}`,
  },
  {
    name: "the consent screen for a request that names no client",
    route: () => createConsentRoute({ step: install.step, session: async () => dana, secret: install.authSecret, logger: install.logger }),
    request: () => ({ path: "/consent?response_type=code" }),
    status: 400,
    wayOn: () => "/consent?response_type=code",
  },
  {
    name: "the consent screen for a client the install does not know",
    route: () => createConsentRoute({ step: install.step, session: async () => dana, secret: install.authSecret, logger: install.logger }),
    request: () => ({ path: "/consent?response_type=code&client_id=no-such-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback" }),
    status: 404,
    wayOn: () => "/consent?response_type=code&client_id=no-such-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback",
  },
  {
    name: "a form posted to the home page",
    route: () => createHomeRoute({ session: async () => ada, secret: () => install.authSecret, logger: install.logger }),
    request: () => ({ path: "/", method: "POST" }),
    status: 404,
    wayOn: () => "/",
  },
  {
    name: "a sign-in started from another origin",
    route: () => (request) => harness.service.page(request),
    request: () => ({
      path: "/sign-in",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "return=%2F",
    }),
    status: 403,
    wayOn: () => "/sign-in",
  },
  {
    name: "a sign-out asked for with GET",
    route: () => (request) => harness.service.signOut(request),
    request: () => ({ path: "/sign-out" }),
    status: 404,
    wayOn: () => "/",
  },
  {
    name: "the setup screen once setup is complete",
    route: () => createSetupRoute({ database: install.db, url: URL_OF_INSTALL, secrets: () => install.box, logger: install.logger }),
    request: () => ({ path: "/setup" }),
    status: 404,
    wayOn: () => "/",
  },
  {
    name: "a setup code posted from another origin",
    route: () => createSetupRoute({ database: fresh.db, url: URL_OF_INSTALL, secrets: () => fresh.box, logger: fresh.logger }),
    request: () => ({ path: "/setup", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" }, body: "code=ABCD" }),
    status: 403,
    wayOn: () => "/setup",
  },
  {
    name: "GitHub's return to the setup screen's sign-in, in a browser without the setup session",
    route: () =>
      createSetupRoute({
        database: fresh.db,
        url: URL_OF_INSTALL,
        secrets: () => fresh.box,
        logger: fresh.logger,
        signIn: harness.service.setup,
      }),
    request: () => ({ path: "/setup/sign-in/callback/github?code=a-code&state=a-state" }),
    status: 403,
    wayOn: () => "/setup",
  },
];

/** The route's answer to the case's request, with this Accept header. */
function ask(testCase: Case, accept: string): Promise<Response> {
  const { path, headers, ...init } = testCase.request();
  return testCase.route()(new Request(`${URL_OF_INSTALL}${path}`, { ...init, headers: { ...(headers as Record<string, string>), accept } }));
}

/** Checks that an answer is a refusal page, as a browser gets one, for this problem and way on. */
async function expectRefusalPage(answer: Response, problem: { type: string; title: string; status: number; detail: string }, wayOn: string): Promise<void> {
  expect(answer.status).toBe(problem.status);
  expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
  const policy = answer.headers.get("content-security-policy") ?? "";
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");
  const html = await answer.text();
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).not.toMatch(/<script|<link|<img|<iframe|<style/i);
  expect(html).toContain(`<h1>${escaped(problem.title)}</h1>`);
  expect(html).toContain(escaped(problem.detail));
  expect(html).toContain(escaped(problem.type));
  expect(html).toContain(`href="${escaped(wayOn)}"`);
}

describe("a refusal on a page route", () => {
  it.each(CASES)("is a page for a browser, and the problem for a client that asks for JSON: $name", async (testCase) => {
    const asJson = await ask(testCase, JSON_CLIENT);
    expect(asJson.status).toBe(testCase.status);
    expect(asJson.headers.get("content-type")).toBe("application/problem+json");
    const problem = (await asJson.json()) as { type: string; title: string; status: number; detail: string };
    expect(problem).toMatchObject({ status: testCase.status, type: expect.stringMatching(/^https:\/\/tiehall\.com\/problems\//) });

    await expectRefusalPage(await ask(testCase, BROWSER), problem, testCase.wayOn());
  });

  it("is the problem for a request whose Accept header does not name text/html, such as none or */*", async () => {
    const [testCase] = CASES;
    for (const accept of ["", "*/*", "application/problem+json"]) {
      const answer = await ask(testCase!, accept);
      expect(answer.headers.get("content-type"), accept).toBe("application/problem+json");
    }
  });

  it("escapes the refusal's text on the page: an issue of the input's schema is text, not markup", async () => {
    const answer = await ask(CASES.find(({ name }) => name.startsWith("a review page"))!, BROWSER);
    const html = await answer.text();
    // The issues name where the input fails, as the problem's errors do, in text.
    expect(html).toContain("userId");
    expect(html).not.toContain("<script");
  });
});

// GitHub's return to the sign-in callback, /api/auth/callback/github, is a page route; every other route of the
// sign-in service is an API route, whose refusals stay problems.
describe("the sign-in callback", () => {
  it("refuses a person who may not sign in with a page for a browser, which links to the sign-in page, and with the problem otherwise", async () => {
    const asJson = await harness.signIn("kim-outside", { headers: { accept: JSON_CLIENT } });
    expect(asJson.response.status).toBe(403);
    expect(asJson.response.headers.get("content-type")).toBe("application/problem+json");
    const problem = (await asJson.response.json()) as { type: string; title: string; status: number; detail: string };
    expect(problem.type).toBe("https://tiehall.com/problems/sign-in-refused");

    const inBrowser = await harness.signIn("kim-outside", { headers: { accept: BROWSER } });
    await expectRefusalPage(inBrowser.response, problem, "/sign-in");
    expect(await harness.sessionOf(inBrowser.jar)).toBeUndefined();
  });

  it("answers another route of the sign-in service with the problem, even to a browser", async () => {
    const answer = await harness.service.handler(new Request(`${URL_OF_INSTALL}/api/auth/sign-in/email`, { method: "POST", headers: { accept: BROWSER } }));
    expect(answer.status).toBe(404);
    expect(answer.headers.get("content-type")).toBe("application/problem+json");
  });
});

describe("the API surfaces", () => {
  it("answer /api/v1 with the problem, whatever the call accepts", async () => {
    const rest = createRestHandler({ catalog: CATALOG, document: OPENAPI_JSON, execute: install.execute, authenticate: async () => undefined, logger: install.logger });
    for (const accept of [BROWSER, JSON_CLIENT]) {
      const answer = await rest(new Request(`${URL_OF_INSTALL}/api/v1/no-such-operation`, { headers: { accept } }));
      expect(answer.status, accept).toBe(404);
      expect(answer.headers.get("content-type"), accept).toBe("application/problem+json");
    }
  });

  // The setup gate's answers before setup completes are unchanged: an API call, /mcp included, gets 503
  // setup-required as a problem, whatever it accepts, and a page is sent on to /setup.
  it("keep the setup gate's answers before setup completes: the problem for /api/v1 and /mcp whatever they accept, and pages sent on to /setup", async () => {
    const gate = createSetupGate({ database: fresh.db, url: URL_OF_INSTALL, logger: fresh.logger });
    for (const path of ["/api/v1/requests", "/mcp"]) {
      const answer = await gate(new Request(`${URL_OF_INSTALL}${path}`, { method: "POST", headers: { accept: BROWSER } }));
      expect(answer?.status, path).toBe(503);
      expect(answer?.headers.get("content-type"), path).toBe("application/problem+json");
      expect(await answer?.json()).toMatchObject({ type: "https://tiehall.com/problems/setup-required" });
    }
    const page = await gate(new Request(`${URL_OF_INSTALL}${MEMBERS_PATH}`, { headers: { accept: BROWSER } }));
    expect(page?.status).toBe(307);
    expect(page?.headers.get("location")).toBe(`${URL_OF_INSTALL}/setup`);
  });

  it.todo("answer /mcp with the problem, whatever the call accepts, once the main change's group 16 builds it");
});

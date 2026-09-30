import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// Negotiated request URLs (agent-surfaces: Negotiated request URLs;
// agent-surfaces: No secret links; agent-surfaces: A browser without a session
// is sent to sign-in; agent-surfaces: A 401 that tells agents what to use;
// requests: Reassignment gives a new key and the old key redirects; requests:
// Request keys that use a renamed team key keep resolving; design.md, Design
// rules: Agent surfaces; design.md, Self-hosting decisions: S15; design.md,
// Readings to confirm with the founder: R17). Each request has one URL on the
// install's own host, /<KEY>, which the running web app negotiates in its
// proxy, before any route: HTML for a browser, markdown for text/markdown or
// the .md suffix, JSON for application/json or the .json suffix. HTML is what
// a call negotiates that asks for text/html, sends no Accept header, or sends
// one that names nothing more specific that Tiehall serves, such as */*, and
// uses neither suffix. Every representation needs credentials: a browser's
// web session, or an agent's token in the Authorization header, never in the
// query string. Without them, HTML is sent to sign-in and markdown and JSON
// get 401 with a body that names `tiehall get <url>` and get_request, and a
// member who was removed gets 403; neither holds data of the request. A key
// written with a team's earlier key, or a key the request had before a
// reassignment, leads to the request's canonical URL in every representation.
//
// The matrix runs against the web app as the image runs it (web-app.ts), with
// a real session, signed in with GitHub through the stub, and a real personal
// access token, so each row is one HTTP call, with exactly the headers it
// names. A browser's refusal is a page with the refusal's status
// (github-layer-hardening: design.md, Decisions this change rests on: D50 (7)).

/** What a browser sends, which names text/html. */
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
/** The title FE-1 is opened with, which no answer without credentials holds. */
const TITLE = "Add a dark mode to the settings page";
/** What Bob, of team FE, writes on FE-1. */
const FE_TEXT = "The settings page lives in the web app, next to the profile.";

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let signIn: SignInHarness;
/** The Cookie header of each person's browser, signed in to the web app. */
const browser: Record<string, string> = {};
/** Each person's personal access token. */
const token: Record<string, string> = {};

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const teams: Record<string, string> = {};
  for (const key of ["BE", "FE", "MOB", "OPS"]) teams[key] = await addTeam(install.owner, key);
  const people: Record<string, string> = {};
  for (const login of ["alice", "bob", "dana"]) {
    const account = stub.addUser({ login });
    people[login] = await addUser(install.owner, { login, githubAccountId: account.id });
  }
  people["pia"] = await addUser(install.owner, { login: "pia", role: "admin" });
  const [alice, bob, dana, pia] = [people["alice"]!, people["bob"]!, people["dana"]!, people["pia"]!];
  await joinTeams(install.owner, alice, teams["BE"]!);
  await joinTeams(install.owner, bob, teams["FE"]!);
  await joinTeams(install.owner, dana, teams["FE"]!);

  web = await startWebApp(install);
  signIn = await startSignIn(install, stub, { url: web.url });
  for (const login of ["bob", "dana"]) {
    browser[login] = (await signIn.signIn(login)).jar.header();
    expect(browser[login]).toContain("tiehall.session_token=");
    const created = await install.confirm(sessionOf(people[login]!), "personal_access_tokens.create", { name: "Agent", scopes: ["requests:read"], expiresInDays: 30 });
    token[login] = /<pre><code>(th_pat_[A-Za-z0-9_-]+)<\/code><\/pre>/.exec(await created.text())?.[1] ?? "";
    expect(token[login]).toMatch(/^th_pat_/);
  }

  // FE-1, with text team FE wrote; FE-2, reassigned to MOB, which makes it MOB-1; OPS-1, whose team's key becomes SRE.
  await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: TITLE });
  await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-1/messages", { kind: "comment", body: FE_TEXT });
  await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Move the banner" });
  const reassign = await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-2/proposals", { kind: "reassign", team: "MOB" });
  expect((await install.confirm(sessionOf(bob), "proposals.confirm", { proposal: reassign.body.proposal.id })).status).toBe(200);
  // FE-3, reassigned to MOB, which makes it MOB-2, and then undone, which makes it FE-3 again.
  await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Fix the footer" });
  const moved = await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-3/proposals", { kind: "reassign", team: "MOB" });
  expect((await install.confirm(sessionOf(bob), "proposals.confirm", { proposal: moved.body.proposal.id })).status).toBe(200);
  expect((await install.confirm(sessionOf(bob), "proposals.undo", { proposal: moved.body.proposal.id })).status).toBe(200);
  await openRequest(install, tokenOf(alice), { targetTeam: "OPS", title: "Rotate the logs" });
  const admin = sessionOf(pia);
  const renamed = await install.web(admin).write("teams.change_key", { teamId: teams["OPS"], key: "SRE" }, install.fromThePage(admin));
  expect(renamed.ok).toBe(true);

  // Dana is removed from the install, which ends her session and revokes her token.
  expect((await install.confirm(sessionOf(pia), "members.remove", { userId: dana })).status).toBe(200);
}, 300_000);

afterAll(async () => {
  await web?.close();
  await stub?.close();
  await install?.close();
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Calls the web app at this path with exactly these headers, and no Accept header unless they name one. */
function call(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const { hostname, port } = new URL(web.origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname, port, path, method: "GET", headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") }));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** The credentials a row's call carries: a person's browser session, their token in the Authorization header, or none. */
function credentials(as: string): Record<string, string> {
  const [kind, login = ""] = as.split(":");
  if (kind === "session") return { cookie: browser[login] ?? "" };
  if (kind === "token") return { authorization: `Bearer ${token[login] ?? ""}` };
  return {};
}

/** The media type of an answer, without its parameters. */
function mediaType(answer: Answer): string {
  return String(answer.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
}

/** Where a redirect leads, as a path and query on the install. */
function location(answer: Answer): URL {
  return new URL(String(answer.headers["location"] ?? ""), web.url);
}

interface Row {
  name: string;
  path: string;
  /** Who calls: `session:<login>`, `token:<login>` or `none`. */
  as: string;
  /** The Accept header, or none. */
  accept?: string;
  check(answer: Answer): void | Promise<void>;
}

/** An HTML page of FE-1, as the request page shows it. */
function isPageOfFe1(answer: Answer): void {
  expect(answer.status).toBe(200);
  expect(mediaType(answer)).toBe("text/html");
  expect(answer.body).toContain("FE-1");
  expect(answer.body).toContain(TITLE);
}

/** Markdown of FE-1, in which what team FE wrote sits inside a fence. */
function isMarkdownOfFe1(answer: Answer): void {
  expect(answer.status).toBe(200);
  expect(mediaType(answer)).toBe("text/markdown");
  expect(answer.body).toContain("FE-1");
  expect(answer.body).toMatch(new RegExp(`<tiehall-data-[0-9a-f]+ origin="same team">\\n${FE_TEXT}\\n</tiehall-data-[0-9a-f]+>`));
}

/** The JSON of FE-1, exactly the body of the /api/v1 read with the same token. */
async function isJsonOfFe1(answer: Answer): Promise<void> {
  expect(answer.status).toBe(200);
  expect(mediaType(answer)).toBe("application/json");
  const read = await call("/api/v1/requests/FE-1", credentials("token:bob"));
  expect(read.status).toBe(200);
  expect(answer.body).toBe(read.body);
}

/** Sent to sign-in, which leads back to the URL, with nothing of the request. */
function isSentToSignIn(path: string) {
  return (answer: Answer): void => {
    expect(answer.status).toBe(303);
    expect(location(answer).pathname).toBe("/sign-in");
    expect(location(answer).searchParams.get("return")).toBe(path);
    expect(answer.body).not.toContain(TITLE);
  };
}

/** 401, and nothing of the request. */
function isRefusedUnauthenticated(answer: Answer): void {
  expect(answer.status).toBe(401);
  expect(answer.body).not.toContain(TITLE);
  expect(answer.body).not.toContain(FE_TEXT);
}

/** 401 with a body that names `tiehall get <url>` and get_request, and nothing of the request. */
function isToldWhatToUse(answer: Answer): void {
  expect(answer.status).toBe(401);
  expect(answer.body).toContain("tiehall get <url>");
  expect(answer.body).toContain("get_request");
  expect(answer.body).not.toContain(TITLE);
  expect(answer.body).not.toContain(FE_TEXT);
}

/** 403 for a member who was removed, as a page for a browser and a problem for any other client, with nothing of the request. */
function isRemovedMember(html: boolean) {
  return (answer: Answer): void => {
    expect(answer.status).toBe(403);
    expect(mediaType(answer)).toBe(html ? "text/html" : "application/problem+json");
    expect(answer.body).toContain("https://tiehall.com/problems/removed-member");
    expect(answer.body).not.toContain(TITLE);
    expect(answer.body).not.toContain(FE_TEXT);
    if (html) {
      // A page with a way on, which runs no script and cannot be framed.
      expect(answer.body).toContain('<a href="/FE-1">');
      expect(answer.body).not.toContain("<script");
      expect(answer.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
  };
}

/** A redirect to the request's canonical URL. */
function leadsTo(path: string) {
  return (answer: Answer): void => {
    expect(answer.status).toBe(307);
    expect(`${location(answer).pathname}${location(answer).search}`).toBe(path);
  };
}

const ROWS: Row[] = [
  // HTML, which a browser, a call without Accept and one that accepts anything negotiate.
  { name: "a signed-in browser gets the HTML page", path: "/FE-1", as: "session:bob", accept: BROWSER, check: isPageOfFe1 },
  { name: "a signed-in call without an Accept header gets HTML", path: "/FE-1", as: "session:bob", check: isPageOfFe1 },
  { name: "a signed-in call that accepts */* gets HTML", path: "/FE-1", as: "session:bob", accept: "*/*", check: isPageOfFe1 },
  // Markdown, by Accept and by suffix.
  { name: "Accept: text/markdown with a token gets markdown", path: "/FE-1", as: "token:bob", accept: "text/markdown", check: isMarkdownOfFe1 },
  { name: ".md with a token gets markdown", path: "/FE-1.md", as: "token:bob", check: isMarkdownOfFe1 },
  { name: ".md wins over Accept: application/json", path: "/FE-1.md", as: "token:bob", accept: "application/json", check: isMarkdownOfFe1 },
  { name: "Accept: text/markdown with a browser session gets markdown", path: "/FE-1", as: "session:bob", accept: "text/markdown", check: isMarkdownOfFe1 },
  // JSON, by Accept and by suffix, equal to the /api/v1 read.
  { name: "Accept: application/json with a token gets the /api/v1 read", path: "/FE-1", as: "token:bob", accept: "application/json", check: isJsonOfFe1 },
  { name: ".json with a token gets the /api/v1 read", path: "/FE-1.json", as: "token:bob", check: isJsonOfFe1 },
  { name: ".json wins over Accept: text/html", path: "/FE-1.json", as: "token:bob", accept: "text/html", check: isJsonOfFe1 },
  // Without credentials.
  { name: "a browser without a session is sent to sign-in", path: "/FE-1", as: "none", accept: BROWSER, check: isSentToSignIn("/FE-1") },
  { name: "a call without credentials or Accept is sent to sign-in", path: "/FE-1", as: "none", check: isSentToSignIn("/FE-1") },
  { name: "a call without credentials that accepts */* is sent to sign-in", path: "/FE-1", as: "none", accept: "*/*", check: isSentToSignIn("/FE-1") },
  { name: "Accept: text/markdown without credentials gets 401", path: "/FE-1", as: "none", accept: "text/markdown", check: isToldWhatToUse },
  { name: ".md without credentials gets 401", path: "/FE-1.md", as: "none", check: isToldWhatToUse },
  { name: "Accept: application/json without credentials gets 401", path: "/FE-1", as: "none", accept: "application/json", check: isToldWhatToUse },
  { name: ".json without credentials that accepts */* gets 401", path: "/FE-1.json", as: "none", accept: "*/*", check: isToldWhatToUse },
  // No secret links: a token only in the query string names nobody.
  { name: "a token in the query string is ignored", path: `/FE-1.json?access_token=TOKEN`, as: "none", check: isRefusedUnauthenticated },
  // A member who was removed.
  { name: "a removed member's browser session gets 403", path: "/FE-1", as: "session:dana", accept: BROWSER, check: isRemovedMember(true) },
  { name: "a removed member's session gets 403 for markdown", path: "/FE-1.md", as: "session:dana", check: isRemovedMember(false) },
  { name: "a removed member's token gets 403 for JSON", path: "/FE-1.json", as: "token:dana", check: isRemovedMember(false) },
  // A key that names no request of the install.
  {
    name: "a key that names no request gets 404, as a page for a browser",
    path: "/FE-999",
    as: "session:bob",
    accept: BROWSER,
    check: (answer) => {
      expect(answer.status).toBe(404);
      expect(mediaType(answer)).toBe("text/html");
      expect(answer.body).toContain("https://tiehall.com/problems/record-not-found");
      expect(answer.body).toContain('<a href="/FE-999">');
    },
  },
  {
    name: "a key that names no request gets 404 as a problem for JSON",
    path: "/FE-999.json",
    as: "token:bob",
    check: (answer) => {
      expect(answer.status).toBe(404);
      expect(mediaType(answer)).toBe("application/problem+json");
    },
  },
  // A team's earlier key, and a key from before a reassignment, lead to the canonical URL in every representation.
  { name: "a renamed team's old key leads a browser to the new key", path: "/OPS-1", as: "session:bob", accept: BROWSER, check: leadsTo("/SRE-1") },
  { name: "a renamed team's old key leads markdown to the new key", path: "/OPS-1.md", as: "token:bob", check: leadsTo("/SRE-1.md") },
  { name: "a renamed team's old key leads JSON to the new key", path: "/OPS-1.json", as: "token:bob", check: leadsTo("/SRE-1.json") },
  { name: "a renamed team's old key leads a negotiated call to the new key", path: "/OPS-1", as: "token:bob", accept: "application/json", check: leadsTo("/SRE-1") },
  { name: "a reassigned request's old key leads a browser to its new key", path: "/FE-2", as: "session:bob", accept: BROWSER, check: leadsTo("/MOB-1") },
  { name: "a reassigned request's old key leads markdown to its new key", path: "/FE-2.md", as: "token:bob", check: leadsTo("/MOB-1.md") },
  { name: "a reassigned request's old key leads JSON to its new key", path: "/FE-2.json", as: "token:bob", check: leadsTo("/MOB-1.json") },
  { name: "an undone reassignment's new key leads a browser back to the old key", path: "/MOB-2", as: "session:bob", accept: BROWSER, check: leadsTo("/FE-3") },
  { name: "an undone reassignment's new key leads JSON back to the old key", path: "/MOB-2.json", as: "token:bob", check: leadsTo("/FE-3.json") },
  { name: "the canonical key after an undone reassignment serves the request", path: "/FE-3.json", as: "token:bob", check: (answer) => expect(JSON.parse(answer.body)).toMatchObject({ key: "FE-3" }) },
  { name: "an old key leads nobody without credentials anywhere", path: "/FE-2.json", as: "none", check: isToldWhatToUse },
];

describe("the negotiation matrix of /<KEY>", () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const path = row.path.replace("TOKEN", token["bob"] ?? "");
      const answer = await call(path, { ...credentials(row.as), ...(row.accept === undefined ? {} : { accept: row.accept }) });
      await row.check(answer);
    });
  }
});

// Request URL response headers (agent-surfaces: Request URL response headers;
// design.md, Design rules: Agent surfaces): every answer of a request URL, each
// representation and every refusal and redirect, sends Vary: Accept,
// Authorization, since the answer depends on both, Cache-Control: private,
// no-store, since it holds a member's view of the install, and an ETag.

/** The names a Vary header lists, in lower case. */
function varied(answer: Answer): string[] {
  const vary = answer.headers["vary"];
  return (Array.isArray(vary) ? vary.join(",") : (vary ?? "")).split(",").map((name) => name.trim().toLowerCase());
}

const ANSWERS: { name: string; path: string; as: string; accept?: string; status: number }[] = [
  { name: "the HTML page", path: "/FE-1", as: "session:bob", accept: BROWSER, status: 200 },
  { name: "markdown by suffix", path: "/FE-1.md", as: "token:bob", status: 200 },
  { name: "markdown by Accept", path: "/FE-1", as: "token:bob", accept: "text/markdown", status: 200 },
  { name: "JSON by suffix", path: "/FE-1.json", as: "token:bob", status: 200 },
  { name: "JSON by Accept", path: "/FE-1", as: "token:bob", accept: "application/json", status: 200 },
  { name: "a removed member's 403", path: "/FE-1.json", as: "token:dana", status: 403 },
  { name: "the redirect to sign-in", path: "/FE-1", as: "none", accept: BROWSER, status: 303 },
  { name: "the 401 without credentials", path: "/FE-1.md", as: "none", status: 401 },
  { name: "the redirect from an old key", path: "/FE-2.json", as: "token:bob", status: 307 },
];

describe("the headers of every answer of /<KEY>", () => {
  for (const row of ANSWERS) {
    it(`${row.name} sends Vary: Accept, Authorization, Cache-Control: private, no-store and an ETag`, async () => {
      const answer = await call(row.path, { ...credentials(row.as), ...(row.accept === undefined ? {} : { accept: row.accept }) });
      expect(answer.status).toBe(row.status);
      expect(varied(answer)).toEqual(expect.arrayContaining(["accept", "authorization"]));
      expect(answer.headers["cache-control"]).toBe("private, no-store");
      expect(answer.headers["etag"]).toMatch(/^(W\/)?"[^"]+"$/);
    });
  }
});

// sign-in: Signing out and ending sessions (github-layer-hardening: design.md, Decisions this change rests on: D50 (6);
// Technical decisions: T4). The web UI's page of a request is a server component, which cannot set a cookie, so the
// proxy that negotiates the URL reads the session the way a route handler does: a use a day or more after the session
// was created or last extended extends it to 7 days after that use, and the answer, the page's included, carries the
// cookie that renews the browser's.
describe("the web session a request URL reads", () => {
  /** A fresh sign-in of Bob's, last extended two days ago; returns the browser's Cookie header. */
  async function staleSession(): Promise<string> {
    const cookie = (await signIn.signIn("bob")).jar.header();
    const token = decodeURIComponent(/tiehall\.session_token=([^;]+)/.exec(cookie)?.[1] ?? "").split(".")[0];
    const { rowCount } = await install.owner.query("UPDATE web_sessions SET expires_at = now() + interval '5 days' WHERE token = $1", [token]);
    expect(rowCount).toBe(1);
    return cookie;
  }

  /** Whether the answer renews the session's cookie for 7 days. */
  function renews(answer: Answer): boolean {
    const cookies = answer.headers["set-cookie"] ?? [];
    return (Array.isArray(cookies) ? cookies : [cookies]).some((line) => /^tiehall\.session_token=[^;]+;/.test(line) && /;\s*Max-Age=604800(?:;|$)/i.test(line));
  }

  it("is renewed by the page's answer, which carries the renewed cookie", async () => {
    const page = await call("/FE-1", { cookie: await staleSession(), accept: BROWSER });
    expect(page.status).toBe(200);
    expect(renews(page)).toBe(true);
  });

  it("is renewed by a markdown or JSON answer too, and by a refusal", async () => {
    expect(renews(await call("/FE-1.json", { cookie: await staleSession() }))).toBe(true);
    const missing = await call("/FE-999", { cookie: await staleSession(), accept: BROWSER });
    expect(missing.status).toBe(404);
    expect(renews(missing)).toBe(true);
  });
});

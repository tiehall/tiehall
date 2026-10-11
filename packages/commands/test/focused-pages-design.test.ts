import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { CLI_CLIENT_ID, reopenSetup } from "../src/index.ts";
import { MCP_RESOURCE, pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { startAppServer, type AppServer } from "./support/app-server.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { element, mainOf } from "./support/markup.ts";
import { CookieJar } from "./support/sign-in.ts";

// The focused pages as the design draws them (web-ui: The page shell and its
// navigation; web-ui: The content security policy of each kind of page;
// agent-safety: The review page of the confirmation step; self-host-install:
// The setup code guards the setup screen; design.md, Design: The page
// families; D57 (4), (9)): the sign-in page, the mark large, the name, a line
// on what Tiehall is and the one button; the setup screen, its steps with the
// current one marked, the switchboard hidden from assistive technology, and
// each step's form; the review pages and confirmations, the action as the
// heading, what will happen as a list, warnings in the notice colors, other
// people's text fenced as a panel whose first line names where it came from,
// and the confirm and cancel buttons; the consent screen and the device
// approval page in the same layout; and the refusal pages, the status as a
// large number. Each takes the focused shell, runs no script and is served
// with no style element or attribute.

let stub: GitHubStub;
let app: AppServer;
let harness: AgentAccessHarness;
let ana: SignedIn;

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  app = await startAppServer(stub);
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
}, 300_000);

afterAll(async () => {
  await harness?.close();
  await app?.close();
  await stub?.close();
}, 300_000);

/** What every focused page keeps: the focused shell, with no navigation; no script; no style element or attribute. */
function expectFocused(html: string): void {
  expect(html).toContain('<main id="content" class="focused');
  expect(html).not.toMatch(/<nav\b/);
  expect(html).not.toMatch(/<script\b/i);
  expect(html).not.toMatch(/<style\b|\sstyle=/i);
}

/** A browser at the app server: its cookies, and the server's answers. */
function browser(jar = new CookieJar()) {
  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("accept", "text/html");
    if (jar.header() !== "") headers.set("cookie", jar.header());
    const answer = await app.handle(new Request(path.startsWith("http") ? path : `${app.url}${path}`, { ...init, headers }));
    jar.take(answer);
    return answer;
  };
  return {
    get: (path: string) => send(path),
    post: (path: string, fields: Record<string, string>) =>
      send(path, { method: "POST", headers: { origin: app.url, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }),
  };
}

/** The setup screen's list of steps: each step's name, and whether it is done or the current one. */
function stepsOf(html: string): string[] {
  const list = element(html, /<ol class="steps" aria-label="Setup steps">/, "ol");
  return [...list.matchAll(/<li( class="done"| aria-current="step")?>[\s\S]*?<\/span>([^<]+)/g)].map(([, mark = "", name = ""]) => `${name}${mark.includes("done") ? " (done)" : mark.includes("current") ? " (current)" : ""}`);
}

function unescapeHtml(text: string): string {
  return text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

describe("the sign-in page", () => {
  it("shows the mark large, the name, one line on what Tiehall is and the one button, in the focused shell", async () => {
    const html = await (await harness.handle(new Request(`${URL_OF_INSTALL}/sign-in`, { headers: { accept: "text/html" } }))).text();
    expectFocused(html);
    const main = mainOf(html);
    expect(main).toMatch(/<div class="sign-in">\s*<span class="mark large"><svg[^>]*aria-hidden="true"/);
    expect(main).toContain("<h1>Sign in to Tiehall</h1>");
    expect(main).toContain('<p class="lead">The line between your teams: requests, questions and commitments, with your agents at work on them.</p>');
    expect([...main.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)].map(([, text]) => text)).toEqual(["Sign in with GitHub"]);
  });
});

describe("the setup screen", () => {
  it("lists its steps with the current one marked, beside the switchboard, which assistive technology skips, and shows each step's form", async () => {
    const operator = browser();
    const code = await app.start();
    const first = await (await operator.get("/setup")).text();
    expectFocused(first);
    expect(first).toContain('<main id="content" class="focused wide">');
    expect(stepsOf(first)).toEqual(["Setup code (current)", "Company name", "GitHub App", "Install and sign in"]);
    expect(element(first, /<div class="setup-art">/, "div")).toMatch(/<svg class="switchboard"[^>]*aria-hidden="true"/);
    expect(element(first, /<div class="setup-art">/, "div")).toMatch(/<p class="setup-brand" aria-hidden="true">/);
    expect(first).toMatch(/<form method="post" action="\/setup">\s*<label for="code">Setup code<\/label>/);

    expect((await operator.post("/setup", { code })).status).toBe(303);
    const company = await (await operator.get("/setup")).text();
    expect(stepsOf(company)).toEqual(["Setup code (done)", "Company name (current)", "GitHub App", "Install and sign in"]);
    expect(company).toContain(`<label for="company">The company's name</label>`);

    expect((await operator.post("/setup/company", { name: "Acme" })).status).toBe(303);
    const appStep = await (await operator.get("/setup?org=acme")).text();
    expect(stepsOf(appStep)).toEqual(["Setup code (done)", "Company name (done)", "GitHub App (current)", "Install and sign in"]);
    const form = /<form method="post" action="([^"]+)">\s*<input type="hidden" name="manifest" value="([^"]*)">/.exec(appStep);
    expect(form).not.toBeNull();

    const action = new URL(unescapeHtml(form?.[1] ?? ""));
    const created = await stub.createAppFromManifest({ manifest: unescapeHtml(form?.[2] ?? ""), org: "acme", state: action.searchParams.get("state") ?? "", as: "omar" });
    if (created.status !== "created") throw new Error(created.messages.join(" "));
    expect((await operator.get(`/setup/github?${new URLSearchParams({ code: created.code, state: action.searchParams.get("state") ?? "" })}`)).status).toBe(303);
    const install = await (await operator.get("/setup")).text();
    expect(stepsOf(install)).toEqual(["Setup code (done)", "Company name (done)", "GitHub App (done)", "Install and sign in (current)"]);
    expect(install).toMatch(/<form method="post" action="\/setup\/sign-in">\s*<button type="submit">Sign in with GitHub<\/button>/);
  });

  it("lists GitHub App and then Install and sign in in a step that setup reopen opened", async () => {
    // Setup completes once an admin signs in; then the operator reopens the App step.
    await app.owner.query("UPDATE orgs SET setup_completed_at = now()");
    const operator = browser();
    expect((await operator.post("/setup", { code: (await reopenSetup(app.db)).code })).status).toBe(303);
    const reopened = await (await operator.get("/setup")).text();
    expect(stepsOf(reopened)).toEqual(["GitHub App (current)", "Install and sign in"]);
    expect(reopened).toContain("<h2>Create a new GitHub App</h2>");
  });
});

describe("the review pages, the consent screen and the device approval page", () => {
  it("the consent screen: the action as the heading, what happens as a list with its warnings in the notice colors, the client's name fenced with its origin as a label, and the confirm and cancel buttons", async () => {
    const client = await harness.registerClient({ client_name: "Claims to be <Claude>" });
    const authorized = await harness.authorize(ana.cookie, client, pkcePair(), { scope: "requests:read" });
    const url = new URL(authorized.headers.get("location") ?? "", URL_OF_INSTALL);
    const html = await (await harness.handle(new Request(url, { headers: { cookie: ana.cookie, accept: "text/html" } }))).text();
    expectFocused(html);
    const main = mainOf(html);
    expect(main).toMatch(/<p class="eyebrow">Review, then confirm<\/p>\s*<h1>Approve an agent client<\/h1>\s*<div class="panel decision">/);
    expect(main).toMatch(/<ul class="review-lines">\s*<li>An agent client asks to act for you in Tiehall\. It calls itself:<\/li>\s*<\/ul>/);
    expect(main).toContain('<blockquote class="untrusted" data-origin="external"><p>Text from outside Tiehall, quoted as data:</p><pre>Claims to be &#60;Claude&#62;</pre></blockquote>');
    expect(main).toMatch(/<li class="warning">Unverified client: it registered itself with this install/);
    const end = element(main, /<div class="decision-end">/, "div");
    expect(end).toMatch(/<button type="submit">Confirm<\/button>[\s\S]*<a class="link-action" href="\/">Cancel<\/a>/);
  });

  it("the device approval page: the code's field labelled in a panel, then the review with the address and time and its warning", async () => {
    const entry = await (await harness.handle(new Request(`${URL_OF_INSTALL}/device`, { headers: { cookie: ana.cookie, accept: "text/html" } }))).text();
    expectFocused(entry);
    expect(mainOf(entry)).toMatch(/<div class="panel decision">[\s\S]*<div class="field">\s*<label for="user_code">/);
    const started = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.44" },
        body: new URLSearchParams({ client_id: CLI_CLIENT_ID, resource: MCP_RESOURCE, scope: "requests:read" }).toString(),
      }),
    );
    const { user_code: userCode } = (await started.json()) as { user_code: string };
    const csrf = /<input type="hidden" name="csrf" value="([^"]*)">/.exec(entry)?.[1] ?? "";
    const review = await (
      await harness.handle(
        new Request(`${URL_OF_INSTALL}/device`, {
          method: "POST",
          headers: { cookie: ana.cookie, accept: "text/html", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
          body: new URLSearchParams({ user_code: userCode, csrf }).toString(),
        }),
      )
    ).text();
    expectFocused(review);
    expect(review).toMatch(/<li>from the IP address 203\.0\.113\.44, at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\.<\/li>/);
    expect(review).toContain('<li class="warning">Continue only if you just ran tiehall login.</li>');
    expect(element(review, /<div class="decision-end">/, "div")).toMatch(/<button type="submit">Confirm<\/button>[\s\S]*Cancel<\/a>/);
  });
});

describe("the refusal pages", () => {
  it("show the status as a large mono number, the title, the detail, the way on as a button-styled link and the problem type, in the focused shell", async () => {
    const answer = await browser().get("/setup/no-such-step");
    expect(answer.status).toBe(404);
    const html = await answer.text();
    expectFocused(html);
    const refusal = element(mainOf(html), /<div class="refusal">/, "div");
    expect(refusal).toMatch(/^<div class="refusal">\s*<p class="status">404<\/p>\s*<h1>[^<]+<\/h1>\s*<p class="lead">[^<]+<\/p>\s*<p><a class="button" href="[^"]+">[^<]+<\/a><\/p>\s*<p class="problem-type">Problem type: <code>https:\/\/tiehall\.com\/problems\/[a-z-]+<\/code><\/p>/);
  });
});

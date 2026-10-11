import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sendApi, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// Request content in the web UI (agent-safety: The web UI renders no raw HTML
// and no remote images; design.md, Design rules: Agent safety). Everything
// people and agents write, a request's title, its packet and its thread, is
// text on every page that shows it: markup in it shows as the characters it
// is made of and runs nothing, and a markdown image in it loads nothing. The
// request's page also sends a content security policy that lets it load
// scripts only with a nonce made for that answer, and images, styles, fonts
// and connections only from the install, so no text a page shows could make
// the browser run a script or fetch a remote image. The pages run in the
// installed Chrome against the web app as the image runs it (web-app.ts),
// which logs every request the browser makes and every dialog a script
// opens.

const HTML = "<img src=x onerror=alert(1)>";
const IMAGE = "![x](https://tracker.example/pixel.png)";

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let browser: Browser;
let signIn: SignInHarness;
/** Alice's proposal to change FE-1's packet, whose confirm page quotes the packet it proposes. */
let scope: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const alice = await addUser(install.owner, { login: "alice", githubAccountId: stub.addUser({ login: "alice" }).id });
  const bob = await addUser(install.owner, { login: "bob", githubAccountId: stub.addUser({ login: "bob" }).id });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await openRequest(install, tokenOf(alice), {
    targetTeam: "FE",
    title: `Fix ${HTML}`,
    packet: { schema_version: "1-beta", kind: "request", untrusted: { need: `${HTML}\n${IMAGE}`, acceptance_criteria: [HTML, IMAGE] } },
  });
  for (const body of [HTML, IMAGE, `<script>alert(2)</script>`, `<iframe src="https://tracker.example/frame"></iframe>`]) {
    expect((await callApi(install, tokenOf(alice), "POST", "/api/v1/requests/FE-1/messages", { kind: "comment", body })).status).toBe(200);
  }
  expect((await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
  const proposed = await sendApi(install, tokenOf(alice), "POST", "/api/v1/proposals", {
    headers: { "if-match": '"1"' },
    body: { kind: "scope", key: "FE-1", packet: { schema_version: "1-beta", kind: "request", untrusted: { need: `${HTML} ${IMAGE} again` } } },
  });
  expect(proposed.status).toBe(202);
  scope = proposed.body.proposal.id;
  web = await startWebApp(install);
  signIn = await startSignIn(install, stub, { url: web.url });
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await web?.close();
  await stub?.close();
  await install?.close();
}, 60_000);

/** What a page did in the browser: every URL it requested, and every dialog a script opened. */
interface Watched {
  page: Page;
  requested: string[];
  dialogs: string[];
}

/** A page of this person's own browser, signed in to the web app, which logs what it requests and every dialog. */
async function watchedPageOf(login: string): Promise<Watched> {
  const [name = "", value = ""] = ((await signIn.signIn(login)).jar.header().split("; ").find((pair) => pair.startsWith("tiehall.session_token=")) ?? "").split(/=(.*)/s);
  const context = await browser.newContext();
  await context.addCookies([{ name, value, url: web.url }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const watched: Watched = { page, requested: [], dialogs: [] };
  page.on("request", (request) => void watched.requested.push(request.url()));
  page.on("dialog", (dialog) => {
    watched.dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  // Every content security policy violation on the page, such as a script of the app's own that lacks the nonce.
  // The script runs in the browser, before the page's own, so it is given as its source.
  await page.addInitScript({
    content: `window.tiehallViolations = [];
document.addEventListener("securitypolicyviolation", (event) => window.tiehallViolations.push(event.violatedDirective + " " + event.blockedURI));`,
  });
  return watched;
}

/** The content security policy violations the page has seen. */
function violationsOf({ page }: Watched): Promise<string[]> {
  return page.evaluate("window.tiehallViolations");
}

/** Opens a path of the web app and waits until the page has settled, its scripts run. */
async function visit({ page }: Watched, path: string): Promise<void> {
  await page.goto(`${web.url}${path}`);
  await page.waitForLoadState("networkidle");
}

/** The hosts, other than the install's, that the page requested anything from. */
function otherHosts({ requested }: Watched): string[] {
  const install = new URL(web.url).host;
  return [...new Set(requested.map((url) => new URL(url).host).filter((host) => host !== install))];
}

describe("request content in the web UI", () => {
  it("shows markup in the request's title, packet and thread as text, and runs no script from it", { timeout: 120_000 }, async () => {
    const watched = await watchedPageOf("alice");
    await visit(watched, "/FE-1");
    const { page } = watched;
    expect(await page.getByRole("heading", { level: 1 }).innerText()).toBe(`Fix ${HTML}`);
    expect(await page.getByRole("region", { name: "Packet" }).innerText()).toContain(HTML);
    const thread = await page.getByRole("region", { name: "Thread" }).innerText();
    expect(thread).toContain(HTML);
    expect(thread).toContain("<script>alert(2)</script>");
    // No element came from the text: the page's main content holds no image, script, frame or object.
    expect(await page.locator("main img, main script, main iframe, main object, main embed").count()).toBe(0);
    expect(watched.dialogs).toEqual([]);
    // The page's own scripts carry the nonce, so the policy blocks none of them.
    expect(await violationsOf(watched)).toEqual([]);
    await page.context().close();
  });

  it("loads no remote image a markdown image in the packet or the thread names, nor anything else from another host", { timeout: 120_000 }, async () => {
    const watched = await watchedPageOf("alice");
    await visit(watched, "/FE-1");
    expect(await watched.page.getByRole("region", { name: "Thread" }).innerText()).toContain(IMAGE);
    expect(watched.requested.filter((url) => new URL(url).host === "tracker.example")).toEqual([]);
    expect(otherHosts(watched)).toEqual([]);
    await watched.page.context().close();
  });

  it("shows the same text, and loads and runs nothing from it, on the request lists and the proposal's confirm page", { timeout: 120_000 }, async () => {
    const watched = await watchedPageOf("alice");
    await visit(watched, "/requests?list=all");
    expect(await watched.page.locator("main").innerText()).toContain(`Fix ${HTML}`);
    await visit(watched, `/confirm/${scope}`);
    expect(await watched.page.locator("main").innerText()).toContain(`${HTML} ${IMAGE} again`);
    expect(await watched.page.locator("main img, main script, main iframe").count()).toBe(0);
    expect(watched.dialogs).toEqual([]);
    expect(otherHosts(watched)).toEqual([]);
    await watched.page.context().close();
  });

  it("sends a content security policy on the request's page that allows scripts only by a fresh nonce, and images only from the install", async () => {
    const [cookie] = (await signIn.signIn("alice")).jar.header().split("; ").filter((pair) => pair.startsWith("tiehall.session_token="));
    const fetchPage = () => web.fetch("/FE-1", { headers: { accept: "text/html", cookie: cookie ?? "" } });
    const first = await fetchPage();
    expect(first.status).toBe(200);
    const policy = first.headers.get("content-security-policy") ?? "";
    const directives = new Map(policy.split(";").map((directive) => directive.trim().split(/\s+/)).map(([name = "", ...values]) => [name, values]));
    // Styles, fonts and images from the install only, and no inline style (web-ui: The content security policy of each
    // kind of page; D57 (9)).
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("img-src")).toEqual(["'self'"]);
    expect(directives.get("style-src")).toEqual(["'self'"]);
    expect(directives.get("font-src")).toEqual(["'self'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    const scripts = directives.get("script-src") ?? [];
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts.filter((source) => !source.startsWith("'nonce-"))).toEqual(["'strict-dynamic'"]);
    const nonce = scripts.find((source) => source.startsWith("'nonce-"));
    expect(nonce).toMatch(/^'nonce-[A-Za-z0-9+/_-]{22,}={0,2}'$/);
    // Every script the page carries has that nonce, so the browser runs Tiehall's scripts and nothing else.
    const html = await first.text();
    const tags = [...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce!.slice("'nonce-".length, -1)}"`);
    // A fresh nonce on each answer.
    const second = (await fetchPage()).headers.get("content-security-policy") ?? "";
    expect(second).not.toBe(policy);
  });
});

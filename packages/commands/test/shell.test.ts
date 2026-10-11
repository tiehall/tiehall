import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { assetUrl } from "../src/assets.ts";
import { startSetup } from "../src/index.ts";
import { focusedShellFor, initialsOf, memberMenu, navigation, type ShellMember } from "../src/shell.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { PAGES, seedInventory, type InventorySeed } from "./support/page-inventory.ts";
import { sessionOf } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The page shell and its navigation (web-ui: The page shell and its
// navigation; web-ui: The mark, the favicon and the app icon; web-ui: One
// stylesheet with named design tokens; web-ui: Light and dark themes follow
// the system; design.md, Design: The page shell and navigation; D57 (4)).
// Every page of the web UI shares one shell: a link that skips to the main
// content, the top bar with the mark, one main landmark with one first-level
// heading, and the footer with the running version and its source link. A
// signed-in member's pages take the app shell, with the navigation, the
// number of proposals waiting for them, New request and their menu; the pages
// where a person makes one decision or has no session take the focused shell,
// the mark and the name alone. The shell's model is one, shell.ts, which the
// string pages of the web role and the pages Next.js renders both draw; its
// one read is web.shell, an internal command that no agent surface offers.

const MEMBER: ShellMember = { login: "bob", bot: false, admin: false, waiting: 0 };
const ADMIN: ShellMember = { login: "ada", bot: false, admin: true, waiting: 2 };

describe("the shell's model", () => {
  it("links a member to the live hall, the inbox, the requests and the members, and an admin to the admin pages too", () => {
    expect(navigation(MEMBER, "/requests").map(({ href, text }) => [href, text])).toEqual([
      ["/hall", "Live hall"],
      ["/inbox", "Inbox"],
      ["/requests", "Requests"],
      ["/members", "Members"],
    ]);
    expect(navigation(ADMIN, "/inbox").map(({ href }) => href)).toEqual(["/hall", "/inbox", "/requests", "/members", "/admin"]);
  });

  it.each([
    ["/requests", "/requests"],
    ["/requests/new", undefined],
    ["/FE-142", "/requests"],
    ["/FE", "/requests"],
    ["/inbox", "/inbox"],
    ["/admin/teams", "/admin"],
    ["/admin", "/admin"],
    ["/members", "/members"],
    ["/hall", "/hall"],
    ["/", undefined],
    ["/settings/email", undefined],
  ])("marks the current page on %s", (path, current) => {
    expect(navigation(ADMIN, path).find((item) => item.current)?.href).toBe(current);
    expect(navigation(ADMIN, path).filter((item) => item.current).length).toBeLessThanOrEqual(1);
  });

  it("counts what waits for the member beside the inbox only when something does, in words a screen reader reads", () => {
    expect(navigation(MEMBER, "/").find(({ href }) => href === "/inbox")?.waiting).toBeUndefined();
    expect(navigation(ADMIN, "/").find(({ href }) => href === "/inbox")?.waiting).toEqual({ count: 2, words: "2 waiting" });
    expect(navigation({ ...MEMBER, waiting: 1 }, "/").find(({ href }) => href === "/inbox")?.waiting).toEqual({ count: 1, words: "1 waiting" });
  });

  it("holds the member's email settings and their connected agents and tokens in their menu", () => {
    expect(memberMenu("/tokens")).toEqual([
      { href: "/settings/email", text: "Email settings", current: false },
      { href: "/tokens", text: "Connected agents and tokens", current: true },
    ]);
  });

  it.each([
    ["pia", "PI"],
    ["mert-kaya", "MK"],
    ["ayse_yilmaz", "AY"],
    ["octo-cat-42", "OC"],
    ["a", "A"],
  ])("draws %s's initials as %s", (login, initials) => {
    expect(initialsOf(login)).toBe(initials);
  });

  it.each([
    ["/sign-in", true],
    ["/setup", true],
    ["/setup/github/app", true],
    ["/confirm/members.change_role", true],
    ["/confirm/0b9d6c1e-0000-4000-8000-000000000000/undo", true],
    ["/consent", true],
    ["/device", true],
    ["/docs/api/changelog", true],
    ["/inbox", false],
    ["/admin/teams", false],
    ["/FE-142", false],
    ["/", false],
  ])("gives %s the focused shell: %s", (path, focused) => {
    expect(focusedShellFor(path)).toBe(focused);
  });
});

let stub: GitHubStub;
let install: TestInstall;
let seed: InventorySeed;
let web: WebApp;
const cookies = new Map<string, string>();
/** An install whose setup is not complete, with its web app and the setup code its start printed. */
let fresh: { install: TestInstall; web: WebApp; code: string };

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  seed = await seedInventory(install, stub);
  web = await startWebApp(install);
  const signIn = await startSignIn(install, stub, { url: web.url });
  for (const login of ["pia", "alice"]) cookies.set(login, (await signIn.signIn(login)).jar.header());
  const unset = await startTestInstall();
  await unset.owner.query("UPDATE orgs SET name = NULL, setup_completed_at = NULL");
  const freshWeb = await startWebApp(unset);
  const started = await startSetup({ database: unset.db, url: freshWeb.url, logger: unset.logger });
  fresh = { install: unset, web: freshWeb, code: started?.code ?? "" };
}, 300_000);

afterAll(async () => {
  await web?.close();
  await fresh?.web.close();
  await fresh?.install.close();
  await install?.close();
  await stub?.close();
}, 60_000);

describe("web.shell", () => {
  it("reads the member's login, bot flag, role and the proposals that wait for them, as the standing list counts them", async () => {
    const shell = await install.execute("web.shell", sessionOf(seed.pia), {}, { readOnly: true });
    const standing = (await install.execute("inbox.standing_list", sessionOf(seed.pia), {}, { readOnly: true })) as { waiting: unknown[] };
    expect(standing.waiting.length).toBe(1);
    expect(shell).toEqual({ login: "pia", kind: "human", bot: false, admin: true, waiting: 1 });
    expect(await install.execute("web.shell", sessionOf(seed.alice), {}, { readOnly: true })).toEqual({ login: "alice", kind: "human", bot: false, admin: false, waiting: 0 });
    await install.owner.query("UPDATE users SET bot = true WHERE github_login = 'alice'");
    expect(await install.execute("web.shell", sessionOf(seed.alice), {}, { readOnly: true })).toMatchObject({ login: "alice", bot: true });
    await install.owner.query("UPDATE users SET bot = false WHERE github_login = 'alice'");
  });

  it("refuses a removed member with 403", async () => {
    const lee = await addUser(install.owner, { login: "lee", githubAccountId: stub.addUser({ login: "lee" }).id });
    expect(await install.confirm(sessionOf(seed.pia), "members.remove", { userId: lee })).toMatchObject({ status: 200 });
    await expect(install.execute("web.shell", sessionOf(lee), {}, { readOnly: true })).rejects.toMatchObject({ reason: "removed-member" });
  });

  it("is offered by no agent surface: neither the OpenAPI document nor the MCP tools name it", () => {
    for (const file of ["../../../openapi/v1.json", "../../../mcp/tools.json"]) {
      expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"), file).not.toMatch(/web\.shell|webShell/);
    }
  });
});

/** A browser's GET of a page of the web app, with the Host the install's URL names, as the setup screen needs. */
function open(app: WebApp, path: string, cookie?: string): Promise<{ status: number; html: string }> {
  const { port, host } = new URL(app.url);
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path, headers: { host, accept: "text/html", ...(cookie === undefined ? {} : { cookie }) } }, (answer) => {
      let html = "";
      answer.setEncoding("utf8");
      answer.on("data", (chunk: string) => (html += chunk));
      answer.on("end", () => resolve({ status: answer.statusCode ?? 0, html }));
    });
    call.on("error", reject);
    call.end();
  });
}

/** The pages the web role renders that a signed-in person opens, by their route file: every page of the inventory but the pages Next.js renders and the API reference and changelog pages. */
function webRolePages(): [string, string][] {
  return Object.entries(PAGES)
    .filter(([route]) => !["[key]/page.tsx", "docs/api/route.ts", "docs/api/changelog/route.ts"].includes(route))
    .flatMap(([route, paths]) => (route === "confirm/[...command]/route.ts" ? seed.confirmPaths : paths).map((path) => [route, path] as [string, string]));
}

/** What every page of the web UI is served with: the head, the skip link, the top bar, one main with one h1, and the footer. */
function expectShell(path: string, html: string): void {
  expect(html, path).toMatch(/^<!doctype html>\n<html lang="en">/);
  for (const link of [
    `<link rel="stylesheet" href="${assetUrl("/assets/tiehall.css")}">`,
    `<link rel="icon" href="${assetUrl("/assets/icon.svg")}" type="image/svg+xml">`,
    `<link rel="icon" href="${assetUrl("/favicon.ico")}" sizes="16x16 32x32 48x48">`,
    `<link rel="apple-touch-icon" href="${assetUrl("/assets/icon-180.png")}">`,
    `<link rel="manifest" href="${assetUrl("/assets/manifest.webmanifest")}">`,
    '<meta name="color-scheme" content="light dark">',
    '<meta name="theme-color" content="#F6F7F9" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#0E1117" media="(prefers-color-scheme: dark)">',
  ]) {
    expect(html, `${path}: ${link}`).toContain(link);
  }
  const body = html.slice(html.indexOf("<body"));
  expect(body, path).toMatch(/^<body[^>]*>\s*<a class="skip" href="#content">Skip to content<\/a>/);
  expect(body.match(/<header\b/g), path).toHaveLength(1);
  expect(body.match(/<main\b/g), path).toHaveLength(1);
  expect(body, path).toMatch(/<main id="content"/);
  expect(body.match(/<h1\b/g), path).toHaveLength(1);
  expect(body.match(/<footer\b/g), path).toHaveLength(1);
  expect(/<footer>([\s\S]*?)<\/footer>/.exec(body)?.[1], path).toMatch(/Tiehall [^<]+ · <a href="[^"]+">Source code<\/a>/);
  expect(html, path).not.toMatch(/<style\b|\sstyle=/i);
  expect(body, path).toMatch(/<span class="mark">\s*<svg [^>]*aria-hidden="true"/);
}

/** The app shell's top bar: the navigation, New request, the member's menu and the folded menu of a narrow screen. */
function expectAppShell(path: string, html: string, admin: boolean): void {
  expect(html, path).toContain('<a class="brand" href="/">');
  expect(html, path).toMatch(/<nav class="nav" aria-label="Main">/);
  for (const href of ["/hall", "/inbox", "/requests", "/members"]) expect(html, `${path}: ${href}`).toContain(`href="${href}"`);
  expect(html.includes('href="/admin"'), path).toBe(admin);
  expect(html, path).toContain('<a class="button" href="/requests/new">New request</a>');
  expect(html, path).toMatch(/<details class="menu">\s*<summary>/);
  expect(html, path).toMatch(/<details class="menu menu-all">\s*<summary>Menu<\/summary>/);
  for (const href of ["/settings/email", "/tokens"]) expect(html, `${path}: ${href}`).toContain(`href="${href}"`);
  expect(html, path).toContain('<form method="post" action="/sign-out">');
}

/** The focused shell's top bar: the mark and the name, no link and no navigation. */
function expectFocusedShell(path: string, html: string): void {
  const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
  expect(header, path).toMatch(/<span class="brand">/);
  expect(header, path).not.toMatch(/<a\b|<nav\b|<details\b/);
  expect(html, path).toMatch(/<main id="content" class="focused(?: wide)?">/);
}

describe("the shell of the web role's pages", () => {
  it("is the app shell on every page a signed-in admin opens, with the waiting count beside the inbox, and the focused shell on review pages", { timeout: 120_000 }, async () => {
    for (const [route, path] of webRolePages()) {
      const { status, html } = await open(web, path, cookies.get("pia"));
      expect(status, path).toBeLessThan(500);
      expectShell(path, html);
      if (route === "confirm/[...command]/route.ts" || route === "consent/route.ts" || route === "device/route.ts") expectFocusedShell(path, html);
      else {
        expectAppShell(path, html, true);
        expect(html, path).toMatch(/<a href="\/inbox"( aria-current="page")?>Inbox <span class="badge"><span aria-hidden="true">1<\/span><span class="visually-hidden">1 waiting<\/span><\/span><\/a>/);
      }
    }
  });

  it("is the app shell for a member, with no link to the admin pages and no count when nothing waits", async () => {
    for (const path of ["/", "/inbox", "/requests", "/members", "/settings/email", "/tokens", "/requests/new"]) {
      const { status, html } = await open(web, path, cookies.get("alice"));
      expect(status, path).toBe(200);
      expectShell(path, html);
      expectAppShell(path, html, false);
      expect(html, path).toContain('<a href="/inbox"');
      expect(html, path).not.toContain('class="badge"');
    }
    const requests = await open(web, "/requests", cookies.get("alice"));
    expect(requests.html).toContain('<a href="/requests" aria-current="page">Requests</a>');
  });

  it("is the focused shell on the sign-in page, the setup screen and refusal pages", async () => {
    const signIn = await open(web, "/sign-in");
    expectShell("/sign-in", signIn.html);
    expectFocusedShell("/sign-in", signIn.html);
    const setup = await open(fresh.web, "/setup");
    expectShell("/setup", setup.html);
    expectFocusedShell("/setup", setup.html);
    // A member's call to an admin page, and a refused input, are refusal pages.
    for (const path of ["/admin/teams", "/requests?page=0"]) {
      const refusal = await open(web, path, cookies.get("alice"));
      expect(refusal.status, path).toBeGreaterThanOrEqual(400);
      expectShell(path, refusal.html);
      expectFocusedShell(path, refusal.html);
    }
  });

  it("shows the home page's banners, then its four cards", async () => {
    const { html } = await open(web, "/", cookies.get("pia"));
    const main = /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? "";
    expect(main).toMatch(/<ul class="cards">/);
    const cards = [...main.matchAll(/<li class="card">([\s\S]*?)<\/li>/g)].map(([, card]) => card ?? "");
    expect(cards).toHaveLength(4);
    expect(cards[0]).toContain("Waiting for you");
    expect(cards[0]).toContain("1 proposal waits for your confirmation.");
    expect(cards[0]).toContain('href="/inbox"');
    expect(cards[1]).toContain('href="/requests"');
    expect(cards[2]).toContain('href="/hall"');
    expect(cards[3]).toContain('href="/requests/new"');
  });
});

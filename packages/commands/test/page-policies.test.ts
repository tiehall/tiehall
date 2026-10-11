import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startSetup } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { NO_SUCH_PAGE, PAGES, SETUP, seedInventory, SIGNED_OUT_PAGES } from "./support/page-inventory.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The content security policy of each kind of page (web-ui: The content
// security policy of each kind of page; agent-safety: The review page of the
// confirmation step; design.md, Design: The content security policy of each
// kind of page; D57 (9)), in the web app as the image runs it. Every page
// loads its styles, fonts, images and manifest from the install alone and
// cannot be framed: the pages the web role renders run no script, their
// form-action extended only where a form leads on to GitHub or to an agent
// client; the API changelog page posts nowhere; the pages Next.js renders, the
// page for a path no route serves among them, run only the scripts that carry
// the nonce made for each answer; and the API reference page keeps the policy
// the public-api capability gives it. The table names the kind of every page
// route of the inventory (support/page-inventory.ts), so a new page gets a
// policy here once it is added.

/** The policy of a page the web role renders, other than the live hall, as design.md's table gives it. */
const WEB_PAGE = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** The same, whose forms may also lead to these sources. */
const formActionAlso = (...sources: string[]) => WEB_PAGE.replace("form-action 'self'", ["form-action 'self'", ...sources].join(" "));
/** The API changelog page's: the web role's, posting nowhere. */
const CHANGELOG = WEB_PAGE.replace("form-action 'self'", "form-action 'none'");
/** The pages Next.js renders: scripts only by the nonce of the answer, and 'strict-dynamic'. */
const FRAMEWORK =
  /^default-src 'none'; script-src 'nonce-([A-Za-z0-9+/]{22,}={0,2})' 'strict-dynamic'; style-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/;
/** The API reference page's, unchanged (public-api: The API reference page at `/docs/api`). */
const REFERENCE =
  /^default-src 'none'; script-src 'nonce-[A-Za-z0-9+/]+=*'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/;
/** GitHub's web origin, where the sign-in page's and the setup screen's forms lead on. */
const GITHUB = "https://github.com";

type Kind = "web" | "framework" | "changelog" | "reference";

/** The kind of every page route of the inventory. */
const KINDS: Readonly<Record<string, Kind>> = {
  "route.ts": "web",
  "inbox/route.ts": "web",
  "settings/email/route.ts": "web",
  "members/route.ts": "web",
  "requests/route.ts": "web",
  "requests/new/route.ts": "web",
  "[key]/page.tsx": "framework",
  "tokens/route.ts": "web",
  "admin/route.ts": "web",
  "admin/invites/route.ts": "web",
  "admin/teams/route.ts": "web",
  "admin/sign-in-policy/route.ts": "web",
  "admin/personal-access-tokens/route.ts": "web",
  "admin/github/route.ts": "web",
  "admin/apis/route.ts": "web",
  "admin/activity-log/route.ts": "web",
  "confirm/[...command]/route.ts": "web",
  "consent/route.ts": "web",
  "device/route.ts": "web",
  "docs/api/route.ts": "reference",
  "docs/api/changelog/route.ts": "changelog",
  "sign-in/route.ts": "web",
  [SETUP]: "web",
};

let stub: GitHubStub;
let install: TestInstall;
let web: WebApp;
let cookie: string;
let confirmPaths: string[];
/** An install whose setup is not complete, with its web app and the setup code its start printed. */
let fresh: { install: TestInstall; web: WebApp; code: string };

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  ({ confirmPaths } = await seedInventory(install, stub));
  web = await startWebApp(install);
  cookie = (await (await startSignIn(install, stub, { url: web.url })).signIn("pia")).jar.header();
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

/** A browser's GET of a page: its status, its policy and its markup. */
async function open(app: WebApp, path: string, session?: string): Promise<{ status: number; policy: string; html: string }> {
  const answer = await app.fetch(path, { headers: { accept: "text/html", ...(session === undefined ? {} : { cookie: session }) } });
  return { status: answer.status, policy: answer.headers.get("content-security-policy") ?? "", html: await answer.text() };
}

/**
 * A browser's call at the install's own URL, which the setup screen requires: its Host header names the URL's host,
 * which fetch cannot set, and a form names the URL as its Origin.
 */
function atInstallUrl(app: WebApp, method: "GET" | "POST", path: string, form?: Record<string, string>, session?: string): Promise<{ status: number; policy: string; html: string; cookie: string }> {
  const body = form === undefined ? undefined : new URLSearchParams(form).toString();
  const { port, host } = new URL(app.url);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host,
          accept: "text/html",
          ...(session === undefined ? {} : { cookie: session }),
          ...(body === undefined ? {} : { origin: app.url, "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) }),
        },
      },
      (answer) => {
        let html = "";
        answer.setEncoding("utf8");
        answer.on("data", (chunk: string) => (html += chunk));
        answer.on("end", () =>
          resolve({
            status: answer.statusCode ?? 0,
            policy: String(answer.headers["content-security-policy"] ?? ""),
            html,
            cookie: (answer.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "",
          }),
        );
      },
    );
    call.on("error", reject);
    call.end(body);
  });
}

/** Checks a page's policy against its kind's, and that a script-free page holds no script element. */
function expectPolicy(kind: Kind, path: string, { policy, html }: { policy: string; html: string }): void {
  if (kind === "web") {
    expect(policy, path).toBe(WEB_PAGE);
    expect(html, path).not.toMatch(/<script\b/i);
  } else if (kind === "changelog") {
    expect(policy, path).toBe(CHANGELOG);
    expect(html, path).not.toMatch(/<script\b/i);
  } else if (kind === "framework") expect(policy, path).toMatch(FRAMEWORK);
  else expect(policy, path).toMatch(REFERENCE);
}

describe("the policy of each kind of page", () => {
  it("names a kind for every page route of the inventory", () => {
    expect(Object.keys(KINDS).sort()).toEqual([...Object.keys(PAGES), ...Object.keys(SIGNED_OUT_PAGES), SETUP].sort());
  });

  it("is the kind's exact policy on every page a signed-in admin opens", { timeout: 120_000 }, async () => {
    for (const [route, paths] of Object.entries(PAGES)) {
      for (const path of route === "confirm/[...command]/route.ts" ? confirmPaths : paths) {
        const page = await open(web, path, cookie);
        // The consent screen without an agent client's authorization request is a refusal page.
        expect(page.status, path).toBe(path === "/consent" ? 400 : 200);
        expectPolicy(KINDS[route] ?? "web", path, page);
      }
    }
  });

  it("allows no script on a review page, a confirmation, the device approval page or a refusal page", async () => {
    for (const path of [...confirmPaths, "/device", "/consent", "/requests?page=0", "/confirm/no.such_command"]) {
      const page = await open(web, path, cookie);
      expect(page.policy, path).toBe(WEB_PAGE);
      expect(page.policy, path).not.toContain("script-src");
      expect(page.html, path).not.toMatch(/<script\b/i);
    }
    // The consent screen without an authorization request, and a page's refusal of input, are refusal pages.
    expect((await open(web, "/consent", cookie)).status).toBe(400);
    expect((await open(web, "/requests?page=0", cookie)).status).toBe(400);
  });

  it("extends the sign-in page's form-action with GitHub's web origin, and allows no script there", async () => {
    const page = await open(web, "/sign-in");
    expect(page.status).toBe(200);
    expect(page.policy).toBe(formActionAlso(GITHUB));
    expect(page.html).not.toMatch(/<script\b/i);
  });

  it("extends the setup screen's form-action with GitHub's web origin on the steps that lead there, and allows no script", async () => {
    const codePage = await atInstallUrl(fresh.web, "GET", "/setup");
    expect(codePage.html).toContain('name="code"');
    expect(codePage.policy).toBe(WEB_PAGE);
    const entered = await atInstallUrl(fresh.web, "POST", "/setup", { code: fresh.code });
    expect(entered.status).toBe(303);
    const session = entered.cookie;
    expect(session).toMatch(/^tiehall-setup=/);
    const named = await atInstallUrl(fresh.web, "POST", "/setup/company", { name: "Acme" }, session);
    expect(named.status).toBe(303);
    const appStep = await atInstallUrl(fresh.web, "GET", "/setup", undefined, session);
    expect(appStep.html).toContain("Create the GitHub App");
    expect(appStep.policy).toBe(formActionAlso(GITHUB));
    expect(appStep.html).not.toMatch(/<script\b/i);
  });

  it("runs only the scripts that carry a fresh nonce on the pages Next.js renders, the page for a path no route serves included", async () => {
    for (const [path, session, status] of [
      ["/FE-1", cookie, 200],
      ["/FE", cookie, 200],
      [NO_SUCH_PAGE, cookie, 404],
      [`${NO_SUCH_PAGE}/at-all`, undefined, 404],
    ] as const) {
      const first = await open(web, path, session);
      const second = await open(web, path, session);
      expect([first.status, second.status], path).toEqual([status, status]);
      const [nonce] = FRAMEWORK.exec(first.policy)?.slice(1) ?? [];
      const [again] = FRAMEWORK.exec(second.policy)?.slice(1) ?? [];
      expect(nonce, `${path}: ${first.policy}`).toBeDefined();
      expect(again, path).toBeDefined();
      expect(again, path).not.toBe(nonce);
      const scripts = [...first.html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag, path).toContain(`nonce="${nonce}"`);
      for (const policy of [first.policy, second.policy]) {
        expect(policy).not.toContain("'unsafe-inline'");
        expect(policy).not.toContain("data:");
      }
    }
  });
});

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startSetup } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { phoneWidthProblems, settled } from "./support/layout.ts";
import { addUser } from "./support/members.ts";
import { NO_SUCH_PAGE, PAGES, seedInventory, SIGNED_OUT_PAGES } from "./support/page-inventory.ts";
import { addTeam, callApi, joinTeams, openRequestInTheWebUi, tokenOf } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The screenshot tests (web-ui: Pages work at phone width; web-ui: Pages are
// accessible; web-ui: Light and dark themes follow the system; web-ui: The
// content security policy of each kind of page; design.md, Design: Testing;
// D57 (5), (7), (8), (9)). A browser opens every page of the web UI that the
// inventory names (support/page-inventory.ts), as a signed-in admin, a
// signed-in member and a browser with no session, the setup screen on a
// second install whose setup is not complete, and the live hall with seeded
// traffic between teams, at 1,280 by 800, 320 by 640 and 390 by 844 CSS
// pixels, in the light and the dark color scheme. On each it checks that the
// page is no wider than its viewport, apart from tables and code in their own
// boxes; that every visible text contrasts at least 4.5:1 with the background
// the browser computes behind it; that every control is at least 24 by 24
// CSS pixels, apart from a link inside a sentence or a block of text; that
// every element the Tab key reaches shows a focus outline at least 2 pixels
// wide; and that the browser reports no violation of the page's policy and
// requests nothing from another host. It then saves a screenshot under
// test-results/screens/, named by who, page, size and scheme, which CI keeps
// as an artifact. No test compares pixels with a stored image: each system
// draws the text in its own font (web-ui: Text in the system's fonts). The
// pages are seen with reduced motion, so no animation is caught halfway.

/** Where the screenshots go: test-results/screens/ at the repository's root, which git ignores and CI uploads. */
const SCREENS = fileURLToPath(new URL("../../../test-results/screens/", import.meta.url));
/** The viewports, in CSS pixels: a wide screen, the narrowest phone and a common one. */
const SIZES = [
  [1280, 800],
  [320, 640],
  [390, 844],
] as const;
const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];

let stub: GitHubStub;
let install: TestInstall;
let web: WebApp;
/** An install whose setup is not complete, with its web app. */
let fresh: { install: TestInstall; web: WebApp };
let browser: Browser;
let confirmPaths: string[];
const cookies = new Map<string, string>();

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  const seed = await seedInventory(install, stub);
  confirmPaths = seed.confirmPaths;
  await seedTraffic(seed.pia, seed.alice);
  web = await startWebApp(install);
  const signIn = await startSignIn(install, stub, { url: web.url });
  for (const login of ["pia", "alice"]) {
    const pair = (await signIn.signIn(login)).jar.header().split("; ").find((each) => each.startsWith("tiehall.session_token=")) ?? "";
    cookies.set(login, pair.slice("tiehall.session_token=".length));
  }
  const unset = await startTestInstall();
  // As at an install's first start: the org exists, unnamed, and setup is not complete.
  await unset.owner.query("UPDATE orgs SET name = NULL, setup_completed_at = NULL");
  const freshWeb = await startWebApp(unset);
  await startSetup({ database: unset.db, url: freshWeb.url, logger: unset.logger });
  fresh = { install: unset, web: freshWeb };
  mkdirSync(SCREENS, { recursive: true });
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await fresh?.web.close();
  await fresh?.install.close();
  await web?.close();
  await install?.close();
  await stub?.close();
}, 300_000);

/**
 * Traffic for the live hall beyond the inventory's FE-1: FE-2 from BE, on which Pia's agent works; QA-1 from FE, on
 * which Quinn's agent, of team QA, asks a blocking question; and Alice at work in the web UI. So the hall shows lines
 * between three teams, a request in progress, one that needs info, and people and agents at work.
 */
async function seedTraffic(pia: string, alice: string): Promise<void> {
  const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'QA'");
  const qa = rows[0]?.id ?? (await addTeam(install.owner, "QA"));
  const quinn = await addUser(install.owner, { login: "quinn", githubAccountId: stub.addUser({ login: "quinn" }).id });
  await joinTeams(install.owner, quinn, qa);
  await openRequestInTheWebUi(install, alice, {
    targetTeam: "FE",
    title: "Fix the dates of the export",
    packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "Dates in the export are a day off.", acceptance_criteria: ["Dates match the page."] } },
  });
  expect((await callApi(install, tokenOf(pia), "POST", "/api/v1/requests/FE-2/claim")).status).toBe(200);
  expect((await callApi(install, tokenOf(pia), "POST", "/api/v1/requests/FE-2/status", { state: "in_progress" })).status).toBe(200);
  await openRequestInTheWebUi(install, pia, { targetTeam: "QA", title: "Test the dark mode on phones" });
  expect((await callApi(install, tokenOf(quinn), "POST", "/api/v1/requests/QA-1/claim")).status).toBe(200);
  expect((await callApi(install, tokenOf(quinn), "POST", "/api/v1/requests/QA-1/messages", { kind: "question", body: "Which phones?", blocking: true })).status).toBe(200);
}

/** A page under watch: what it requested, and the policy messages its console showed. */
interface Seen {
  page: Page;
  /** The requests the page made, by URL. */
  requested: string[];
  /** The policy messages its console showed. */
  console: string[];
}

/** A page in a fresh context of this size and scheme, signed in to this app as this person or as nobody, which keeps what it requests and every policy violation it sees. */
async function open(app: WebApp, width: number, height: number, scheme: Scheme, login?: string): Promise<Seen> {
  const context: BrowserContext = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce" });
  const value = login === undefined ? undefined : cookies.get(login);
  if (value !== undefined) await context.addCookies([{ name: "tiehall.session_token", value, url: app.url }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const seen: Seen = { page, requested: [], console: [] };
  context.on("request", (request) => void seen.requested.push(request.url()));
  page.on("console", (message) => {
    if (/content security policy|content-security-policy|trusted type/i.test(message.text())) seen.console.push(message.text());
  });
  await page.addInitScript({
    content: `window.tiehallViolations = [];
document.addEventListener("securitypolicyviolation", (event) => window.tiehallViolations.push(location.pathname + ": " + event.violatedDirective + " " + event.blockedURI));`,
  });
  return seen;
}

/**
 * What the browser runs to find the visible text that contrasts less than 4.5:1 with what is behind it: each element
 * with text of its own, a field's value included, against the first opaque background below it, the translucent ones
 * above that laid over it, and the text's own alpha and the opacity of the element and its ancestors laid over that.
 * A text that is not shown, or shown in a box of a pixel or less as the skip link's is until it has the focus, and
 * a disabled control's are left out. Plain JavaScript, as a string.
 */
const CONTRAST_CHECK = `() => {
  const parse = (value) => {
    const match = /rgba?\\(([^)]+)\\)/.exec(value);
    if (match === null) return null;
    const [r, g, b, a = 1] = match[1].split(/[\\s,\\/]+/).filter((part) => part !== "").map(Number);
    return { r, g, b, a };
  };
  const over = (top, below) => {
    const a = top.a + below.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (key) => (top[key] * top.a + below[key] * below.a * (1 - top.a)) / a;
    return { r: mix("r"), g: mix("g"), b: mix("b"), a };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  };
  const hex = ({ r, g, b }) => "#" + [r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase();
  const background = (element) => {
    const layers = [];
    for (let node = element; node !== null; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color !== null && color.a > 0) layers.push(color);
      if (color !== null && color.a >= 1) break;
    }
    let behind = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) behind = over(layer, behind);
    return behind;
  };
  const opacity = (element) => {
    let value = 1;
    for (let node = element; node !== null; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
    return value;
  };
  const describe = (element) => element.tagName.toLowerCase() + (element.className && typeof element.className === "string" ? "." + element.className.trim().split(/\\s+/).join(".") : "") + ' "' + ((element.value || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40)) + '"';
  const problems = [];
  for (const element of document.querySelectorAll("body *")) {
    if (element.closest("[disabled], option, script, style, template, noscript") !== null) continue;
    const field = element.matches("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea") && (element.value || "") !== "";
    const text = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== "");
    if (!field && !text) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility !== "visible" || style.display === "none" || rect.width <= 1 || rect.height <= 1) continue;
    const ink = parse(style.color);
    if (ink === null) continue;
    const behind = background(element);
    const shown = over({ ...ink, a: ink.a * opacity(element) }, behind);
    const value = ratio(shown, behind);
    if (value < 4.5) problems.push(describe(element) + ": " + hex(shown) + " on " + hex(behind) + " is " + value.toFixed(2) + ":1");
  }
  return problems;
}`;

/** The element that has the focus: an id of its own, how it reads, and its outline; null once the focus has left the page. Plain JavaScript, as a string. */
const FOCUSED = `(() => {
  const element = document.activeElement;
  if (element === null || element === document.body || element === document.documentElement) return null;
  window.tiehallFocusIds = window.tiehallFocusIds || new WeakMap();
  if (!window.tiehallFocusIds.has(element)) {
    window.tiehallFocusNext = (window.tiehallFocusNext || 0) + 1;
    window.tiehallFocusIds.set(element, window.tiehallFocusNext);
  }
  const style = getComputedStyle(element);
  return {
    id: window.tiehallFocusIds.get(element),
    reads: element.tagName.toLowerCase() + ' "' + ((element.textContent || element.getAttribute("aria-label") || element.getAttribute("name") || "").trim().replace(/\\s+/g, " ").slice(0, 40)) + '"',
    style: style.outlineStyle,
    width: parseFloat(style.outlineWidth),
  };
})()`;

/**
 * Every element the Tab key reaches, from the top of the page, that shows no focus outline at least 2 pixels wide;
 * and that the key reaches none, which no page of the web UI allows, since each starts with its skip link.
 */
async function focusProblems(page: Page): Promise<string[]> {
  await page.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");
  const problems: string[] = [];
  const reached = new Set<number>();
  for (let index = 0; index < 500; index += 1) {
    await page.keyboard.press("Tab");
    const focused = (await page.evaluate(FOCUSED)) as { id: number; reads: string; style: string; width: number } | null;
    if (focused === null || reached.has(focused.id)) break;
    reached.add(focused.id);
    if (focused.style === "none" || focused.width < 2) problems.push(`${focused.reads} shows a focus outline ${focused.style} ${focused.width}px`);
  }
  return reached.size === 0 ? ["the Tab key reaches nothing", ...problems] : problems;
}

/** The requests made to a host other than the app's, by the URL they asked for. */
function toOtherHosts(app: WebApp, requested: readonly string[]): string[] {
  const host = new URL(app.url).host;
  return requested.filter((url) => !url.startsWith("data:") && new URL(url).host !== host);
}

/** A file name for a screenshot: who, the page, the size and the scheme. */
function screenName(who: string, name: string, width: number, height: number, scheme: Scheme): string {
  return `${who}--${name}--${width}x${height}--${scheme}.png`;
}

/** A name for a path, for its screenshot's file. */
function nameOf(path: string): string {
  if (path === "/") return "home";
  const confirm = confirmPaths.indexOf(path);
  if (confirm !== -1) return ["confirm-proposal", "confirm-change-role"][confirm] ?? `confirm-${confirm}`;
  return path.replace(/^\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "");
}

/**
 * Opens each path in turn on one page, checks it and saves its screenshot; gives every problem found, each led by
 * the path. A path whose answer leads to a page already checked, such as every page that sends a browser with no
 * session to the sign-in page, is checked once.
 */
async function checkPages(app: WebApp, who: string, paths: readonly string[], width: number, height: number, scheme: Scheme, login?: string): Promise<{ problems: string[]; shots: number }> {
  const seen = await open(app, width, height, scheme, login);
  const { page } = seen;
  const problems: string[] = [];
  const checked = new Set<string>();
  let shots = 0;
  for (const path of paths) {
    const answer = await page.goto(`${app.url}${path}`);
    expect(answer?.status() ?? 0, path).toBeLessThan(500);
    await settled(page);
    const landed = new URL(page.url());
    const key = `${landed.pathname}${landed.pathname === "/sign-in" ? "" : landed.search}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const note = (found: readonly string[]) => problems.push(...found.map((problem) => `${path}: ${problem}`));
    note(await phoneWidthProblems(page, { tablesScroll: true }));
    note((await page.evaluate(`(${CONTRAST_CHECK})()`)) as string[]);
    await page.screenshot({ path: join(SCREENS, screenName(who, nameOf(path), width, height, scheme)), fullPage: true });
    shots += 1;
    note(await focusProblems(page));
    note((await page.evaluate("window.tiehallViolations")) as string[]);
  }
  problems.push(...seen.console, ...toOtherHosts(app, seen.requested).map((url) => `a request to another host: ${url}`));
  await page.context().close();
  return { problems, shots };
}

/** Every path of the inventory a signed-in person opens, the page for a path no route serves included; not the API reference page, which is no page of the web UI. */
function signedInPaths(): string[] {
  return [...Object.entries(PAGES).flatMap(([route, each]) => (route === "confirm/[...command]/route.ts" ? confirmPaths : route === "docs/api/route.ts" ? [] : each)), NO_SUCH_PAGE];
}

const CASES = [
  ["a signed-in admin", "admin", "pia"],
  ["a signed-in member", "member", "alice"],
  ["a browser with no session", "nobody", undefined],
] as const;

describe("the checks", () => {
  // A page made to break each rule, outside the install and its policy, so a check that found nothing on the web UI's
  // pages would be seen to find nothing at all.
  it("find faint text, a small control, a page wider than its viewport and a focus with no outline", { timeout: 120_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
    const page = await context.newPage();
    await page.setContent(
      [
        '<body style="margin:0;background:#FFFFFF;color:#0B1B3A">',
        '<main><p style="color:#BBBBBB">Faint words</p><p>Ink on white</p>',
        '<button style="width:16px;height:16px;padding:0;outline:none">x</button>',
        '<div style="width:600px">A row too wide</div></main>',
        "</body>",
      ].join(""),
    );
    expect((await page.evaluate(`(${CONTRAST_CHECK})()`)) as string[]).toEqual([expect.stringMatching(/^p "Faint words": #BBBBBB on #FFFFFF is 1\.\d\d:1$/)]);
    const layout = await phoneWidthProblems(page, { tablesScroll: true });
    expect(layout).toEqual(expect.arrayContaining([expect.stringContaining("CSS pixels wide in a viewport of 320"), 'button "x" is 16 by 16 CSS pixels']));
    expect(await focusProblems(page)).toEqual([expect.stringMatching(/^button "x" shows a focus outline none \d+px$/)]);
    await context.close();
  });
});

describe("every page of the web UI", () => {
  for (const [width, height] of SIZES) {
    for (const scheme of SCHEMES) {
      it.concurrent.each(CASES)(
        `fits, contrasts, shows its focus, keeps its policy and loads from the install alone at ${width} by ${height} in the ${scheme} scheme, as %s opens it`,
        { timeout: 600_000 },
        async (_who, who, login) => {
          const paths = login === undefined ? [...Object.values(SIGNED_OUT_PAGES).flat(), ...signedInPaths()] : signedInPaths();
          const { problems, shots } = await checkPages(web, who, paths, width, height, scheme, login);
          expect(problems).toEqual([]);
          expect(shots).toBeGreaterThan(login === undefined ? 1 : 20);
        },
      );
    }
  }

  it.concurrent.each(SCHEMES)("include the setup screen before setup, in the %s scheme at each size", { timeout: 300_000 }, async (scheme) => {
    for (const [width, height] of SIZES) {
      const { problems, shots } = await checkPages(fresh.web, "setup", ["/setup"], width, height, scheme);
      expect(problems).toEqual([]);
      expect(shots).toBe(1);
    }
  });

  // The live hall and a request's page among them, in both schemes at every size (web-ui: The live hall; web-ui: The
  // request page shows who works on it and what happened).
  it("left a screenshot of the live hall and of a request's page, as an admin and a member see them, at every size in both schemes", () => {
    const missing = ["admin", "member"].flatMap((who) =>
      ["hall", "FE-1"].flatMap((name) => SIZES.flatMap(([width, height]) => SCHEMES.map((scheme) => screenName(who, name, width, height, scheme)))),
    );
    expect(missing.filter((file) => !existsSync(join(SCREENS, file)))).toEqual([]);
  });
});

import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { requestProviderChangeShipped } from "@tiehall/core";
import { appendEvent } from "../src/append-event.ts";
import { withOrg } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { runningAnimations } from "./support/layout.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, openRequestInTheWebUi, sessionOf, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The live hall in a browser, its script running (web-ui: The live hall;
// web-ui: The live hall's reads and its long-poll; web-ui: The live hall with
// many teams and on a phone; web-ui: Motion, and reduced motion; web-ui: What
// the live hall shows of the people and agents at work; agent-safety: The web
// UI renders no raw HTML and no remote images; requester-loop: No push paths
// other than the hooks; design.md, Design: The live hall; D57 (6), (11),
// (12), (13)), against the web app as the image runs it and an install whose
// people and agents act meanwhile. The script makes the page live, shows
// Pause motion and holds a wait, so an agent's blocking question reaches the
// feed and the team's count within 2 seconds; the map draws a node per team,
// a line per pair, at most 12 people and agents at work and at most 8 dots,
// each an SVG circle moved through its cx and cy; Pause motion stops every
// animation and starts them again, and reduced motion starts with it pressed;
// a hidden page holds no wait and catches up once shown; a restart shows
// Reconnecting and then Live; an ended session shows Signed out; 60 events
// while the page is held back make it read its state again; 20 teams keep
// apart, and above 20 the others share a node; a phone gets lists and no map;
// names and titles stay text; and a minute of updates breaks no policy and
// leaves no style attribute. Pages are hidden by telling them so, as a
// browser does when its tab goes to the back.

const EXAMPLE_AGENT = "https://client.example.com/tiehall.json";
const MARKUP_CLIENT = randomUUID();

let stub: GitHubStub;
let install: TestInstall;
let web: WebApp;
let signIn: SignInHarness;
let browser: Browser;
let cookie = "";
const person: Record<string, string> = {};
const team: Record<string, string> = {};
let helpers = 0;

function id(login: string): string {
  const found = person[login];
  if (found === undefined) throw new Error(`No person ${login}.`);
  return found;
}

async function requestIdOf(key: string): Promise<string> {
  const [teamKey, number] = key.split("-");
  const { rows } = await install.owner.query<{ id: string }>("SELECT requests.id FROM requests JOIN teams ON teams.id = requests.target_team_id WHERE teams.key = $1 AND requests.number = $2", [
    teamKey,
    Number(number),
  ]);
  return rows[0]?.id ?? "";
}

/** Events about the request that change nothing else, as a system action, committed together, so one answer brings them. */
async function shipped(key: string, times = 1): Promise<void> {
  const requestId = await requestIdOf(key);
  await withOrg(install.db, async (context) => {
    for (let index = 0; index < times; index += 1) await appendEvent(context, requestProviderChangeShipped, { requestId }, { actorKind: "system", surface: "github" });
  });
}

/** A comment a person posts in the web UI. */
async function webComment(login: string, key: string): Promise<void> {
  const session = sessionOf(id(login));
  expect(await install.web(session).write("messages.post", { key, kind: "comment", body: "On it." }, install.fromThePage(session))).toMatchObject({ ok: true });
}

/** A new member of FE, who comments on a request in the web UI, as one more person at work. */
async function newHelper(key: string): Promise<void> {
  const login = `helper-${helpers}`;
  helpers += 1;
  person[login] = await addUser(install.owner, { login });
  await joinTeams(install.owner, id(login), team["FE"] ?? "");
  await webComment(login, key);
}

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  for (const [key, name] of [
    ["BE", "Backend"],
    ["FE", "Frontend"],
    ["MOB", "Mobile"],
    ["PAY", "Payments"],
  ] as const) {
    team[key] = await addTeam(install.owner, key);
    await install.owner.query("UPDATE teams SET name = $2 WHERE id = $1", [team[key], name]);
  }
  for (const [login, teamKey, role] of [
    ["pia", "FE", "admin"],
    ["mert", "FE", "member"],
    ["selin", "BE", "member"],
    ["ayse", "PAY", "member"],
    ["deniz", "MOB", "member"],
  ] as const) {
    person[login] = await addUser(install.owner, { login, role, githubAccountId: stub.addUser({ login }).id });
    await joinTeams(install.owner, id(login), team[teamKey] ?? "");
  }
  await install.owner.query(
    "INSERT INTO oauth_clients (org_id, client_id, name, client_discovery_id, redirect_uris) SELECT id, $1, 'Example Agent', 'cimd', ARRAY['https://client.example.com/callback'] FROM orgs",
    [EXAMPLE_AGENT],
  );
  await install.owner.query("INSERT INTO oauth_clients (org_id, client_id, name, redirect_uris) SELECT id, $1, '<img src=x onerror=alert(1)>', ARRAY['http://127.0.0.1/callback'] FROM orgs", [MARKUP_CLIENT]);
  // FE-1, from BE, on which Mert's agent works; PAY-1, from FE, which Ayşe's agent claimed; MOB-1, from PAY, open.
  await openRequest(install, tokenOf(id("selin")), { targetTeam: "FE", title: "Add a forgot password link" });
  const mertsAgent = oauthTokenOf(id("mert"), EXAMPLE_AGENT, "mcp");
  expect((await callApi(install, mertsAgent, "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
  expect((await callApi(install, mertsAgent, "POST", "/api/v1/requests/FE-1/status", { state: "in_progress" })).status).toBe(200);
  await openRequestInTheWebUi(install, id("mert"), { targetTeam: "PAY", title: "Send a refund webhook" });
  expect((await callApi(install, oauthTokenOf(id("ayse"), EXAMPLE_AGENT, "mcp"), "POST", "/api/v1/requests/PAY-1/claim")).status).toBe(200);
  await openRequestInTheWebUi(install, id("ayse"), { targetTeam: "MOB", title: "Show refunds in the app" });
  web = await startWebApp(install);
  signIn = await startSignIn(install, stub, { url: web.url });
  cookie = await sessionCookie("pia");
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await web?.close();
  await stub?.close();
  await install?.close();
}, 300_000);

/** The value of a fresh session cookie of this person's, signed in with GitHub. */
async function sessionCookie(login: string, harness: SignInHarness = signIn): Promise<string> {
  const pair = (await harness.signIn(login)).jar.header().split("; ").find((each) => each.startsWith("tiehall.session_token=")) ?? "";
  return pair.slice("tiehall.session_token=".length);
}

interface Hall {
  context: BrowserContext;
  page: Page;
  /** The policy violations the page reported, and the policy messages its console showed. */
  violations: string[];
  /** What the page asked of the hall's reads: the waits in flight and started, the state reads, and the media types answered. */
  reads: { open: number; waits: number; states: number; types: string[] };
  /** The dialogs the page opened, such as an alert a script would run. */
  dialogs: string[];
}

/** Opens the live hall in a fresh browser, signed in, and waits until its script says it is live. */
async function openHall(
  options: { width?: number; height?: number; reducedMotion?: "reduce" | "no-preference"; session?: string; app?: WebApp; path?: string; live?: boolean } = {},
): Promise<Hall> {
  const app = options.app ?? web;
  const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: options.height ?? 800 }, reducedMotion: options.reducedMotion ?? "no-preference" });
  await context.addCookies([{ name: "tiehall.session_token", value: options.session ?? cookie, url: app.url }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const hall: Hall = { context, page, violations: [], reads: { open: 0, waits: 0, states: 0, types: [] }, dialogs: [] };
  await page.addInitScript({
    content: `window.tiehallViolations = [];
document.addEventListener("securitypolicyviolation", (event) => window.tiehallViolations.push(event.violatedDirective + " " + event.blockedURI));`,
  });
  page.on("console", (message) => {
    if (/content security policy|content-security-policy|trusted type/i.test(message.text())) hall.violations.push(message.text());
  });
  page.on("dialog", (dialog) => {
    hall.dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  // A wait is in flight from its request until its answer comes or it fails.
  const inFlight = new Set<unknown>();
  page.on("request", (request) => {
    if (request.url().includes("/hall/wait")) {
      inFlight.add(request);
      hall.reads.waits += 1;
      hall.reads.open = inFlight.size;
    }
    if (request.url().includes("/hall/state")) hall.reads.states += 1;
  });
  const settled = (request: unknown) => {
    inFlight.delete(request);
    hall.reads.open = inFlight.size;
  };
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  page.on("response", (response) => settled(response.request()));
  page.on("response", (response) => {
    if (/\/hall\/(state|wait)/.test(response.url())) hall.reads.types.push(response.headers()["content-type"] ?? "");
  });
  await page.goto(`${app.url}${options.path ?? "/hall"}`);
  if (options.live !== false) await page.locator("#live-words", { hasText: /^Live$/ }).waitFor();
  return hall;
}

/** Waits until the page holds a wait. */
async function holding(hall: Hall): Promise<void> {
  await expect.poll(() => hall.reads.open, { timeout: 10_000 }).toBe(1);
}

/**
 * Tells the page it is hidden, or shown again, as a browser does when its tab goes to the back or comes to the front.
 * The browser runs it as plain JavaScript, as a string, since this package's types hold no browser's.
 */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(`(() => {
    const hidden = ${JSON.stringify(hidden)};
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
}

/** Starts counting, in the page, the most dots the map shows at once and how often a dot's cx or cy is set. */
const WATCH_DOTS = `(() => {
  const seen = { most: 0, moves: 0 };
  window.tiehallDots = seen;
  new MutationObserver((records) => {
    seen.most = Math.max(seen.most, document.querySelectorAll("#hall-map circle.dot").length);
    seen.moves += records.filter((record) => record.type === "attributes").length;
  }).observe(document.getElementById("hall-map"), { subtree: true, childList: true, attributes: true, attributeFilter: ["cx", "cy"] });
})()`;

/** The text of the feed's newest row. */
function newestRow(page: Page) {
  return page.locator("#feed .feed-row").first();
}

describe("the live hall's script", () => {
  it("puts the class live on the body, shows Pause motion, not pressed, and says Live", { timeout: 120_000 }, async () => {
    const { context, page } = await openHall();
    await expect(page.locator("body").getAttribute("class")).resolves.toMatch(/\bhall\b.*\blive\b/);
    const pause = page.getByRole("button", { name: "Pause motion" });
    await expect(pause.isVisible()).resolves.toBe(true);
    await expect(pause.getAttribute("aria-pressed")).resolves.toBe("false");
    await expect(page.locator("#live-state").getAttribute("class")).resolves.toBe("live-state live");
    await context.close();
  });

  it("brings an agent's blocking question to the feed and the team's count within 2 seconds", { timeout: 120_000 }, async () => {
    const hall = await openHall();
    const { context, page } = hall;
    await holding(hall);
    expect((await callApi(install, oauthTokenOf(id("ayse"), EXAMPLE_AGENT, "mcp"), "POST", "/api/v1/requests/PAY-1/messages", { kind: "question", body: "Which currency?", blocking: true })).status).toBe(200);
    const committed = Date.now();
    await page.locator("#feed .feed-row", { hasText: "A blocking question was posted" }).first().waitFor();
    await page.locator("#team-list .team-row", { hasText: "Payments" }).filter({ hasText: "1 needs info" }).waitFor();
    // The time bound is what this test measures: within 2 seconds of the commit.
    expect(Date.now() - committed).toBeLessThan(2_000);
    await expect(newestRow(page).textContent()).resolves.toContain("PAY-1");
    await expect(page.locator("#feed").textContent()).resolves.not.toContain("Which currency?");
    await context.close();
  });

  it("draws the map: a node per team, a line per pair of teams, at most 12 people and agents at work, and at most 8 dots, each an SVG circle moved through cx and cy", { timeout: 120_000 }, async () => {
    for (let index = 0; index < 13; index += 1) await newHelper("FE-1");
    const hall = await openHall();
    const { context, page } = hall;
    const map = page.locator("#hall-map");
    await expect(map.isVisible()).resolves.toBe(true);
    await expect(map.getAttribute("aria-hidden")).resolves.toBe("true");
    await expect(map.locator(".node").count()).resolves.toBe(4);
    await expect(map.locator(".node", { hasText: "Payments" }).textContent()).resolves.toContain("PAY");
    await expect(map.locator("path.cord").count()).resolves.toBe(3);
    await expect(map.locator("path.cord.flow").count()).resolves.toBe(1);
    // Twelve at most, each where it covers no node and no other chip.
    const chips = await map.locator(".map-chip").count();
    expect(chips).toBeGreaterThan(0);
    expect(chips).toBeLessThanOrEqual(12);
    await expect(page.locator("#at-work .worker").count()).resolves.toBeGreaterThan(12);
    await expect(map.locator(".legend").textContent()).resolves.toContain("needs info");
    // The legend's lamps name colors and never blink.
    await expect(map.locator(".legend .lamp.needs-info").evaluate((lamp) => lamp.getAnimations().length)).resolves.toBe(0);
    await holding(hall);
    await page.evaluate(WATCH_DOTS);
    // Twelve events on FE-1's line at once.
    await shipped("FE-1", 12);
    await expect.poll(() => page.evaluate("window.tiehallDots.most"), { timeout: 10_000 }).toBe(8);
    await expect.poll(() => page.evaluate("window.tiehallDots.moves"), { timeout: 10_000 }).toBeGreaterThan(16);
    await expect.poll(() => map.locator("circle.dot").count(), { timeout: 10_000 }).toBe(0);
    await expect(page.locator("animateMotion").count()).resolves.toBe(0);
    await context.close();
  });

  it("stops every animation and the dots with Pause motion, and starts them again", { timeout: 120_000 }, async () => {
    const hall = await openHall();
    const { context, page } = hall;
    expect((await runningAnimations(page)).length).toBeGreaterThan(0);
    const pause = page.getByRole("button", { name: "Pause motion" });
    await pause.click();
    await expect(pause.getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.locator("body").getAttribute("class")).resolves.toMatch(/\bpaused\b/);
    // The button's own hover transition ends within 150 milliseconds; every animation is paused at once.
    await expect.poll(() => runningAnimations(page)).toEqual([]);
    await holding(hall);
    await shipped("FE-1", 3);
    await newestRow(page).filter({ hasText: "provider change" }).waitFor();
    await expect(page.locator("#hall-map circle.dot").count()).resolves.toBe(0);
    expect(await runningAnimations(page)).toEqual([]);
    await pause.click();
    await expect(pause.getAttribute("aria-pressed")).resolves.toBe("false");
    await expect.poll(async () => (await runningAnimations(page)).length).toBeGreaterThan(0);
    await context.close();
  });

  it("starts with motion paused under reduced motion, runs no animation, and still shows what changes", { timeout: 120_000 }, async () => {
    const hall = await openHall({ reducedMotion: "reduce" });
    const { context, page } = hall;
    await expect(page.getByRole("button", { name: "Pause motion" }).getAttribute("aria-pressed")).resolves.toBe("true");
    await holding(hall);
    expect((await callApi(install, oauthTokenOf(id("ayse"), EXAMPLE_AGENT, "mcp"), "POST", "/api/v1/requests/PAY-1/messages", { kind: "comment", body: "Still checking." })).status).toBe(200);
    await page.locator("#feed .feed-row", { hasText: "A comment was posted" }).first().waitFor();
    await expect(page.locator("#hall-map circle.dot").count()).resolves.toBe(0);
    expect(await runningAnimations(page)).toEqual([]);
    await context.close();
  });

  it("holds no wait while the page is hidden, and catches up once it is shown", { timeout: 120_000 }, async () => {
    const hall = await openHall();
    const { context, page } = hall;
    await holding(hall);
    await setHidden(page, true);
    await expect.poll(() => hall.reads.open).toBe(0);
    const started = hall.reads.waits;
    await webComment("selin", "FE-1");
    // That nothing starts while the page is hidden is what this measures.
    await page.waitForTimeout(2_000);
    expect(hall.reads.waits).toBe(started);
    await expect(newestRow(page).textContent()).resolves.not.toContain("selin in the web UI");
    await setHidden(page, false);
    await newestRow(page).filter({ hasText: "selin in the web UI" }).waitFor();
    await context.close();
  });

  it("reads its state again after 60 events while it was held back", { timeout: 120_000 }, async () => {
    const hall = await openHall();
    const { context, page } = hall;
    await holding(hall);
    await setHidden(page, true);
    await expect.poll(() => hall.reads.open).toBe(0);
    const reads = hall.reads.states;
    await shipped("MOB-1", 59);
    await webComment("deniz", "MOB-1");
    await setHidden(page, false);
    await newestRow(page).filter({ hasText: "deniz in the web UI" }).waitFor();
    expect(hall.reads.states).toBe(reads + 1);
    await expect(page.locator("#live-words").textContent()).resolves.toBe("Live");
    await context.close();
  });

  it("names a client and a title that hold markup as their characters, and runs nothing", { timeout: 120_000 }, async () => {
    const hall = await openHall();
    const { context, page } = hall;
    await holding(hall);
    expect((await callApi(install, oauthTokenOf(id("mert"), MARKUP_CLIENT, "mcp"), "POST", "/api/v1/requests/PAY-1/messages", { kind: "comment", body: "Hello." })).status).toBe(200);
    await page.locator("#at-work .worker-who", { hasText: "mert's agent · <img src=x onerror=alert(1)> (unverified)" }).waitFor();
    await openRequest(install, tokenOf(id("selin")), { targetTeam: "FE", title: "<script>alert(2)</script>" });
    await page.locator("#feed .feed-title", { hasText: "<script>alert(2)</script>" }).first().waitFor();
    await page.locator("#hall-map .map-chip", { hasText: "<img src=x onerror=alert(1)> (unverified)" }).waitFor();
    // The client's name, its own claim, is isolated in a bdi, apart from the mark Tiehall gives it, so no character of it can reorder the mark.
    const named = page.locator("#at-work .worker-who", { hasText: "mert's agent · <img src=x onerror=alert(1)> (unverified)" }).first();
    await expect(named.locator("bdi.client-name").textContent()).resolves.toBe("<img src=x onerror=alert(1)>");
    await expect(named.locator("bdi.client-name + .client-mark").textContent()).resolves.toBe("(unverified)");
    const chip = page.locator("#hall-map .map-chip", { hasText: "<img src=x onerror=alert(1)> (unverified)" }).first();
    await expect(chip.locator("bdi.client-name").textContent()).resolves.toBe("<img src=x onerror=alert(1)>");
    await expect(chip.locator("bdi.client-name + .client-mark").textContent()).resolves.toBe("(unverified)");
    await expect(page.locator("#feed bdi.feed-title", { hasText: "<script>alert(2)</script>" }).count()).resolves.toBeGreaterThan(0);
    await expect(page.locator("#team-list bdi.team-name").count()).resolves.toBeGreaterThan(0);
    await expect(page.locator("main img, main script").count()).resolves.toBe(0);
    expect(hall.dialogs).toEqual([]);
    expect(await page.evaluate("window.tiehallViolations")).toEqual([]);
    await context.close();
  });

  it("says Signed out, with a link to sign in again, once its session ends", { timeout: 120_000 }, async () => {
    const own = await sessionCookie("pia");
    const hall = await openHall({ session: own });
    const { context, page } = hall;
    await holding(hall);
    const token = decodeURIComponent(own).split(".")[0];
    expect((await install.owner.query("DELETE FROM web_sessions WHERE token = $1", [token])).rowCount).toBe(1);
    await webComment("selin", "FE-1");
    await page.locator("#live-words", { hasText: "Signed out" }).waitFor();
    await expect(page.locator("#live-state a").getAttribute("href")).resolves.toBe("/sign-in?return=%2Fhall");
    await expect.poll(() => hall.reads.open).toBe(0);
    await context.close();
  });
});

describe("the live hall on a phone", () => {
  it("shows no map at 390 by 844, and its lists update", { timeout: 120_000 }, async () => {
    const hall = await openHall({ width: 390, height: 844 });
    const { context, page } = hall;
    await expect(page.locator("#hall-map").isVisible()).resolves.toBe(false);
    await expect(page.locator("#hall-map svg").count()).resolves.toBe(0);
    await holding(hall);
    await webComment("ayse", "MOB-1");
    const committed = Date.now();
    await newestRow(page).filter({ hasText: "ayse in the web UI" }).waitFor();
    expect(Date.now() - committed).toBeLessThan(2_000);
    await expect(page.locator("#at-work .worker-who", { hasText: "ayse in the web UI" }).count()).resolves.toBe(1);
    await expect(page.locator("#team-list .team-row").count()).resolves.toBe(4);
    await context.close();
  });
});

describe("a minute of updates", () => {
  it("breaks no policy, Trusted Types included, reads by pull alone, and leaves no style attribute in the page", { timeout: 240_000 }, async () => {
    const hall = await openHall();
    const { context, page } = hall;
    const sockets: string[] = [];
    page.on("websocket", (socket) => void sockets.push(socket.url()));
    await holding(hall);
    const until = Date.now() + 60_000;
    for (let index = 0; Date.now() < until; index += 1) {
      if (index % 3 === 0) await webComment("selin", "FE-1");
      else if (index % 3 === 1) await shipped("PAY-1");
      else await newHelper("FE-1");
      // The minute of updates is what this test measures.
      await page.waitForTimeout(2_000);
    }
    await page.waitForTimeout(1_500);
    expect(await page.evaluate("window.tiehallViolations")).toEqual([]);
    expect(hall.violations).toEqual([]);
    await expect(page.locator("[style]").count()).resolves.toBe(0);
    expect(hall.reads.types.length).toBeGreaterThan(10);
    expect(hall.reads.types.every((type) => type === "application/json")).toBe(true);
    expect(sockets).toEqual([]);
    await expect(page.locator("#live-words").textContent()).resolves.toBe("Live");
    await context.close();
  });
});

// The restart runs last of the hall's own install: its web app stops and starts again on the same port.
describe("a restart of the install", () => {
  it("shows Reconnecting, and then Live once the install answers again", { timeout: 120_000 }, async () => {
    const hall = await openHall();
    const { context, page } = hall;
    await holding(hall);
    const restarted = web.restart();
    await page.locator("#live-words", { hasText: "Reconnecting" }).waitFor();
    await expect(page.locator("#live-state").getAttribute("class")).resolves.toBe("live-state reconnecting");
    await restarted;
    await page.locator("#live-words", { hasText: /^Live$/ }).waitFor({ timeout: 45_000 });
    await holding(hall);
    await webComment("selin", "FE-1");
    await newestRow(page).filter({ hasText: "selin in the web UI" }).waitFor();
    await context.close();
  });
});

// Many teams: an install of its own with 20 teams, and then 25.
describe("the live hall with many teams", () => {
  let many: TestInstall;
  let manyWeb: WebApp;
  let manyCookie = "";

  beforeAll(async () => {
    many = await startTestInstall();
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) ids.push(await addTeam(many.owner, `T${String(index).padStart(2, "0")}`));
    const ola = await addUser(many.owner, { login: "ola", role: "admin", githubAccountId: stub.addUser({ login: "ola" }).id });
    await joinTeams(many.owner, ola, ...ids);
    // A request from each team to the next, so every team has one addressed to it and every node a line.
    for (let index = 0; index < 20; index += 1) {
      await openRequestInTheWebUi(many, ola, { targetTeam: `T${String((index + 1) % 20).padStart(2, "0")}`, requestingTeam: `T${String(index).padStart(2, "0")}`, title: `Request ${index}` });
    }
    manyWeb = await startWebApp(many);
    manyCookie = await sessionCookie("ola", await startSignIn(many, stub, { url: manyWeb.url }));
  }, 300_000);

  afterAll(async () => {
    await manyWeb?.close();
    await many?.close();
  }, 300_000);

  /** The rectangles of the map's team nodes, as the browser lays them out. */
  async function nodeRects(page: Page): Promise<{ x: number; y: number; width: number; height: number }[]> {
    return page.locator("#hall-map .node").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map(({ x, y, width, height }) => ({ x, y, width, height })));
  }

  it("gives each of 20 teams its own node with its key, its lamps and their counts, no two overlapping at 1,280 by 800", { timeout: 120_000 }, async () => {
    const { context, page } = await openHall({ app: manyWeb, session: manyCookie });
    const rects = await nodeRects(page);
    expect(rects).toHaveLength(20);
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i] as (typeof rects)[number];
        const b = rects[j] as (typeof rects)[number];
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `nodes ${i} and ${j}`).toBe(true);
      }
    }
    const box = await page.locator("#hall-map svg").evaluate((svg) => svg.getBoundingClientRect());
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(box.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(rect.y).toBeGreaterThanOrEqual(box.y);
      expect(rect.y + rect.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
    }
    await expect(page.locator("#hall-map .node", { hasText: "T07" }).textContent()).resolves.toMatch(/T07\s*1/);
    await expect(page.locator("#hall-map .node .lamp").count()).resolves.toBe(20);
    await context.close();
  });

  it("shows the 19 teams with the most live requests and one node for the other 6 of 25, and lists all 25", { timeout: 120_000 }, async () => {
    for (let index = 20; index < 25; index += 1) await addTeam(many.owner, `T${String(index).padStart(2, "0")}`);
    const { context, page } = await openHall({ app: manyWeb, session: manyCookie });
    await expect(page.locator("#hall-map .node").count()).resolves.toBe(20);
    await expect(page.locator("#hall-map .node.others").textContent()).resolves.toContain("+6 teams");
    await expect(page.locator("#team-list .team-row").count()).resolves.toBe(25);
    await context.close();
  });
});

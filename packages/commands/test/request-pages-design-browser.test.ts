import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { phoneHeightProblems, phoneWidthProblems, runningAnimations, wrappedCells } from "./support/layout.ts";
import { seedRequestPages, type RequestPagesSeed } from "./support/request-pages.ts";
import { openRequest, tokenOf } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The request pages in a browser (web-ui: Pages work at phone width; web-ui:
// Pages are accessible; web-ui: Motion, and reduced motion; web-ui: A
// request's state looks the same everywhere; design.md, Design: Phone width;
// design.md, Design: Accessibility; design.md, Design: Motion and reduced
// motion; D57 (6), (7), (8)): at 320 CSS pixels a request's page, the request
// lists, the form that opens a request and a team's intake page scroll no
// page sideways, the lists show each request as a card, and every control is
// at least 24 by 24 CSS pixels, apart from links inside a sentence or a block
// of text; the keyboard reaches the form's every field and button in the
// order the page reads, each with a focus ring at least 2 CSS pixels wide; a
// lamp of the timeline takes its state's lamp color; a refused field's edge
// takes the danger ink; and no animation still runs 5.5 seconds after the page
// of a request loads whose agent is at work.

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let browser: Browser;
let session = "";
let seed: RequestPagesSeed;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  seed = await seedRequestPages(install, stub);
  web = await startWebApp(install);
  const pair = (await (await startSignIn(install, stub, { url: web.url })).signIn("pia")).jar.header().split("; ").find((each) => each.startsWith("tiehall.session_token=")) ?? "";
  session = pair.slice("tiehall.session_token=".length);
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await web?.close();
  await stub?.close();
  await install?.close();
}, 300_000);

/** Pia's browser, signed in, with this viewport and color scheme. */
async function signedIn(width: number, colorScheme: "light" | "dark" = "light"): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width, height: 640 }, colorScheme });
  await context.addCookies([{ name: "tiehall.session_token", value: session, url: web.url }]);
  return context;
}

describe("the request pages at 320 CSS pixels", () => {
  it.each(["/FE-1", "/FE-2", "/requests?list=all", "/requests/new", "/requests/new?team=FE", "/FE"])(
    "%s scrolls no page sideways, every control is at least 24 by 24 CSS pixels, and every button, field and navigation item at least 44 high",
    { timeout: 120_000 },
    async (path) => {
      const context = await signedIn(320);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(`${web.url}${path}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      expect(await phoneWidthProblems(page)).toEqual([]);
      expect(await phoneHeightProblems(page), path).toEqual([]);
      await context.close();
    },
  );

  it("shows each request of the lists as a card", { timeout: 120_000 }, async () => {
    const context = await signedIn(320);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/requests?list=all`);
    const rows = page.locator("table.requests tbody tr");
    await expect(rows.count()).resolves.toBe(2);
    const shapes = await rows.evaluateAll((all) => all.map((row) => ({ display: row.ownerDocument.defaultView?.getComputedStyle(row).display, width: row.getBoundingClientRect().width })));
    for (const { display, width } of shapes) {
      expect(display).toBe("grid");
      expect(width).toBeLessThanOrEqual(320 - 2 * 16);
    }
    await expect(page.locator("table.requests thead").evaluate((head) => head.getBoundingClientRect().height)).resolves.toBeLessThanOrEqual(1);
    await context.close();
  });
});

describe("the request lists at 1,280 CSS pixels", () => {
  it("keep each row's key, teams, claimant and time on one line, so no column shrinks until its words break", { timeout: 120_000 }, async () => {
    // A title long enough to want the whole width, which the other columns must not give up their words to.
    const where = "FROM teams WHERE teams.id = requests.target_team_id AND teams.key = 'FE' AND requests.number = 2";
    const { rows } = await install.owner.query<{ title: string }>(`SELECT requests.title FROM requests JOIN teams ON teams.id = requests.target_team_id WHERE teams.key = 'FE' AND requests.number = 2`);
    await install.owner.query(`UPDATE requests SET title = $1 ${where}`, [Array.from({ length: 9 }, () => "a title that runs on").join(" ")]);
    try {
      const context = await signedIn(1280);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(`${web.url}/requests?list=all`);
      await expect(page.locator("table.requests tbody tr").count()).resolves.toBe(2);
      expect(await wrappedCells(page, "table.requests tbody td:not(.cell-title):not(.cell-state)")).toEqual([]);
      await context.close();
    } finally {
      await install.owner.query(`UPDATE requests SET title = $1 ${where}`, [rows[0]?.title ?? ""]);
    }
  });
});

describe("the form that opens a request on a wide screen", () => {
  it("sits in a column in the middle of the page, as the design draws it", { timeout: 120_000 }, async () => {
    const context = await signedIn(1280);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/requests/new?team=FE`);
    const sides = await page.locator("main .narrow").first().evaluate((column) => {
      const box = column.getBoundingClientRect();
      const main = column.closest("main")?.getBoundingClientRect();
      return { left: Math.round(box.left - (main?.left ?? 0)), right: Math.round((main?.right ?? 0) - box.right) };
    });
    expect(sides.left).toBeGreaterThan(100);
    expect(Math.abs(sides.left - sides.right)).toBeLessThanOrEqual(2);
    await context.close();
  });
});

describe("the form that opens a request, with the keyboard", () => {
  it("takes the focus to every field and button in the order the page reads, each with a focus ring at least 2 CSS pixels wide", { timeout: 120_000 }, async () => {
    const context = await signedIn(320);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/requests/new?team=FE`);
    // The form's controls in the order the page reads them.
    const order = await page
      .locator("main form select, main form input:not([type=hidden]), main form textarea, main form button, main form a")
      .evaluateAll((all) => all.map((element) => element.id || (element.textContent ?? "").trim()));
    expect(order).toEqual(["requestingTeam", "targetTeam", "title", "need", "acceptanceCriteria", "codeRefs", "links", "dueDate", "Open the request", "Cancel"]);
    const reached: string[] = [];
    for (let press = 0; press < 30 && reached.length < order.length; press += 1) {
      await page.keyboard.press("Tab");
      const focused = (await page.evaluate(`(() => {
        const element = document.activeElement;
        if (element === null || element.closest("main form") === null) return undefined;
        const style = getComputedStyle(element);
        return { name: element.id || (element.textContent || "").trim(), outline: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
      })()`)) as { name: string; outline: string; width: number } | undefined;
      // A date field takes the focus once for each of its parts, day, month and year.
      if (focused === undefined || reached.at(-1) === focused.name) continue;
      reached.push(focused.name);
      expect(focused.outline, focused.name).not.toBe("none");
      expect(focused.width, focused.name).toBeGreaterThanOrEqual(2);
    }
    expect(reached).toEqual(order);
    await context.close();
  });
});

describe("a refused field of the form that opens a request", () => {
  it("takes the danger ink as its edge, an input, a select and a text area alike, in the light and the dark theme", { timeout: 120_000 }, async () => {
    for (const [colorScheme, ink] of [
      ["light", "rgb(155, 30, 34)"],
      ["dark", "rgb(251, 183, 177)"],
    ] as const) {
      const context = await signedIn(1280, colorScheme);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(`${web.url}/requests/new?team=FE`);
      // The server marks each field it refuses aria-invalid (the page tests show it); here the browser draws such fields,
      // once the edge's transition has run.
      await page.evaluate(`(() => { for (const id of ["title", "targetTeam", "need"]) document.getElementById(id)?.setAttribute("aria-invalid", "true"); })()`);
      const edges = (await page.evaluate(`(() => {
        for (const animation of document.getAnimations()) animation.finish();
        return ["title", "targetTeam", "need"].map((id) => getComputedStyle(document.getElementById(id)).borderTopColor);
      })()`)) as string[];
      expect(edges, colorScheme).toEqual([ink, ink, ink]);
      await context.close();
    }
  });
});

describe("a request's page in a browser", () => {
  it("draws the timeline's lamp of the move to needs_info in the light theme's needs-info lamp color", { timeout: 120_000 }, async () => {
    const context = await signedIn(1280);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/FE-1`);
    const lamp = page.locator(".timeline li", { hasText: "It moved from claimed to needs info" }).locator(".lamp");
    await expect(lamp.evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).backgroundColor)).resolves.toBe("rgb(169, 128, 0)");
    await context.close();
  });

  it.each([1280, 390])("keeps the banner of an agent at work a padded box apart from the panels below it, at %i CSS pixels", { timeout: 120_000 }, async (width) => {
    const context = await signedIn(width);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/FE-1`);
    const banner = page.locator(".activity.at-work");
    await banner.waitFor();
    // The live hall's list of the people and agents at work has rules of its own, which must not reach this banner.
    await expect(
      banner.evaluate((element) => {
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        return { display: style?.display, padding: style?.padding, marginBottom: style?.marginBottom, textAlign: style?.textAlign };
      }),
    ).resolves.toEqual({ display: "flex", padding: "14px 16px", marginBottom: "24px", textAlign: "start" });
    const gap = await banner.evaluate((element) => {
      const next = element.nextElementSibling;
      return next === null ? null : next.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(24);
    await context.close();
  });

  it("runs no animation 5.5 seconds after it loads while its agent is at work, and still says the agent is working", { timeout: 120_000 }, async () => {
    const context = await signedIn(1280);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/FE-1`);
    await page.getByText("mert's agent is working on FE-1").waitFor();
    expect((await runningAnimations(page)).length).toBeGreaterThan(0);
    // The time bound itself is what this test measures.
    await page.waitForTimeout(5_500);
    expect(await runningAnimations(page)).toEqual([]);
    await expect(page.getByText("mert's agent is working on FE-1").isVisible()).resolves.toBe(true);
    await context.close();
  });
});

describe("the room between a heading or a hint and what follows it", () => {
  /** The space, in CSS pixels, between the bottom of the first element the selector names and the top of the next one. */
  const gapAfter = (selector: string) =>
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); const next = element && element.nextElementSibling; return next ? next.getBoundingClientRect().top - element.getBoundingClientRect().bottom : null; })()`;

  it("leaves room under the API changelog's heading", { timeout: 120_000 }, async () => {
    const context = await signedIn(1280);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/docs/api/changelog`);
    await page.getByRole("heading", { level: 1, name: "API changelog" }).waitFor();
    expect(await page.evaluate(gapAfter("main h1"))).toBeGreaterThanOrEqual(8);
    await context.close();
  });

  it("leaves room under the hint of the form that changes a packet, above its first field", { timeout: 120_000 }, async () => {
    // A request Pia's team opened, so Pia is on the side that may change its packet.
    const { key } = await openRequest<{ key: string }>(install, tokenOf(seed.pia), { targetTeam: "BE", title: "Index the audit table" });
    const context = await signedIn(1280);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/${key}`);
    await page.locator("form.packet-form").waitFor();
    expect(await page.evaluate(gapAfter("form.packet-form > .hint"))).toBeGreaterThanOrEqual(12);
    await context.close();
  });
});

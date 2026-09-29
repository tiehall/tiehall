import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBrowserHarness, type BrowserHarness } from "./support/browser.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";

// A review page of the confirmation step in a real browser (agent-safety: One
// confirmation approves one action; agent-safety: The review page of the
// confirmation step; design.md, Self-hosting decisions: S7). The page's form
// posts the confirmation from the install's own origin, and the browser must
// say so: its Origin header has to equal the install's URL and its
// Sec-Fetch-Site has to be same-origin, or the confirmation is refused. A page
// sent with Referrer-Policy: no-referrer makes Chrome send `Origin: null` with
// its form's POST, which the check refuses, so the pages send same-origin,
// which keeps the referrer from every other site and still names the origin to
// the install itself.

let install: TestInstall;
let browser: BrowserHarness;
let pia: string;

beforeAll(async () => {
  install = await startTestInstall();
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
  browser = await startBrowserHarness(install);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await install?.close();
}, 60_000);

describe("a review page in a browser", { timeout: 60_000 }, () => {
  it("confirms its action from the person's own browser, which sends the install's origin", async () => {
    const page = await browser.pageOf(sessionOf(pia));
    const input = encodeURIComponent(JSON.stringify({ dailyWriteBudget: 8000 }));
    const review = await page.goto(`${browser.origin}/confirm/settings.set_write_budget?input=${input}`);
    expect(review?.status()).toBe(200);
    expect(review?.headers()["referrer-policy"]).toBe("same-origin");
    const [answer] = await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Confirm" }).click()]);
    expect(answer?.status()).toBe(200);
    await expect(page.getByRole("heading").textContent()).resolves.toBe("Confirmed");
    const { rows } = await install.owner.query<{ budget: number }>("SELECT daily_write_budget AS budget FROM install_settings");
    expect(rows[0]?.budget).toBe(8000);
    await page.context().close();
  });
});

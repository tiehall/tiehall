import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The web UI's create-then-view flow, in a browser (agent-surfaces: Negotiated
// request URLs; requests: Commitments become proposals; requests: Claiming and
// starting work need no proposal; design.md, Technical decisions: T3 and T17).
// Dana, a member of teams BE and FE, opens a request to FE from BE in the web
// form, lands on its page at its URL, where she sees its packet and its
// thread, claims it, posts a question, and declines it, which becomes a
// proposal that the page lists with a link to its confirm page. The flow runs
// in the installed Chrome against the web app as the image runs it
// (web-app.ts), signed in with a real web session. It waits as an expected
// failure until the commitment actions of task 18.11, since the form (18.7),
// the page (18.8) and its direct actions (18.10) come first.

const TITLE = "Add a dark mode to the settings page";
const NEED = "Our users work at night; the settings page should follow the system's dark mode.";
const QUESTION = "Should the toggle live in the header too?";

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let browser: Browser;
/** Dana's session cookie, as her signed-in browser holds it. */
let cookie: { name: string; value: string };

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const account = stub.addUser({ login: "dana" });
  const dana = await addUser(install.owner, { login: "dana", githubAccountId: account.id });
  await joinTeams(install.owner, dana, be, fe);
  web = await startWebApp(install);
  const signIn = await startSignIn(install, stub, { url: web.url });
  const [name = "", value = ""] = ((await signIn.signIn("dana")).jar.header().split("; ").find((pair) => pair.startsWith("tiehall.session_token=")) ?? "").split(/=(.*)/s);
  cookie = { name, value };
  expect(cookie.name).toBe("tiehall.session_token");
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await web?.close();
  await stub?.close();
  await install?.close();
}, 60_000);

/** A page in Dana's own browser, signed in to the web app. */
async function danasPage(): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ ...cookie, url: web.url }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return page;
}

/** The text a part of the page shows, once it is there. */
async function textOf(locator: Locator): Promise<string> {
  await locator.waitFor();
  return locator.innerText();
}

describe("the web UI's create-then-view flow", () => {
  it.fails("opens a request to FE in the web form, shows its packet and thread, claims it, posts a question and declines it, which waits as a proposal with a link to its confirm page", { timeout: 120_000 }, async () => {
    const page = await danasPage();
    await page.goto(`${web.url}/requests/new`);
    await page.getByLabel("To team").selectOption("FE");
    await page.getByLabel("From team").selectOption("BE");
    await page.getByLabel("Title").fill(TITLE);
    await page.getByLabel("What you need").fill(NEED);
    await Promise.all([page.waitForURL(`${web.url}/FE-1`), page.getByRole("button", { name: "Open the request" }).click()]);

    // The request's page, at its URL: its packet and its thread.
    const heading = await textOf(page.getByRole("heading", { level: 1 }));
    expect(heading).toContain("FE-1");
    expect(heading).toContain(TITLE);
    expect(await textOf(page.getByRole("region", { name: "Packet" }))).toContain(NEED);
    await page.getByRole("region", { name: "Thread" }).waitFor();

    // Claiming needs no proposal.
    await page.getByRole("button", { name: "Claim" }).click();
    await page.getByText("Claimed by dana").waitFor();

    // A question on the thread.
    await page.getByLabel("Kind").selectOption("question");
    await page.getByLabel("Message").fill(QUESTION);
    await page.getByRole("button", { name: "Post" }).click();
    await page.getByRole("region", { name: "Thread" }).getByText(QUESTION).waitFor();

    // A decline is a commitment: it waits as a proposal, which links to its confirm page, and the request stays claimed.
    await page.getByRole("button", { name: "Decline" }).click();
    const proposals = page.getByRole("region", { name: "Proposals" });
    expect(await textOf(proposals)).toContain("decline");
    const confirm = proposals.getByRole("link", { name: /confirm/i });
    expect(await confirm.getAttribute("href")).toMatch(/^\/confirm\/[0-9a-f-]{36}$/);
    await page.getByText("Claimed by dana").waitFor();
    await page.context().close();
  });
});

import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// Teams declare the APIs they consume, on the team's page (contract-changes:
// Teams declare the APIs they consume; agent-surfaces: Team intake pages;
// design.md, Decisions this change rests on: D15). The page of a team, /FE,
// lists the registered APIs with the team's declarations. A member of the team
// declares there that the team consumes an API, which the page then shows with
// who declared it and when, and removes the declaration, through the page's
// forms, which post to their own target, /teams/apis, run
// apis.declare_consumer and apis.remove_consumer through execute(), as the
// member's web session, and lead back to the page. Someone who is not a member of the
// team sees the declarations and no form. The page runs in the installed
// Chrome against the web app as the image runs it (web-app.ts), signed in
// with real web sessions.

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let browser: Browser;
let signIn: SignInHarness;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const fe = await addTeam(install.owner, "FE");
  const pay = await addTeam(install.owner, "PAY");
  const ada = await addUser(install.owner, { login: "ada", role: "admin", githubAccountId: stub.addUser({ login: "ada" }).id });
  const ayse = await addUser(install.owner, { login: "ayse", githubAccountId: stub.addUser({ login: "ayse" }).id });
  const deniz = await addUser(install.owner, { login: "deniz", githubAccountId: stub.addUser({ login: "deniz" }).id });
  await joinTeams(install.owner, ayse, fe);
  await joinTeams(install.owner, deniz, pay);
  await addInstallation(install.owner, { account: "acme", repositories: [{ fullName: "acme/payments", id: 7001 }] });
  expect((await install.confirm(sessionOf(ada), "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);
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

/** A page of this person's own browser, signed in to the web app, at a team's page. */
async function pageOf(login: string, key: string): Promise<Page> {
  const [name = "", value = ""] = ((await signIn.signIn(login)).jar.header().split("; ").find((pair) => pair.startsWith("tiehall.session_token=")) ?? "").split(/=(.*)/s);
  const context = await browser.newContext();
  await context.addCookies([{ name, value, url: web.url }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${web.url}/${key}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return page;
}

async function declarers(): Promise<string[]> {
  const { rows } = await install.owner.query<{ login: string }>(
    "SELECT u.github_login AS login FROM api_consumers c JOIN users u ON u.org_id = c.org_id AND u.id = c.declared_by",
  );
  return rows.map(({ login }) => login);
}

describe("a team's page", () => {
  it("lets a member of the team declare that it consumes an API, shows who declared it, and remove the declaration", { timeout: 120_000 }, async () => {
    const page = await pageOf("ayse", "FE");
    const apis = page.getByRole("region", { name: "APIs FE consumes" });
    await apis.getByText("payments-api, provided by PAY: FE has not declared that it consumes it.").waitFor();

    await apis.getByRole("button", { name: "Declare that FE consumes payments-api" }).click();
    await apis.getByText(/payments-api, provided by PAY: FE consumes it, as ayse declared on \d{4}-\d{2}-\d{2}/).waitFor();
    expect(await declarers()).toEqual(["ayse"]);

    await apis.getByRole("button", { name: "Remove the declaration that FE consumes payments-api" }).click();
    await apis.getByText("FE has not declared that it consumes it.").waitFor();
    expect(await declarers()).toEqual([]);
  });

  it("shows someone outside the team the declarations, and no form", { timeout: 60_000 }, async () => {
    const page = await pageOf("deniz", "FE");
    const apis = page.getByRole("region", { name: "APIs FE consumes" });
    await apis.getByText("payments-api, provided by PAY").waitFor();
    expect(await apis.getByRole("button").count()).toBe(0);
  });
});

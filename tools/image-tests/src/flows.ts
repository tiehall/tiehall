import type { GitHubStub } from "@tiehall/testing/github";
import { chromium, type Browser, type Page } from "playwright-core";
import type { CliMachine } from "./cli.ts";
import { waitFor } from "./docker.ts";
import type { Install } from "./install.ts";

// The steps people take on an install, through its web UI and the tiehall
// command, as the docs describe them (self-host-install: Setup names the
// company and makes the first admin; sign-in: GitHub is the only way to sign
// in; agent-access: The CLI signs in through a restricted device flow;
// design.md, Technical decisions: T17), for the operator tests that run an
// install end to end against the GitHub stub.

/** A person of a test: their browser, signed in to the install, and their machine with the tiehall command. */
export interface Person {
  login: string;
  page: Page;
  cli: CliMachine;
}

/** The runner's Chrome, or TIEHALL_TEST_CHROME, started with these arguments. */
export function launchBrowser(args: string[]): Promise<Browser> {
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  return chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args });
}

/** A new browser of a person's own, not signed in to anything yet. */
export async function browserOf(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(30_000);
  return page;
}

/**
 * Sets the install up through its setup screen, as `operator`, signed in to
 * GitHub in the browser of `page`: the setup code from the app's log, the
 * company's name, the GitHub App created for the organization `org` and
 * installed on these of its repositories, and the operator's sign-in, which
 * makes them the first admin. Returns the App's name.
 */
export async function setUpThroughTheScreen(input: {
  install: Install;
  github: GitHubStub;
  page: Page;
  operator: string;
  company: string;
  org: string;
  repositories: readonly string[];
}): Promise<string> {
  const { install, github, page } = input;
  const url = install.url;
  const code = await waitFor("the setup code in the app's log", () => /enter the setup code ([0-9A-Z]{4}(?:-[0-9A-Z]{4}){6})/.exec(install.logs("app"))?.[1]);
  github.signIn(input.operator);
  await page.goto(`${url}/setup`);
  await page.getByLabel("Setup code").fill(code);
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
  await page.getByLabel("The company's name").fill(input.company);
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Save the name" }).click()]);
  await page.getByLabel("The GitHub organization that owns the App").fill(input.org);
  await Promise.all([page.waitForURL(/\/setup\?/), page.getByRole("button", { name: "Apply" }).click()]);
  await Promise.all([page.waitForURL(`https://github.com/organizations/${input.org}/settings/apps/new?*`), page.getByRole("button", { name: "Create the GitHub App" }).click()]);
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: `Create GitHub App for ${input.org}` }).click()]);
  const [app] = github.apps();
  if (app === undefined) throw new Error("the stub made no App");
  await Promise.all([page.waitForURL(`https://github.com/apps/${app.slug}/installations/new`), page.getByRole("link", { name: `Install ${app.name} on GitHub` }).click()]);
  await page.getByLabel("Only select repositories").check();
  for (const repository of input.repositories) await page.getByLabel(repository).check();
  await Promise.all([page.waitForURL(/\/settings\/installations\//), page.getByRole("button", { name: "Install" }).click()]);
  await page.goto(`${url}/setup`);
  await Promise.all([page.waitForURL("https://github.com/login/oauth/authorize?*"), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
  await Promise.all([page.waitForURL(`${url}/`), page.getByRole("button", { name: `Authorize ${app.name}` }).click()]);
  await page.getByText("You are signed in.").waitFor();
  return app.name;
}

/** Signs `login` in with GitHub, in the browser of `page`, through the install's App `appName`. */
export async function signInWithGitHub(input: { install: Install; github: GitHubStub; page: Page; login: string; appName: string }): Promise<void> {
  const { install, page } = input;
  input.github.signIn(input.login);
  await page.goto(`${install.url}/`);
  await Promise.all([page.waitForURL("https://github.com/login/oauth/authorize?*"), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
  await Promise.all([page.waitForURL(`${install.url}/`), page.getByRole("button", { name: `Authorize ${input.appName}` }).click()]);
  await page.getByText("You are signed in.").waitFor();
}

/** Creates these teams on the admin's teams page, and puts each person in theirs. */
export async function createTeams(input: { install: Install; admin: Page; teams: readonly (readonly [key: string, name: string])[]; members: readonly (readonly [team: string, login: string])[] }): Promise<void> {
  const { install, admin: page } = input;
  const url = install.url;
  await page.goto(`${url}/admin/teams`);
  for (const [team, name] of input.teams) {
    await page.getByLabel("Key", { exact: true }).fill(team);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Create the team" }).click()]);
  }
  for (const [team, login] of input.members) {
    await page.getByLabel(`Add a member to ${team}`).selectOption({ label: login });
    await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: `Add to ${team}` }).click()]);
  }
}

/** Signs the person's tiehall command in through the device flow, with the code approved in their own browser; returns the run. */
export async function signInCli(install: Install, person: Person): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const login = person.cli.start(["login", install.url]);
  const code = await waitFor("the code tiehall login prints", () => /type this code: (\S+)/.exec(login.printed())?.[1]);
  await person.page.goto(`${install.url}/device`);
  await person.page.getByLabel("The code tiehall login printed").fill(code);
  await Promise.all([person.page.waitForURL(`${install.url}/device`), person.page.getByRole("button", { name: "Continue" }).click()]);
  await Promise.all([person.page.waitForURL(`${install.url}/confirm/agent_clients.approve_device`), person.page.getByRole("button", { name: "Confirm" }).click()]);
  await person.page.getByText("Return to your terminal", { exact: false }).waitFor();
  return login.ended;
}

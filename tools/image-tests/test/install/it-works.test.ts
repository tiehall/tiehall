import type { Client } from "@modelcontextprotocol/client";
import { scannedOutputs } from "@tiehall/testing/confirm-url-scan";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildCli, type BuiltCli, type CliMachine, type CliProcess, type CliRun } from "../../src/cli.ts";
import { waitFor } from "../../src/docker.ts";
import { stubGitHubFor, type StubbedGitHub } from "../../src/github.ts";
import { Install } from "../../src/install.ts";
import { callTool, connectAgent } from "../../src/mcp.ts";

// The end-to-end "It works" test (agent-surfaces: Four agent surfaces;
// requester-loop: Pull is the contract; requests: Commitments become
// proposals; requests: Cross-team commitments need a confirmation from each
// side; design.md, Technical decisions: T17). A fresh install, from init's
// .env and deploy/compose.yaml with the image under test, set up through the
// setup screen against the GitHub stub (github.ts). Two people sign in with
// GitHub, each in a browser of their own: Omar, the first admin, in the team
// BE, and Dana, a member, in FE. Each has the tiehall command on a machine of
// their own, built from the repository (cli.ts), which signs in through the
// device flow, Dana's after waiting for its code for over 100 seconds, past
// the token endpoint's limit on the calls from one address; Omar's agent is
// the official MCP SDK client, which signs in with OAuth through the consent
// screen (mcp.ts). Then the loop runs, every
// step through the surface a person or an agent uses:
// - Omar's agent opens a request to FE over MCP;
// - Dana's CLI claims it, starts work and asks a blocking question;
// - Omar's `tiehall hook wait`, as the Stop hook runs it, exits with code 2,
//   and whats_new lists the question to Omar's agent;
// - the agent's answer over MCP returns the request to in_progress;
// - a due date Omar's agent proposes takes effect once Omar, then Dana,
//   confirm it in the web UI;
// - a decline Dana proposes with `tiehall status` takes effect once Dana
//   confirms it in the web UI; the receipt links its undo, which restores
//   in_progress.
// Every tool result an agent reads over /mcp, and everything the CLI prints,
// its hooks' output included, is scanned for a confirm URL, which reaches
// people only in the web UI, never an agent (agent-safety: The confirm URL
// never reaches the model).
// CI runs it on every pull request, and on main against the pushed image.

const image = inject("image");

/** A person of the test: their browser, signed in to the install, and their machine with the tiehall command. */
interface Person {
  login: string;
  page: Page;
  cli: CliMachine;
}

let install: Install;
let github: StubbedGitHub;
let browser: Browser;
let tiehall: BuiltCli;
let omar: Person;
let dana: Person;
let agent: Client;
/** The request the loop runs on. */
let key: string;

/** The day a proposed due date names: a month from now. */
const DUE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);
const QUESTION = "Should the total include the shipping cost?";

beforeAll(async () => {
  tiehall = await buildCli();
  install = await Install.create({ image, name: "tiehall-it-works" });
  github = await stubGitHubFor(install);
  github.stub.addUser({ login: "omar" });
  github.stub.addUser({ login: "dana" });
  github.stub.addOrg({ login: "acme", members: { omar: "admin", dana: "member" } });
  github.stub.addRepo("acme/web");
  // Started without holding up this process, which plays GitHub.
  const up = await install.shellAsync("docker compose up -d", { timeoutSeconds: 600 });
  if (up.status !== 0) throw new Error(`docker compose up failed:\n${up.stderr}`);
  await install.healthy();
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: github.browserArgs });
});

afterAll(async () => {
  await agent?.close();
  await browser?.close();
  install?.destroy();
  await github?.close();
  tiehall?.remove();
});

/** A new browser of the person's own, not signed in to anything yet. */
async function browserOf(): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(30_000);
  return page;
}

/** The request as the agent reads it with get_request: its state, and its packet's revision and due date. */
async function read(): Promise<{ state: string; claimant: { login: string } | null; revision: number; dueDate: string | null }> {
  const page = await callTool<{ request: { state: string; claimant: { login: string } | null }; packet: { revision: number; dueDate: string | null } }>(
    agent,
    "get_request",
    { request: key, section: "packet" },
  );
  return {
    state: page.request.state,
    claimant: page.request.claimant === null ? null : { login: page.request.claimant.login },
    revision: page.packet.revision,
    dueDate: page.packet.dueDate,
  };
}

/**
 * How long a CLI waits for its code's approval in the test, polling every 5 seconds: past its 21st poll, which the
 * token endpoint's limit on the calls from one address, 20 in a row, would refuse with 429.
 */
const PAST_THE_TOKEN_LIMIT_SECONDS = 110;

/** Waits until `tiehall login` has polled for its code this many seconds after asking for it, failing at once if it ended meanwhile. */
async function keepsPolling(login: CliProcess, seconds: number): Promise<void> {
  let ended: CliRun | undefined;
  login.ended.then(
    (run) => void (ended = run),
    () => undefined,
  );
  const outcome = await waitFor(
    `tiehall login to poll for ${seconds} seconds`,
    () => {
      if (ended !== undefined) return "ended";
      const polled = install.sql("SELECT coalesce(extract(epoch FROM last_polled_at - requested_at), 0) FROM oauth_device_codes ORDER BY requested_at DESC LIMIT 1");
      return Number(polled) >= seconds ? "polling" : undefined;
    },
    seconds + 60,
  );
  expect(outcome, `${ended?.stdout ?? ""}\n${ended?.stderr ?? ""}`).toBe("polling");
}

/** The standing list's item of the request in the person's web inbox. */
async function waitingItem(person: Person) {
  await person.page.goto(`${install.url}/inbox`);
  return person.page.locator("#waiting li").filter({ has: person.page.locator(`a[href="/${key}"]`) });
}

/** Follows the link of the request's waiting proposal in the person's web inbox to its confirm page, and confirms it there. */
async function confirmInTheWebUi(person: Person): Promise<void> {
  const item = await waitingItem(person);
  await Promise.all([person.page.waitForURL(`${install.url}/confirm/*`), item.getByRole("link", { name: "Review and confirm" }).click()]);
  await Promise.all([person.page.waitForNavigation(), person.page.getByRole("button", { name: "Confirm" }).click()]);
}

/** The receipts in the person's web inbox about the request. */
async function receiptsOf(person: Person) {
  await person.page.goto(`${install.url}/inbox`);
  return person.page.locator("#receipts li").filter({ hasText: key });
}

describe("It works: a fresh install, two people in two teams, and their agents", () => {
  it("is set up through the setup screen, and both people sign in with GitHub and are put in their teams", async () => {
    const url = install.url;
    const code = await waitFor("the setup code in the app's log", () => /enter the setup code ([0-9A-Z]{4}(?:-[0-9A-Z]{4}){6})/.exec(install.logs("app"))?.[1]);

    // Omar, the operator, sets the install up in their browser, signed in to GitHub, and is its first admin.
    github.stub.signIn("omar");
    const page = await browserOf();
    await page.goto(`${url}/setup`);
    await page.getByLabel("Setup code").fill(code);
    await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
    await page.getByLabel("The company's name").fill("Acme");
    await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Save the name" }).click()]);
    await page.getByLabel("The GitHub organization that owns the App").fill("acme");
    await Promise.all([page.waitForURL(/\/setup\?/), page.getByRole("button", { name: "Apply" }).click()]);
    await Promise.all([page.waitForURL("https://github.com/organizations/acme/settings/apps/new?*"), page.getByRole("button", { name: "Create the GitHub App" }).click()]);
    await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Create GitHub App for acme" }).click()]);
    const [app] = github.stub.apps();
    await Promise.all([page.waitForURL(`https://github.com/apps/${app?.slug}/installations/new`), page.getByRole("link", { name: `Install ${app?.name} on GitHub` }).click()]);
    await page.getByLabel("Only select repositories").check();
    await page.getByLabel("acme/web").check();
    await Promise.all([page.waitForURL(/\/settings\/installations\//), page.getByRole("button", { name: "Install" }).click()]);
    await page.goto(`${url}/setup`);
    await Promise.all([page.waitForURL("https://github.com/login/oauth/authorize?*"), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
    await Promise.all([page.waitForURL(`${url}/`), page.getByRole("button", { name: `Authorize ${app?.name}` }).click()]);
    await page.getByText("You are signed in.").waitFor();
    omar = { login: "omar", page, cli: tiehall.machine() };

    // Dana signs in with GitHub in their own browser, as a member of the organization that installed the App.
    github.stub.signIn("dana");
    const danasPage = await browserOf();
    await danasPage.goto(`${url}/`);
    await Promise.all([danasPage.waitForURL("https://github.com/login/oauth/authorize?*"), danasPage.getByRole("button", { name: "Sign in with GitHub" }).click()]);
    await Promise.all([danasPage.waitForURL(`${url}/`), danasPage.getByRole("button", { name: `Authorize ${app?.name}` }).click()]);
    await danasPage.getByText("You are signed in.").waitFor();
    dana = { login: "dana", page: danasPage, cli: tiehall.machine() };

    // The admin creates the two teams and puts each person in theirs.
    await page.goto(`${url}/admin/teams`);
    for (const [team, name] of [
      ["BE", "Backend"],
      ["FE", "Frontend"],
    ] as const) {
      await page.getByLabel("Key", { exact: true }).fill(team);
      await page.getByLabel("Name", { exact: true }).fill(name);
      await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Create the team" }).click()]);
    }
    for (const [team, login] of [
      ["BE", "omar"],
      ["FE", "dana"],
    ] as const) {
      await page.getByLabel(`Add a member to ${team}`).selectOption({ label: login });
      await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: `Add to ${team}` }).click()]);
    }

    expect(install.sql("SELECT name || ' ' || (setup_completed_at IS NOT NULL) FROM orgs")).toBe("Acme true");
    expect(
      install.sql(
        `SELECT string_agg(u.github_login || ' ' || m.role || ' ' || t.key, ',' ORDER BY u.github_login)
           FROM members m JOIN users u ON u.id = m.user_id JOIN team_members tm ON tm.user_id = m.user_id JOIN teams t ON t.id = tm.team_id`,
      ),
    ).toBe("dana member FE,omar admin BE");
  });

  it("signs in each person's CLI through the device flow, with the code approved in their own browser", async () => {
    for (const person of [omar, dana]) {
      const login = person.cli.start(["login", install.url]);
      const code = await waitFor("the code tiehall login prints", () => /type this code: (\S+)/.exec(login.printed())?.[1]);
      expect(login.printed()).toContain(`${install.url}/device`);
      // Dana takes their time: their CLI polls at the install's interval for longer than the token endpoint lets
      // other calls from one address go on, from the address every client on this machine reaches the trial URL
      // from, Omar's CLI's included, and it is still waiting when Dana approves the code.
      if (person === dana) await keepsPolling(login, PAST_THE_TOKEN_LIMIT_SECONDS);
      await person.page.goto(`${install.url}/device`);
      await person.page.getByLabel("The code tiehall login printed").fill(code);
      await Promise.all([person.page.waitForURL(`${install.url}/device`), person.page.getByRole("button", { name: "Continue" }).click()]);
      await Promise.all([person.page.waitForURL(`${install.url}/confirm/agent_clients.approve_device`), person.page.getByRole("button", { name: "Confirm" }).click()]);
      await person.page.getByText("Return to your terminal", { exact: false }).waitFor();
      const ended = await login.ended;
      expect(ended.code, `${ended.stdout}\n${ended.stderr}`).toBe(0);
    }
  });

  it("lets Omar's agent, the MCP SDK client approved on the consent screen, open a request to Dana's team", async () => {
    agent = await connectAgent(install.url, omar.page, "It works agent");
    // The install's MCP server offers tools, and neither resources nor prompts.
    const capabilities = agent.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeUndefined();
    const opened = await callTool<{ key: string; state: string; targetTeam: { key: string }; requester: { user: { login: string }; team: { key: string } } }>(
      agent,
      "open_request",
      {
        targetTeam: "FE",
        title: "Show the invoice total on the order page",
        packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "The order page shows each line's price but not the invoice total." } },
      },
    );
    expect(opened).toMatchObject({ key: "FE-1", state: "open", targetTeam: { key: "FE" }, requester: { user: { login: "omar" }, team: { key: "BE" } } });
    key = opened.key;
  });

  // agent-surfaces: CLI request commands, "Getting a request by URL". The CLI sends the URL as the path parameter of
  // the API's read, with its slashes encoded as %2F, which Caddy and the web app pass on as they are.
  it("lets Dana's CLI read the request by its URL, through the install's proxy and web app", async () => {
    const run = await dana.cli.run(["get", `${install.url}/${key}`]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain(key);
    expect(run.stdout).toContain("The order page shows each line's price but not the invoice total.");
  });

  it("wakes Omar's hook wait with code 2 when Dana's CLI claims it, starts work and asks a blocking question, and whats_new lists the question", async () => {
    const claimed = await dana.cli.run(["claim", key]);
    expect(claimed.code, claimed.stderr).toBe(0);
    const started = await dana.cli.run(["status", key, "in_progress"]);
    expect(started.code, started.stderr).toBe(0);
    expect(await read()).toMatchObject({ state: "in_progress", claimant: { login: "dana" } });

    // What came before is acknowledged, as Omar's agent handled it; the Stop hook then arms the waiter.
    await acknowledgeEverything(omar.cli);
    const waiter = omar.cli.start(["hook", "wait", "--install", install.url], { stdin: JSON.stringify({ session_id: "it-works-session", hook_event_name: "Stop" }) });

    const asked = await dana.cli.run(["ask", key, QUESTION, "--blocking", "--json"]);
    expect(asked.code, asked.stderr).toBe(0);
    const question = JSON.parse(asked.stdout) as { message: { id: string; kind: string; blocking: boolean }; request: { state: string } };
    expect(question).toMatchObject({ message: { kind: "question", blocking: true }, request: { state: "needs_info" } });

    const woken = await waiter.ended;
    expect(woken.code, woken.stderr).toBe(2);
    expect(woken.stdout).toBe("");
    expect(woken.stderr).toContain(`${key} request.message_posted (team FE) ${install.url}/${key}\n`);
    expect(woken.stderr).not.toContain(QUESTION);

    const news = await callTool<{ events: { type: string; request: { key: string }; data: Record<string, unknown> }[] }>(agent, "whats_new", { limit: 50 });
    expect(news.events).toContainEqual(
      expect.objectContaining({ type: "request.message_posted", request: expect.objectContaining({ key }), data: expect.objectContaining({ messageId: question.message.id, kind: "question", blocking: true }) }),
    );
  });

  it("returns the request to in_progress with the answer Omar's agent posts over MCP", async () => {
    const news = await callTool<{ events: { type: string; request: { key: string }; data: { messageId?: string; kind?: string } }[] }>(agent, "whats_new", { limit: 50 });
    const questionId = news.events.find(({ type, request, data }) => type === "request.message_posted" && request.key === key && data.kind === "question")?.data.messageId;
    expect(questionId).toBeDefined();
    const answered = await callTool<{ message: { kind: string; questionId: string }; request: { state: string } }>(agent, "post_message", {
      key,
      kind: "answer",
      body: "Yes, with the shipping cost as a line of its own.",
      questionId,
    });
    expect(answered).toMatchObject({ message: { kind: "answer", questionId }, request: { state: "in_progress" } });
    expect((await read()).state).toBe("in_progress");
  });

  it("applies a due date Omar's agent proposes once Omar, and then Dana, confirm it in the web UI", async () => {
    const before = await read();
    const proposed = await callTool<{ proposal: { id: string; kind: string; state: string } }>(agent, "propose", {
      kind: "due_date",
      key,
      dueDate: DUE_DATE,
      expectedRevision: before.revision,
    });
    expect(proposed.proposal).toMatchObject({ kind: "due_date", state: "pending" });
    expect((await read()).dueDate).toBeNull();

    // Omar, whose agent proposed it, confirms first; it then waits for FE.
    await confirmInTheWebUi(omar);
    expect((await read()).dueDate).toBeNull();
    await expect((await receiptsOf(omar)).first().textContent()).resolves.toContain(`You confirmed setting the due date of ${key} to ${DUE_DATE}`);

    // Dana, of the target team, gives the other side's confirmation, and the due date takes effect.
    await confirmInTheWebUi(dana);
    expect(await read()).toMatchObject({ state: "in_progress", dueDate: DUE_DATE, revision: before.revision + 1 });
    await expect((await receiptsOf(omar)).allTextContents()).resolves.toContainEqual(
      expect.stringContaining(`The due date of ${key} was set to ${DUE_DATE}, with your confirmation.`),
    );
  });

  it("declines the request once Dana confirms the decline their CLI proposed, and the receipt's undo within the window restores in_progress", async () => {
    const proposed = await dana.cli.run(["status", key, "declined"]);
    expect(proposed.code, proposed.stderr).toBe(0);
    expect(proposed.stdout).toMatch(/Proposal [0-9a-f-]{36}: decline /);
    expect((await read()).state).toBe("in_progress");

    await confirmInTheWebUi(dana);
    expect((await read()).state).toBe("declined");

    const receipt = (await receiptsOf(dana)).filter({ hasText: `${key} was declined, with your confirmation.` });
    await expect(receipt.count()).resolves.toBe(1);
    await Promise.all([dana.page.waitForURL(`${install.url}/confirm/*/undo`), receipt.getByRole("link", { name: /^Undo · / }).click()]);
    await Promise.all([dana.page.waitForNavigation(), dana.page.getByRole("button", { name: "Confirm" }).click()]);
    expect(await read()).toMatchObject({ state: "in_progress", claimant: { login: "dana" }, dueDate: DUE_DATE });
  });
});

// agent-safety: The confirm URL never reaches the model. Each scan fails the step whose output held a confirm URL;
// this says the scans ran over each kind of output the loop gave an agent.
describe("what the loop gave the agents", () => {
  it("held no confirm URL: every tool result over /mcp, CLI output and hook output was scanned", () => {
    expect(scannedOutputs["tool result"]).toBeGreaterThan(0);
    expect(scannedOutputs["CLI output"]).toBeGreaterThan(0);
    expect(scannedOutputs["hook output"]).toBeGreaterThan(0);
  });
});

/** Acknowledges every update the machine's CLI has, through `tiehall updates`, so that its hooks see only what comes next. */
async function acknowledgeEverything(cli: CliMachine): Promise<void> {
  for (;;) {
    const read = await cli.run(["updates", "--json", "--limit", "50"]);
    expect(read.code, read.stderr).toBe(0);
    const page = JSON.parse(read.stdout) as { events: { number: number }[] };
    if (page.events.length === 0) return;
    const acknowledged = await cli.run(["updates", "--json", "--limit", "1", "--acknowledge", String(Math.max(...page.events.map(({ number }) => number)))]);
    expect(acknowledged.code, acknowledged.stderr).toBe(0);
  }
}

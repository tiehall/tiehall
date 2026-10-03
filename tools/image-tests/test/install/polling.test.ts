import type { Client } from "@modelcontextprotocol/client";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildCli, type BuiltCli } from "../../src/cli.ts";
import { waitFor } from "../../src/docker.ts";
import { browserOf, createTeams, launchBrowser, setUpThroughTheScreen, signInCli, signInWithGitHub, type Person } from "../../src/flows.ts";
import { Install } from "../../src/install.ts";
import { isolate, type Isolation } from "../../src/isolated.ts";
import { callTool, connectAgent } from "../../src/mcp.ts";

// GitHub in polling mode, end to end, on an install GitHub cannot reach
// (tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode;
// requests: Linked PRs and done on merge; contract-changes: Merging the
// provider PR marks the change shipped; contract-changes: Consumers close
// requests with their own PR; contract-changes: Requests are withdrawn when
// the provider PR closes unmerged; tracker-mirrors: Inbound tracker changes
// are recorded, not applied; design.md, Technical decisions: T17). A fresh
// install, from init's .env and deploy/compose.yaml with the image under
// test, runs in a network where only the stubs of the services it may reach
// are reachable (isolated.ts), so nothing outside it, GitHub's stub included,
// can open a connection to it: its only way in is the port published on
// 127.0.0.1 for the people and agents on the host. Its URL is a trial URL, so the setup screen
// creates the App without a webhook, and GitHub runs in polling mode from the
// start, as the admin page says. Then the loop runs, and each change made on
// GitHub reaches the install within 2 minutes of being made:
// - a pull request whose title names a claimed request is seen, and its
//   merge closes the request;
// - an assignee change and a close of a mirror issue are recorded on the
//   request;
// - the contract Action reports two provider pull requests; the close of one
//   without merging withdraws its unclaimed request, the merge of the other
//   marks its change shipped, and FE's own pull request, which names its
//   request, closes that request when it merges.
// Each bound runs from the moment the stub made the change. Jira is not in it
// yet: its mirror is built in group 25.

const image = inject("image");

/** How long a change made on GitHub may take to reach the install in polling mode. */
const BOUND_MS = 2 * 60_000;

/** The breaking change the contract Action reports. */
const BREAKING = { id: "response-property-removed", level: "ERR", operation: "GET /payments/{id}" } as const;

let install: Install;
let isolation: Isolation;
let browser: Browser;
let tiehall: BuiltCli;
let omar: Person;
let dana: Person;
let agent: Client;
let ids: { payments: number; acme: number };

/** How long each change took to reach the install, by what it was. */
const took: Record<string, number> = {};

beforeAll(async () => {
  tiehall = await buildCli();
  install = await Install.create({ image, name: "tiehall-polling" });
  isolation = await isolate(install);
  const { github } = isolation;
  github.addUser({ login: "omar" });
  github.addUser({ login: "dana" });
  const acme = github.addOrg({ login: "acme", members: { omar: "admin", dana: "member" } });
  github.addRepo("acme/web");
  const payments = github.addRepo("acme/payments");
  ids = { payments: payments.id, acme: acme.id };
  // Started without holding up this process, which plays the stubs.
  const up = await install.shellAsync("docker compose up -d", { timeoutSeconds: 600 });
  if (up.status !== 0) throw new Error(`docker compose up failed:\n${up.stderr}\n${install.describe()}`);
  await install.healthy();
  browser = await launchBrowser(isolation.browserArgs);
});

afterAll(async () => {
  await agent?.close();
  await browser?.close();
  install?.destroy();
  await isolation?.close();
  tiehall?.remove();
});

/** The state of the request with this key. */
function stateOf(key: string): string {
  const [team, number] = key.split("-");
  return install.sql(`SELECT r.state FROM requests r JOIN teams t ON t.id = r.target_team_id WHERE t.key = '${team}' AND r.number = ${Number(number)}`);
}

/** Waits until `effect` holds, and records how long it took after `since`, which must be within the bound. */
async function within(what: string, since: number, effect: () => boolean): Promise<void> {
  await waitFor(what, () => (effect() ? true : undefined), (BOUND_MS + 30_000) / 1000);
  took[what] = Date.now() - since;
  expect(took[what], `${what} took ${took[what]} ms`).toBeLessThanOrEqual(BOUND_MS);
}

/** Has the contract Action report the changes of a provider pull request in acme/payments, with the OIDC token of its run. */
async function report(pull: { number: number; base: { ref: string; sha: string }; head: { ref: string; sha: string } }): Promise<void> {
  const token = isolation.oidc.token({ audience: install.url, repository: "acme/payments", repositoryId: ids.payments, repositoryOwnerId: ids.acme });
  const answer = await install.fetch("/api/v1/contract-reports", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      api: "payments-api",
      pullRequest: { number: pull.number },
      base: pull.base,
      head: pull.head,
      engine: { name: "oasdiff", version: "1.32.1" },
      changes: [BREAKING],
    }),
  });
  expect(answer.status, await answer.clone().text()).toBe(200);
}

/** The key of the request the contract report of this provider pull request opened. */
function contractRequestOf(pullRequest: number): string {
  return install.sql(
    `SELECT t.key || '-' || r.number FROM requests r JOIN contract_change_requests c ON c.request_id = r.id JOIN contract_change_sets s ON s.id = c.change_set_id
       JOIN teams t ON t.id = r.target_team_id WHERE s.pull_request_number = ${pullRequest}`,
  );
}

describe("GitHub in polling mode on an install GitHub cannot reach", () => {
  it("is set up through the setup screen with an App without a webhook, and the admin page says that GitHub runs in polling mode", async () => {
    const url = install.url;
    const page = await browserOf(browser);
    const appName = await setUpThroughTheScreen({ install, github: isolation.github, page, operator: "omar", company: "Acme", org: "acme", repositories: ["acme/web", "acme/payments"] });
    expect(isolation.github.apps()[0]?.hook).toBeNull();
    omar = { login: "omar", page, cli: tiehall.machine() };
    const danasPage = await browserOf(browser);
    await signInWithGitHub({ install, github: isolation.github, page: danasPage, login: "dana", appName });
    dana = { login: "dana", page: danasPage, cli: tiehall.machine() };
    await createTeams({ install, admin: page, teams: [["BE", "Backend"], ["FE", "Frontend"]], members: [["BE", "omar"], ["FE", "dana"]] });

    await page.goto(`${url}/admin/teams`);
    await page.getByLabel("Intake repository of FE").selectOption("acme/web");
    await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Mirror FE's requests into this repository" }).click()]);
    await page.goto(`${url}/admin/apis`);
    await page.getByLabel("Name, such as payments-api", { exact: false }).fill("payments-api");
    await page.getByLabel("Provider team").selectOption({ label: "BE: Backend" });
    await page.getByLabel("GitHub repository, as owner/name").fill("acme/payments");
    await Promise.all([page.waitForURL(`${url}/confirm/*`), page.getByRole("button", { name: "Review the registration" }).click()]);
    await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Confirm" }).click()]);
    await danasPage.goto(`${url}/FE`);
    await Promise.all([danasPage.waitForNavigation(), danasPage.getByRole("button", { name: "Declare that FE consumes payments-api" }).click()]);

    await page.goto(`${url}/admin`);
    await page.getByText("GitHub runs in polling mode: Tiehall asks GitHub for changes every 60 seconds, so a change reaches it within 2 minutes.").waitFor();
    expect(install.sql("SELECT mode FROM github_app")).toBe("polling");
    for (const person of [omar, dana]) {
      const ended = await signInCli(install, person);
      expect(ended.code, `${ended.stdout}\n${ended.stderr}`).toBe(0);
    }
    agent = await connectAgent(install.url, omar.page, "Polling agent");
  });

  it("runs the loop, and closes a claimed request when a pull request whose title names it merges, each change on GitHub reaching the install within 2 minutes", async () => {
    const opened = await callTool<{ key: string }>(agent, "open_request", {
      targetTeam: "FE",
      title: "Show the invoice total on the order page",
      packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "The order page shows each line's price but not the invoice total." } },
    });
    const key = opened.key;
    expect((await dana.cli.run(["claim", key])).code).toBe(0);
    expect((await dana.cli.run(["status", key, "in_progress"])).code).toBe(0);
    const asked = await dana.cli.run(["ask", key, "Should the total include the shipping cost?", "--blocking", "--json"]);
    expect(asked.code, asked.stderr).toBe(0);
    const question = JSON.parse(asked.stdout) as { message: { id: string } };
    expect(stateOf(key)).toBe("needs_info");
    await callTool(agent, "post_message", { key, kind: "answer", body: "Yes, as a line of its own.", questionId: question.message.id });
    expect(stateOf(key)).toBe("in_progress");

    // Dana's pull request names the request in its title, and the poll sees it while it is open.
    const own = await isolation.github.openPullRequest("acme/web", { title: `Show the invoice total (${key})`, head: "invoice-total", author: "dana" });
    const openedAt = Date.now();
    await within("the mention of the open pull request", openedAt, () => install.sql(`SELECT count(*) FROM pull_request_mentions WHERE number = ${own.number} AND '${key}' = ANY(keys)`) === "1");
    await isolation.github.mergePullRequest("acme/web", own.number, { by: "dana" });
    const mergedAt = Date.now();
    await within("the request done after the merge", mergedAt, () => stateOf(key) === "done");
  });

  it("records an assignee change and a close of a mirror issue on GitHub on its request, each within 2 minutes", async () => {
    const opened = await callTool<{ key: string }>(agent, "open_request", {
      targetTeam: "FE",
      title: "Show the tax on the order page",
      packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "The order page does not show the tax." } },
    });
    const key = opened.key;
    expect((await dana.cli.run(["claim", key])).code).toBe(0);
    const mirror = await waitFor("the mirror issue in acme/web", () => {
      const number = install.sql(`SELECT m.issue FROM mirrors m JOIN requests r ON r.id = m.request_id JOIN teams t ON t.id = r.target_team_id WHERE t.key || '-' || r.number = '${key}' AND m.issue IS NOT NULL`);
      return number === "" ? undefined : Number(number);
    }, 120);
    const changes = (kind: string) => install.sql(`SELECT count(*) FROM tracker_changes c JOIN requests r ON r.id = c.request_id JOIN teams t ON t.id = r.target_team_id WHERE t.key || '-' || r.number = '${key}' AND c.change = '${kind}'`);

    await isolation.github.assignIssue("acme/web", mirror, { by: "dana", assignees: ["dana"] });
    const assignedAt = Date.now();
    await within("the assignee change of the mirror issue", assignedAt, () => changes("assignees_changed") === "1");
    await isolation.github.closeIssue("acme/web", mirror, { by: "dana", reason: "completed" });
    const closedAt = Date.now();
    await within("the close of the mirror issue", closedAt, () => changes("closed") === "1");
    // A close in the tracker is a notice on the request, which stays as it was.
    expect(stateOf(key)).toBe("claimed");
  });

  it("withdraws the unclaimed request of a provider pull request closed unmerged, marks the other's change shipped when it merges, and closes FE's request with FE's own pull request, each within 2 minutes", async () => {
    const shipping = await isolation.github.openPullRequest("acme/payments", { title: "Drop the legacy amount field", head: "drop-legacy-amount", author: "omar" });
    const abandoned = await isolation.github.openPullRequest("acme/payments", { title: "Rename the payment id", head: "rename-payment-id", author: "omar" });
    await report(shipping);
    await report(abandoned);
    // Each report's update is applied 2 minutes after it arrived, and opens FE's request.
    const shippingKey = await waitFor("the request of the shipping pull request", () => contractRequestOf(shipping.number) || undefined, 300);
    const abandonedKey = await waitFor("the request of the abandoned pull request", () => contractRequestOf(abandoned.number) || undefined, 300);

    await isolation.github.closePullRequest("acme/payments", abandoned.number, { by: "omar" });
    const abandonedAt = Date.now();
    expect((await dana.cli.run(["claim", shippingKey])).code).toBe(0);
    const own = await isolation.github.openPullRequest("acme/web", { title: `Use the new payment amount (${shippingKey})`, head: "new-amount", author: "dana" });
    const ownOpenedAt = Date.now();
    await isolation.github.mergePullRequest("acme/payments", shipping.number, { by: "omar" });
    const shippedAt = Date.now();

    await within("the withdrawal after the provider pull request closed unmerged", abandonedAt, () => stateOf(abandonedKey) === "withdrawn");
    await within("the shipped mark after the provider pull request merged", shippedAt, () => install.sql(`SELECT count(*) FROM contract_change_sets WHERE pull_request_number = ${shipping.number} AND provider_merged_at IS NOT NULL`) === "1");
    // The provider pull request's merge closes no request.
    expect(stateOf(shippingKey)).toBe("claimed");
    await within("the mention of FE's own pull request", ownOpenedAt, () => install.sql(`SELECT count(*) FROM pull_request_mentions WHERE number = ${own.number} AND '${shippingKey}' = ANY(keys)`) === "1");
    await isolation.github.mergePullRequest("acme/web", own.number, { by: "dana" });
    const ownMergedAt = Date.now();
    await within("FE's request done after FE's own pull request merged", ownMergedAt, () => stateOf(shippingKey) === "done");
  });

  it("made every change within the 2-minute bound, with no DNS query and no connection attempt beyond the stubs", () => {
    expect(Object.keys(took).sort()).toEqual([
      "FE's request done after FE's own pull request merged",
      "the assignee change of the mirror issue",
      "the close of the mirror issue",
      "the mention of FE's own pull request",
      "the mention of the open pull request",
      "the request done after the merge",
      "the shipped mark after the provider pull request merged",
      "the withdrawal after the provider pull request closed unmerged",
    ]);
    for (const [what, ms] of Object.entries(took)) expect(ms, what).toBeLessThanOrEqual(BOUND_MS);
    expect(install.sql("SELECT mode FROM github_app")).toBe("polling");
    expect(isolation.dnsQueries()).toEqual([]);
    expect(isolation.noRouteAttempts()).toEqual({ app: 0, postgres: 0 });
  });

  it.todo("picks up the changes of Jira in polling mode within 2 minutes too, once the Jira mirror is built (tasks 25.1 to 25.11)");
});

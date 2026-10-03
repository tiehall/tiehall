import { readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/client";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildCli, type BuiltCli } from "../../src/cli.ts";
import { waitFor } from "../../src/docker.ts";
import { browserOf, createTeams, launchBrowser, setUpThroughTheScreen, signInCli, signInWithGitHub, type Person } from "../../src/flows.ts";
import { Install } from "../../src/install.ts";
import { ACTIONS_OIDC_HOST, CLIENT_METADATA_URL, isolate, SMTP_HOST, VENDOR_HOST, type Isolation } from "../../src/isolated.ts";
import { callTool, connectAgent } from "../../src/mcp.ts";

// The egress test (self-host-install: No telemetry and a documented list of
// outbound connections; self-host-install: The setting that switches
// metadata-document fetching off; self-host-install: No model calls;
// design.md, Technical decisions: T17; design.md, Self-hosting decisions:
// S13). A fresh install, from init's .env and deploy/compose.yaml with the
// image under test, with SMTP settings in .env, runs in a network where only
// the stubs of the services it may reach are reachable (isolated.ts): GitHub's
// web and API, the keys of GitHub Actions' OIDC issuer, an SMTP server and an
// agent vendor's host that serves its client's metadata document. Any other
// DNS query the install makes reaches a logger, and any other connection
// attempt finds no route, which the kernel counts; either fails the test.
// Through it the install runs its main flows, each through the surface a
// person or an agent uses:
// - setup through the setup screen, the GitHub App created and installed on
//   acme/web and acme/payments, two people signed in with GitHub, their teams,
//   FE's requests mirrored into acme/web, the API payments-api registered for
//   BE with the confirmation step, and FE's declaration that it consumes it;
// - both people's CLIs signed in through the device flow;
// - Omar's agent signed in over MCP, with its metadata document fetched from
//   the vendor's host, or, with fetching off, with Dynamic Client
//   Registration, and a request it opens to FE;
// - Dana's claim, which mirrors the request into acme/web, and a blocking
//   question, which Omar gets by email, answered by the agent;
// - Dana's pull request that names the request, which Dana's CLI links to
//   it, whose merge, which polling finds, closes it and its mirror issue;
// - the contract Action's report of a provider pull request in acme/payments,
//   with the OIDC token of its run, which opens a request to FE, and the
//   provider pull request's merge, which marks the change shipped.
// It runs twice: with metadata-document fetching on, as an install has it
// unless .env says otherwise, and with TIEHALL_CLIENT_METADATA_FETCH=off, when
// the vendor's host must see no request. A last step shows that the watch sees
// a DNS query and a connection attempt to a model vendor made from the app's
// container. Jira is not in it yet: its mirror is built in group 25.

const image = inject("image");

/** The page "What an install connects to" of the install docs, which the stubs' hosts must be named in. */
const INSTALL_DOCS = readFileSync(new URL("../../../../docs/install.md", import.meta.url), "utf8");

/** The breaking change the contract Action reports. */
const BREAKING = { id: "response-property-removed", level: "ERR", operation: "GET /payments/{id}" } as const;

describe.each(["on", "off"] as const)("An install with metadata-document fetching %s, in a network where only the stubs are reachable", (fetching) => {
  let install: Install;
  let isolation: Isolation;
  let browser: Browser;
  let tiehall: BuiltCli;
  let omar: Person;
  let dana: Person;
  let agent: Client;
  /** The request Omar's agent opens to FE. */
  let key: string;
  /** The provider pull request in acme/payments, and FE's own in acme/web. */
  let providerPull: number;
  let ids: { payments: number; acme: number };

  beforeAll(async () => {
    tiehall = await buildCli();
    install = await Install.create({ image, name: `tiehall-egress-${fetching}` });
    if (fetching === "off") install.setEnv("TIEHALL_CLIENT_METADATA_FETCH", "off");
    install.setEnv("TIEHALL_SMTP_HOST", SMTP_HOST);
    install.setEnv("TIEHALL_SMTP_PORT", "25");
    install.setEnv("TIEHALL_SMTP_TLS", "none");
    install.setEnv("TIEHALL_SMTP_FROM", "Tiehall <tiehall@acme.example>");
    isolation = await isolate(install);
    const { github } = isolation;
    github.addUser({ login: "omar", email: "omar@acme.example" });
    github.addUser({ login: "dana", email: "dana@acme.example" });
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

  it("is set up through the setup screen; both people sign in, FE mirrors into acme/web, and payments-api is registered for BE and consumed by FE", async () => {
    const url = install.url;
    const page = await browserOf(browser);
    const appName = await setUpThroughTheScreen({ install, github: isolation.github, page, operator: "omar", company: "Acme", org: "acme", repositories: ["acme/web", "acme/payments"] });
    omar = { login: "omar", page, cli: tiehall.machine() };
    const danasPage = await browserOf(browser);
    await signInWithGitHub({ install, github: isolation.github, page: danasPage, login: "dana", appName });
    dana = { login: "dana", page: danasPage, cli: tiehall.machine() };
    await createTeams({ install, admin: page, teams: [["BE", "Backend"], ["FE", "Frontend"]], members: [["BE", "omar"], ["FE", "dana"]] });

    // FE's requests are mirrored into acme/web, as issues created when a request is claimed.
    await page.goto(`${url}/admin/teams`);
    await page.getByLabel("Intake repository of FE").selectOption("acme/web");
    await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Mirror FE's requests into this repository" }).click()]);
    await page.getByText("FE's requests are mirrored into GitHub Issues, as issues in acme/web").waitFor();

    // The admin registers payments-api for BE, bound to acme/payments, and confirms it on its review page.
    await page.goto(`${url}/admin/apis`);
    await page.getByLabel("Name, such as payments-api", { exact: false }).fill("payments-api");
    await page.getByLabel("Provider team").selectOption({ label: "BE: Backend" });
    await page.getByLabel("GitHub repository, as owner/name").fill("acme/payments");
    await Promise.all([page.waitForURL(`${url}/confirm/*`), page.getByRole("button", { name: "Review the registration" }).click()]);
    await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Confirm" }).click()]);

    // Dana declares, on FE's page, that FE consumes it.
    await danasPage.goto(`${url}/FE`);
    await Promise.all([danasPage.waitForNavigation(), danasPage.getByRole("button", { name: "Declare that FE consumes payments-api" }).click()]);

    expect(install.sql("SELECT name || ' ' || (setup_completed_at IS NOT NULL) FROM orgs")).toBe("Acme true");
    expect(install.sql("SELECT a.name || ' ' || t.key || ' ' || a.repository_full_name FROM apis a JOIN teams t ON t.id = a.provider_team_id")).toBe("payments-api BE acme/payments");
    expect(install.sql("SELECT count(*) FROM api_consumers")).toBe("1");
  });

  it("signs in each person's CLI through the device flow", async () => {
    for (const person of [omar, dana]) {
      const ended = await signInCli(install, person);
      expect(ended.code, `${ended.stdout}\n${ended.stderr}`).toBe(0);
    }
  });

  it("takes the contract Action's report of a provider pull request in acme/payments, with the OIDC token of its run", async () => {
    const pull = await isolation.github.openPullRequest("acme/payments", { title: "Drop the legacy amount field", head: "drop-legacy-amount", author: "omar" });
    providerPull = pull.number;
    const token = isolation.oidc.token({ audience: install.url, repository: "acme/payments", repositoryId: ids.payments, repositoryOwnerId: ids.acme });
    const answer = await install.fetch("/api/v1/contract-reports", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        api: "payments-api",
        pullRequest: { number: pull.number },
        base: { ref: pull.base.ref, sha: pull.base.sha },
        head: { ref: pull.head.ref, sha: pull.head.sha },
        engine: { name: "oasdiff", version: "1.32.1" },
        changes: [BREAKING],
      }),
    });
    expect(answer.status, await answer.clone().text()).toBe(200);
    // The install read the issuer's published keys from GitHub Actions' host.
    expect(isolation.received).toContainEqual({ host: ACTIONS_OIDC_HOST, path: "/.well-known/jwks" });
  });

  it(
    fetching === "on"
      ? "signs Omar's agent in with its metadata document, fetched from the vendor's host, and opens a request to FE over MCP"
      : "signs Omar's agent in with Dynamic Client Registration, fetching no metadata document, and opens a request to FE over MCP",
    async () => {
      agent = await connectAgent(install.url, omar.page, "Egress agent", {
        clientMetadataUrl: CLIENT_METADATA_URL,
        redirectUri: (redirect) =>
          isolation.serveClientMetadata({
            client_id: CLIENT_METADATA_URL,
            client_name: "Egress agent",
            redirect_uris: [redirect],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
      });
      const fetched = isolation.received.filter(({ host }) => host === VENDOR_HOST);
      if (fetching === "on") {
        expect(fetched).toContainEqual({ host: VENDOR_HOST, path: new URL(CLIENT_METADATA_URL).pathname });
        expect(install.sql(`SELECT count(*) FROM oauth_clients WHERE client_id = '${CLIENT_METADATA_URL}'`)).not.toBe("0");
      } else {
        expect(fetched).toEqual([]);
        expect(install.sql(`SELECT count(*) FROM oauth_clients WHERE client_id = '${CLIENT_METADATA_URL}'`)).toBe("0");
      }
      const opened = await callTool<{ key: string; state: string }>(agent, "open_request", {
        targetTeam: "FE",
        title: "Show the invoice total on the order page",
        packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "The order page shows each line's price but not the invoice total." } },
      });
      expect(opened.state).toBe("open");
      key = opened.key;
    },
  );

  it("mirrors the request into acme/web when Dana's CLI claims it, and emails Omar the blocking question it asks", async () => {
    expect((await dana.cli.run(["claim", key])).code).toBe(0);
    expect((await dana.cli.run(["status", key, "in_progress"])).code).toBe(0);
    const issue = await waitFor("the mirror issue in acme/web", () => {
      try {
        return isolation.github.issue("acme/web", 1);
      } catch {
        return undefined;
      }
    }, 120);
    expect(issue.body).toContain(`${install.url}/${key}`);

    const asked = await dana.cli.run(["ask", key, "Should the total include the shipping cost?", "--blocking", "--json"]);
    expect(asked.code, asked.stderr).toBe(0);
    const question = JSON.parse(asked.stdout) as { message: { id: string } };
    const email = await waitFor("the question's email to Omar", () => isolation.smtp.messages.find(({ to }) => to.includes("omar@acme.example")), 120);
    expect(email.data).toContain(key);
    const answered = await callTool<{ request: { state: string } }>(agent, "post_message", {
      key,
      kind: "answer",
      body: "Yes, with the shipping cost as a line of its own.",
      questionId: question.message.id,
    });
    expect(answered.request.state).toBe("in_progress");
  });

  it("closes the request and its mirror issue when Dana's pull request linked to it merges, and marks payments-api's change shipped when the provider pull request merges, both found by polling", async () => {
    // The contract report's update is applied 2 minutes after it arrived, and opens FE's request.
    const contractRequest = await waitFor(
      "the request the contract report opens to FE",
      () => install.sql("SELECT t.key || '-' || r.number FROM requests r JOIN contract_change_requests c ON c.request_id = r.id JOIN teams t ON t.id = r.target_team_id") || undefined,
      300,
    );
    expect(contractRequest).toMatch(/^FE-\d+$/);
    const own = await isolation.github.openPullRequest("acme/web", { title: `Show the invoice total (${key})`, head: `${key}-invoice-total`, author: "dana" });
    const linked = await dana.cli.run(["link-pr", key, `https://github.com/acme/web/pull/${own.number}`]);
    expect(linked.code, linked.stderr).toBe(0);
    await isolation.github.mergePullRequest("acme/web", own.number, { by: "dana" });
    await isolation.github.mergePullRequest("acme/payments", providerPull, { by: "omar" });
    await waitFor("the request done", async () => ((await callTool<{ request: { state: string } }>(agent, "get_request", { request: key })).request.state === "done" ? true : undefined), 300);
    await waitFor("the mirror issue closed", () => (isolation.github.issue("acme/web", 1).state === "closed" ? true : undefined), 300);
    await waitFor("the provider change shipped", () => (install.sql("SELECT count(*) FROM contract_change_sets WHERE provider_merged_at IS NOT NULL") === "1" ? true : undefined), 300);
  });

  it("made no DNS query and no connection attempt to any host but the stubs of GitHub, the SMTP server and the vendor's host, each named in the docs' list", () => {
    // The install reached the stubs: GitHub's API with the App's tokens, the SMTP server, and the issuer's keys.
    expect(isolation.github.received.some(({ path }) => path.startsWith("/repos/acme/web/issues"))).toBe(true);
    expect(isolation.smtp.messages.length).toBeGreaterThan(0);
    expect(isolation.received.some(({ host }) => host === ACTIONS_OIDC_HOST)).toBe(true);
    if (fetching === "off") expect(isolation.received.filter(({ host }) => host === VENDOR_HOST)).toEqual([]);
    // Nothing else: no name the network does not hold was looked up, and no connection went looking for a route out.
    expect(isolation.dnsQueries()).toEqual([]);
    expect(isolation.noRouteAttempts()).toEqual({ app: 0, postgres: 0, migrate: 0 });
    // The stubs play the hosts the docs list for operators' egress rules.
    const section = INSTALL_DOCS.slice(INSTALL_DOCS.indexOf("## What an install connects to"));
    for (const host of ["github.com", "api.github.com", ACTIONS_OIDC_HOST]) expect(section).toContain(`\`${host}\``);
    expect(section).toContain("The SMTP server in `.env`");
    expect(section).toContain("Client ID Metadata Documents");
  });

  it("sees a DNS query and a connection attempt to a model vendor made from the app's container, so the test fails when the install makes one", () => {
    const attempt = install.shell(
      "docker compose exec -T app node --eval " +
        `'require("node:dns").lookup("api.openai.com", () => { const socket = require("node:net").connect(443, "162.159.140.245"); socket.on("error", () => process.exit(0)); });'`,
    );
    expect(attempt.status, attempt.stderr).toBe(0);
    expect(isolation.dnsQueries().map(({ name }) => name)).toContain("api.openai.com");
    expect(isolation.noRouteAttempts().app).toBeGreaterThan(0);
  });

  // The migrate step ends before the app starts, and its network namespace with it, so it runs in a namespace a
  // container of the test's holds, whose counters are read after the step ended.
  it("watches the migrate step too: it ran in the namespace whose counters are read, which sees a connection attempt", () => {
    const holder = install.compose(["ps", "--all", "--quiet", "migrate-net"]).stdout.trim();
    const migrate = install.compose(["ps", "--all", "--quiet", "migrate"]).stdout.trim();
    expect(holder).not.toBe("");
    expect(install.shell(`docker inspect --format '{{.HostConfig.NetworkMode}}' ${migrate}`).stdout.trim()).toMatch(new RegExp(`^container:${holder.slice(0, 12)}`));
    expect(install.compose(["ps", "--all", "--format", "{{.ExitCode}}", "migrate"]).stdout.trim()).toBe("0");
    const attempt = install.shell(
      "docker compose exec -T migrate-net node --eval " + `'const socket = require("node:net").connect(443, "162.159.140.245"); socket.on("error", () => process.exit(0));'`,
    );
    expect(attempt.status, attempt.stderr).toBe(0);
    expect(isolation.noRouteAttempts().migrate).toBeGreaterThan(0);
  });

  it.todo("reaches the Jira site's stub alone for the Jira mirror, once it is built (tasks 25.1 to 25.6)");
});

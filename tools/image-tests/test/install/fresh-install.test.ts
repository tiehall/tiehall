import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { documented } from "../../src/docs.ts";
import { waitFor } from "../../src/docker.ts";
import { stubGitHubFor, type StubbedGitHub } from "../../src/github.ts";
import { freePort, Install, quote, RELEASE_FILES } from "../../src/install.ts";

// The fresh-install test (self-host-install: Compose runs Tiehall and
// Postgres; self-host-install: Setup names the company and makes the first
// admin; self-host-install: `init` prints a complete `.env`;
// self-host-install: `TIEHALL_URL` and TLS; self-host-install: Operator
// commands on the host; design.md, Technical decisions: T17). The operator
// follows the install docs, docs/install.md, whose commands this test runs by
// name (docs.ts): they download the release files, write .env with `init`,
// start the install with `docker compose up -d`, read the setup code with
// `docker compose logs app`, and, in a real browser, go through the setup
// screen and GitHub's manifest flow, install the App and sign in, becoming the
// first admin; then they create teams and open a request, and run the
// commands on the host. A second install starts with the caddy profile, which
// serves TIEHALL_URL over TLS with a certificate Caddy made itself. GitHub is
// the stub (github.ts). CI runs it on every pull request.

const image = inject("image");
const DEPLOY = fileURLToPath(new URL("../../../../deploy/", import.meta.url));

let release: { server: Server; url: string };
let install: Install;
let github: StubbedGitHub;
let browser: Browser;
let page: Page;

/** Serves the release's files, as a release page offers them for download. */
async function serveReleaseFiles(): Promise<{ server: Server; url: string }> {
  const files = [...RELEASE_FILES, ".env.example"];
  const server = createServer((incoming, outgoing) => {
    const name = (incoming.url ?? "").replace(/^\//, "");
    if (!files.includes(name)) {
      outgoing.writeHead(404).end();
      return;
    }
    outgoing.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(join(DEPLOY, name)));
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${port}` };
}

/**
 * Runs a documented command in the install's folder, and fails with its output
 * when it fails. It does not hold up this process, which serves the release's
 * files and plays GitHub while the command runs.
 */
async function run(target: Install, command: string, timeoutSeconds = 600) {
  const result = await target.shellAsync(command, { timeoutSeconds });
  expect(result.status, `${command}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
}

beforeAll(async () => {
  release = await serveReleaseFiles();
  install = await Install.empty({ name: "tiehall-fresh" });
  github = await stubGitHubFor(install);
  github.stub.addUser({ login: "omar" });
  github.stub.addOrg({ login: "acme", members: { omar: "admin" } });
  github.stub.addRepo("acme/web");
  github.stub.addRepo("acme/api");
  // The operator's browser is signed in to GitHub as Omar.
  github.stub.signIn("omar");
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: github.browserArgs });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
  install?.destroy();
  await github?.close();
  await new Promise((resolve) => release?.server.close(resolve));
});

/** The admin's SQL view of the install, as the database owner. */
const sql = (query: string) => install.sql(query);

describe("a fresh install, as the install docs go", () => {
  it("downloads the release files, writes .env with init, and starts, serving the setup screen", async () => {
    await run(install, documented("install-download", { "<release>": release.url }));
    for (const file of [...RELEASE_FILES, ".env.example"]) expect(readFileSync(join(install.dir, file), "utf8")).toBe(readFileSync(join(DEPLOY, file), "utf8"));
    await run(install, documented("install-init", { "<image>": image, "https://tiehall.example.com": install.url }));
    // What init printed runs the image under test at the install's URL; the test publishes the app on a free port.
    expect(install.readEnv("TIEHALL_IMAGE")).toBe(image);
    expect(install.readEnv("TIEHALL_URL")).toBe(install.url);
    install.publishOnItsPort();

    await run(install, documented("install-up"));

    await install.healthy();
    const answer = await install.fetch("/", { redirect: "manual" });
    expect(answer.status).toBe(307);
    expect(answer.headers.get("location")).toBe(`${install.url}/setup`);
  });

  it("completes setup through the setup screen and the App's manifest flow: the operator is the first admin", async () => {
    const url = install.url;
    // The setup code, as the operator reads it.
    const logs = await run(install, documented("install-setup-code"));
    const code = /enter the setup code ([0-9A-Z]{4}(?:-[0-9A-Z]{4}){6})/.exec(logs.stdout)?.[1];
    expect(code, logs.stdout).toBeDefined();

    await page.goto(`${url}/setup`);
    await page.getByLabel("Setup code").fill(code!);
    await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
    await page.getByLabel("The company's name").fill("Acme");
    await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Save the name" }).click()]);
    // A trial URL: the App has no webhook, and GitHub runs in polling mode.
    await expect(page.getByText("GitHub runs in polling mode").count()).resolves.toBe(1);
    await page.getByLabel("The GitHub organization that owns the App").fill("acme");
    await Promise.all([page.waitForURL(/\/setup\?/), page.getByRole("button", { name: "Apply" }).click()]);
    await Promise.all([page.waitForURL("https://github.com/organizations/acme/settings/apps/new?*"), page.getByRole("button", { name: "Create the GitHub App" }).click()]);
    await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Create GitHub App for acme" }).click()]);

    // The install converted the code with GitHub and stored the App.
    const [app] = github.stub.apps();
    expect(app?.hook).toBeNull();
    expect(sql("SELECT app_id::text || ' ' || mode FROM github_app")).toBe(`${app?.id} polling`);

    // Installing the App on acme, on GitHub's own page.
    await Promise.all([page.waitForURL(`https://github.com/apps/${app?.slug}/installations/new`), page.getByRole("link", { name: `Install ${app?.name} on GitHub` }).click()]);
    await page.getByLabel("Only select repositories").check();
    for (const repository of ["acme/web", "acme/api"]) await page.getByLabel(repository).check();
    await Promise.all([page.waitForURL(/\/settings\/installations\//), page.getByRole("button", { name: "Install" }).click()]);

    // The sign-in from the setup session completes setup.
    await page.goto(`${url}/setup`);
    await Promise.all([page.waitForURL("https://github.com/login/oauth/authorize?*"), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
    await Promise.all([page.waitForURL(`${url}/`), page.getByRole("button", { name: `Authorize ${app?.name}` }).click()]);
    await expect(page.getByText("You are signed in.").count()).resolves.toBe(1);

    expect(sql("SELECT name || ' ' || (setup_completed_at IS NOT NULL) FROM orgs")).toBe("Acme true");
    expect(sql("SELECT u.github_login || ' ' || m.role FROM members m JOIN users u ON u.id = m.user_id")).toBe("omar admin");
    expect(sql("SELECT string_agg(full_name, ',' ORDER BY full_name) FROM github_covered_repositories")).toBe("acme/api,acme/web");
    expect((await page.goto(`${url}/setup`))?.status()).toBe(404);
  });

  it("lets the first admin create teams and open a request", async () => {
    const url = install.url;
    await page.goto(`${url}/admin/teams`);
    for (const [key, name] of [
      ["BE", "Backend"],
      ["FE", "Frontend"],
    ] as const) {
      await page.getByLabel("Key", { exact: true }).fill(key);
      await page.getByLabel("Name", { exact: true }).fill(name);
      await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Create the team" }).click()]);
    }
    await page.getByLabel("Add a member to BE").selectOption({ label: "omar" });
    await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Add to BE" }).click()]);

    await page.goto(`${url}/requests/new`);
    await page.getByLabel("To team").selectOption("FE");
    await page.getByLabel("From team").selectOption("BE");
    await page.getByLabel("Title").fill("Show the invoice total on the order page");
    await page.getByLabel("What you need").fill("The order page shows each line's price but not the invoice total.");
    await Promise.all([page.waitForURL(`${url}/FE-1`), page.getByRole("button", { name: "Open the request" }).click()]);
    await expect(page.getByText("Show the invoice total on the order page").count()).resolves.toBeGreaterThan(0);

    expect(sql("SELECT t.key || '-' || r.number || ' ' || r.state FROM requests r JOIN teams t ON t.id = r.target_team_id")).toBe("FE-1 open");
    // GitHub was reached only as the stub, through the install's own calls.
    expect(github.stub.received.some(({ host, method, path }) => host === "api" && method === "GET" && path === "/app/installations")).toBe(true);
  });

  it("runs the commands on the host: admin grant, and setup reopen, which prints a new setup code for the App step", async () => {
    const grant = await run(install, documented("operator-grant", { "<github-login>": "omar" }));
    expect(grant.stdout).toContain("omar is an admin already, so nothing changed.");

    const reopen = await run(install, documented("operator-reopen"));
    const code = /enter the setup code ([0-9A-Z]{4}(?:-[0-9A-Z]{4}){6})/.exec(reopen.stdout)?.[1];
    expect(code, reopen.stdout).toBeDefined();
    await page.goto(`${install.url}/setup`);
    await page.getByLabel("Setup code").fill(code!);
    await Promise.all([page.waitForURL(`${install.url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
    await expect(page.getByText("Create a new GitHub App").count()).resolves.toBe(1);
    expect(sql("SELECT string_agg(type || ' ' || operator_command, ',' ORDER BY number) FROM events WHERE actor_kind = 'operator'")).toBe(
      "operator.command_run admin grant,setup.reopened setup reopen",
    );
  });
});

describe("the caddy profile, as the install docs start it", () => {
  let caddy: Install;
  let tlsPort: number;

  beforeAll(async () => {
    caddy = await Install.empty({ name: "tiehall-caddy" });
    await run(caddy, documented("install-download", { "<release>": release.url }));
    // Caddy obtains a certificate for localhost from its own authority, which needs no public host name.
    await run(caddy, documented("install-init", { "<image>": image, "https://tiehall.example.com": "https://localhost" }));
    caddy.publishOnItsPort();
    // Caddy's 443 on a free port of the host, where a CI runner may not publish 80 and 443.
    tlsPort = await freePort();
    const override = ["services:", "  caddy:", "    ports: !override", `      - "127.0.0.1:${tlsPort}:443"`, ""].join("\n");
    writeFileSync(join(caddy.dir, "compose.override.yaml"), override);
  });

  afterAll(() => {
    caddy?.destroy();
  });

  it("serves TIEHALL_URL over TLS through Caddy, with a certificate Caddy obtained itself, and passes each request to the app", async () => {
    await run(caddy, documented("install-up-caddy"));
    await caddy.healthy();
    expect(caddy.compose(["ps", "--format", "{{.Service}} {{.State}}", "caddy"]).stdout.trim()).toBe("caddy running");
    // Caddy's own authority, whose root signs the certificate it made for localhost.
    const root = await waitFor("Caddy's local certificate authority", () => {
      const read = caddy.compose(["exec", "-T", "caddy", "cat", "/data/caddy/pki/authorities/local/root.crt"]);
      return read.status === 0 && read.stdout.includes("BEGIN CERTIFICATE") ? read.stdout : undefined;
    });
    const answer = await waitFor("an answer through Caddy", () => getOverTls(`https://localhost:${tlsPort}/healthz`, root).catch(() => undefined));
    expect(answer).toEqual({ status: 200, body: '{"status":"up"}' });
  });
});

/** A GET over TLS that trusts only this root certificate, and checks the certificate's name. */
function getOverTls(url: string, ca: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpsRequest({ host: "127.0.0.1", port: target.port, path: target.pathname, servername: target.hostname, headers: { host: target.host }, ca }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("the .env that init writes, as the install docs write it", () => {
  // .env holds the install's secrets from the moment init prints them: nobody but its owner may read it at any time,
  // whatever the umask of the operator's shell, and not only once a later chmod has run.
  it("can be read by its owner only, while init writes it as well as after", async () => {
    const target = await Install.empty({ name: "tiehall-env" });
    try {
      const bin = join(target.dir, "stand-in");
      mkdirSync(bin);
      // Stands in for `docker run ... init`: prints a secret, then takes a moment to exit, as a pull or a slow start does.
      writeFileSync(join(bin, "docker"), "#!/bin/sh\necho TIEHALL_SECRET_KEY=stand-in-secret\nsleep 3\n", { mode: 0o755 });
      const env = join(target.dir, ".env");

      const writing = target.shellAsync(`umask 022; PATH=${quote(bin)}:"$PATH"; ${documented("install-init", { "<image>": "example/tiehall:1.0.0" })}`);
      await waitFor(".env to hold the secret", () => (existsSync(env) && readFileSync(env, "utf8").includes("stand-in-secret") ? true : undefined), 30);
      const whileWriting = statSync(env).mode & 0o777;
      const written = await writing;

      expect(written.status, written.stderr).toBe(0);
      expect(whileWriting.toString(8)).toBe("600");
      expect((statSync(env).mode & 0o777).toString(8)).toBe("600");
    } finally {
      rmSync(target.dir, { recursive: true, force: true });
    }
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { docsCommands, docsTestName, fencedBlocks, INSTALL_DOCS, installDocsCommands } from "../src/docs-commands.ts";

// The install docs and the CI jobs that run their commands (self-host-install:
// Backups with the shipped scripts; self-host-install: Upgrades apply
// migrations before the app starts; self-host-install: No telemetry and a
// documented list of outbound connections; self-host-install: No model calls;
// self-host-install: The GitHub App is created with GitHub's manifest flow;
// tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode).
// docs/install.md shows every command an operator runs as a named `sh` block;
// the operator tests of the fresh-install, backup and upgrade CI jobs run each
// block by its name (tools/image-tests/src/docs.ts). This check makes sure
// that every block has a name, that one of those jobs' tests runs it, and that
// the docs cover what an operator needs: the download, `init`, starting with
// and without the caddy profile, TLS through the operator's own proxy and the
// trusted proxies, an external Postgres, the setup code, the App and the first
// admin, GitHub's modes, a move to a new host, backups, restore, upgrades,
// rollbacks, the commands on the host and the outbound hosts, which name no
// model vendor; and what a trial URL's cookies reach (self-host-install:
// `TIEHALL_URL` and TLS).

const root = fileURLToPath(new URL("../../../", import.meta.url));
const docs = readFileSync(join(root, INSTALL_DOCS), "utf8");
/** The docs as one line of text, for phrases that a line break may split. */
const flat = docs.replace(/\s+/g, " ");

/** The operator test files of each CI job that runs the docs' commands, as image-checks.yml runs them. */
const JOBS: Readonly<Record<string, { name: string; files: readonly string[] }>> = {
  "fresh-install-test": { name: "Fresh install", files: ["fresh-install"] },
  "backup-test": { name: "Backup and restore", files: ["backup"] },
  "upgrade-test": { name: "Upgrade and rollback", files: ["upgrade", "rollback"] },
};

const TESTS = join(root, "tools/image-tests/test/install");

/** The names of the documented commands an operator test file runs, from its calls of documented(). */
function documentedIn(file: string): string[] {
  return [...readFileSync(join(TESTS, `${file}.test.ts`), "utf8").matchAll(/\bdocumented\(\s*"([a-z0-9-]+)"/g)].map((match) => match[1] ?? "");
}

/** The section of the docs under a heading, up to the next heading of the same level or higher. */
function section(heading: string): string {
  const start = docs.indexOf(`\n## ${heading}\n`);
  if (start === -1) return "";
  const next = docs.indexOf("\n## ", start + 1);
  return docs.slice(start, next === -1 ? undefined : next);
}

describe("the named commands of a Markdown text", () => {
  const text = [
    "Start it:",
    "",
    "```sh docs-test=start",
    "docker compose up -d",
    "```",
    "",
    "1. Back up:",
    "",
    "   ```sh docs-test=back-up",
    "   ./backup.sh",
    "   ```",
    "",
    "```sh",
    "echo unnamed",
    "```",
    "",
    "```ini",
    "TIEHALL_URL=https://tiehall.example.com",
    "```",
  ].join("\n");

  it("are the sh blocks with a name, a list item's without its indentation", () => {
    expect(docsCommands(text)).toEqual([
      { id: "start", text: "docker compose up -d", line: 3 },
      { id: "back-up", text: "./backup.sh", line: 9 },
    ]);
  });

  it("leave out an sh block without a name, which the check below refuses, and blocks in other languages", () => {
    expect(fencedBlocks(text).map(({ info }) => [info, docsTestName(info)])).toEqual([
      ["sh docs-test=start", "start"],
      ["sh docs-test=back-up", "back-up"],
      ["sh", undefined],
      ["ini", undefined],
    ]);
  });
});

describe("the install docs' commands", () => {
  it("are all named `sh` blocks, with names that no two blocks share", () => {
    const shell = fencedBlocks(docs).filter(({ info }) => /^(?:sh|bash|shell|console)\b/.test(info));
    expect(shell.length).toBeGreaterThan(0);
    for (const block of shell) expect(docsTestName(block.info), `the block on line ${block.line} of ${INSTALL_DOCS}`).toBeDefined();
    const names = docsCommands(docs).map(({ id }) => id);
    expect(new Set(names).size).toBe(names.length);
  });

  it("are each run by an operator test of the fresh-install, backup or upgrade job, and those tests run no other", () => {
    const run = new Set(Object.values(JOBS).flatMap(({ files }) => files.flatMap(documentedIn)));
    const documented = [...installDocsCommands(root).keys()];
    expect(documented.filter((name) => !run.has(name))).toEqual([]);
    expect([...run].filter((name) => !documented.includes(name))).toEqual([]);
  });

  it("run in the image checks' jobs, which run those tests", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/image-checks.yml"), "utf8")) as {
      jobs: Record<string, { name?: string; steps?: { run?: string }[] }>;
    };
    for (const [id, { name, files }] of Object.entries(JOBS)) {
      const job = workflow.jobs[id];
      expect(job?.name, id).toBe(name);
      expect(job?.steps?.map(({ run }) => run).filter((run) => run?.startsWith("pnpm test:install"))).toEqual([`pnpm test:install ${files.join(" ")}`]);
      for (const file of files) expect(readdirSync(TESTS)).toContain(`${file}.test.ts`);
    }
  });
});

describe("the install docs", () => {
  it("cover downloading the release files, init, and starting with and without the caddy profile", () => {
    const commands = installDocsCommands(root);
    // GitHub keeps no leading period in a release file's name, so the release page offers .env.example as env.example.
    expect(commands.get("install-download")?.text).toContain("for file in compose.yaml Caddyfile backup.sh restore.sh;");
    expect(commands.get("install-download")?.text).toContain('--output .env.example "<release>/env.example"');
    expect(commands.get("install-init")?.text).toContain("init --url https://tiehall.example.com --image <image> > .env");
    expect(commands.get("install-up")?.text).toBe("docker compose up -d");
    expect(commands.get("install-up-caddy")?.text).toBe("docker compose --profile caddy up -d");
  });

  it("cover TLS through the operator's own proxy with the trusted proxies, and an external Postgres", () => {
    const proxy = section("Start the install");
    expect(proxy).toContain("### TLS through your own reverse proxy");
    for (const phrase of ["TIEHALL_TRUSTED_PROXIES", "X-Forwarded-For", "X-Forwarded-Proto", "TIEHALL_HTTP_BIND"]) expect(flat).toContain(phrase);
    expect(proxy).toContain("### An external Postgres");
    for (const phrase of ["TIEHALL_DATABASE_OWNER_URL=", "TIEHALL_DATABASE_APP_URL=", "Postgres 17 or later"]) expect(flat).toContain(phrase);
  });

  // A database on another host is reached over the network, so its connections use TLS that checks the server: the
  // example's URLs ask for it, and the docs say what it needs.
  it("connect to an external Postgres over TLS that checks the server's certificate and host name", () => {
    const external = (section("Start the install").split("### An external Postgres")[1] ?? "").split("\n## ")[0] ?? "";
    const urls = [...external.matchAll(/^TIEHALL_DATABASE_(?:OWNER|APP)_URL=(\S+)$/gm)].map(([, url]) => url ?? "");
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(new URL(url).searchParams.get("sslmode")).toBe("verify-full");
    const text = external.replace(/\s+/g, " ");
    for (const phrase of ["`sslmode=verify-full`", "certificate", "host name"]) expect(text).toContain(phrase);
  });

  // `docker compose run` starts the service's dependencies first, the migrate step among them, so an admin command run
  // while the migrate step fails, as after an upgrade gone wrong, would stop there: the commands on the host run with
  // --no-deps, against the database the install already runs.
  it("run the commands on the host with --no-deps, against the running database, so a failing migrate step does not stop them", () => {
    const commands = installDocsCommands(root);
    expect(commands.get("operator-grant")?.text).toBe("docker compose run --rm --no-deps app admin grant <github-login>");
    expect(commands.get("operator-reopen")?.text).toBe("docker compose run --rm --no-deps app admin setup reopen");
    const host = section("Commands on the host").replace(/\s+/g, " ");
    for (const phrase of ["`--no-deps`", "the migrate step", "docker compose up -d postgres"]) expect(host).toContain(phrase);
  });

  it("cover the setup code, the App and the first admin", () => {
    const setup = section("The setup screen").replace(/\s+/g, " ");
    expect(installDocsCommands(root).get("install-setup-code")?.text).toBe("docker compose logs app");
    for (const phrase of ["enter the code", "Create the GitHub App", "Install the App", "Sign in with GitHub", "first admin"]) expect(setup).toContain(phrase);
  });

  it("describe GitHub's modes: a trial URL's App without a webhook, the option, the way back and each step to webhook mode (github-app-reachability 1.11)", () => {
    for (const phrase of [
      "On a trial URL, `http://localhost` with or without a port, the App has no webhook",
      "GitHub runs in polling mode",
      'choose the option "GitHub cannot reach this address"',
      "open `TIEHALL_URL/setup` again in the same browser",
      "under Webhook, make the webhook active, set its URL to `TIEHALL_URL/webhooks/github`, and set a webhook secret",
      "subscribe to the events Pull request, Issues and Organization",
      "store the same webhook secret on the admin page, and confirm it on its review page",
      "Switch GitHub to webhook mode on the admin page",
    ]) {
      expect(flat).toContain(phrase);
    }
  });

  // self-host-install: `TIEHALL_URL` and TLS; finding F1 of the security review of 2026-10-03 (task 26.15).
  it("say that a trial URL shares the install's cookies both ways with every server on localhost, so a trial keeps to a profile of its own and a shared install uses HTTPS", () => {
    const start = section("Start the install").replace(/\s+/g, " ");
    for (const phrase of [
      "On a trial URL, `http://localhost` with or without a port, the browser sends the install's cookies, the setup session's and the web session's, to every server on `localhost`, whatever its port",
      "and lets any of them set or overwrite those cookies",
      "a browser profile that visits no other local server",
      "An install that anyone else uses runs on HTTPS",
    ]) {
      expect(start).toContain(phrase);
    }
  });

  it("name both callback URLs of the App for a move to a new host (github-layer-hardening 1.2)", () => {
    const move = section("Moving the install to a new host").replace(/\s+/g, " ");
    expect(move).toContain("`TIEHALL_URL/api/auth/callback/github`");
    expect(move).toContain("`TIEHALL_URL/setup/sign-in/callback/github`");
  });

  it("cover backups: daily with a cron example, before every upgrade, copied off the host, and .env kept secret and backed up apart", () => {
    const backups = section("Backups").replace(/\s+/g, " ");
    expect(backups).toMatch(/`\d{1,2} \d{1,2} \* \* \* cd \S+ && \.\/backup\.sh[^`]*`/);
    for (const phrase of ["every day", "before every upgrade", "Copy the dumps off the host", "Back up `.env` separately, and keep it secret"]) {
      expect(backups).toContain(phrase);
    }
  });

  it("cover restore, upgrade and rollback", () => {
    const commands = installDocsCommands(root);
    expect(commands.get("backup-restore")?.text).toMatch(/^\.\/restore\.sh backups\//);
    expect(commands.get("upgrade-pull-up")?.text).toBe("docker compose pull && docker compose up -d");
    expect(commands.get("rollback-up")?.text).toBe("docker compose up -d");
    expect(commands.get("rollback-restore")?.text).toMatch(/^\.\/restore\.sh backups\//);
    expect(section("Upgrade")).toContain("TIEHALL_IMAGE");
    expect(section("Rollback").replace(/\s+/g, " ")).toContain("After a contract step has run, the previous image refuses to start");
  });

  // self-host-install: No telemetry and a documented list of outbound connections (decisions-from-groups-15-28:
  // design.md, Decisions this change rests on: D55 (57)). Operators write egress rules by host, so the list names the
  // host the install reads GitHub Actions' keys from, the one the CI caller's check calls, and says what for.
  it("list GitHub Actions' OIDC host, which the CI caller's check reads its keys from", () => {
    const outbound = readFileSync(join(root, "packages/commands/src/outbound.ts"), "utf8");
    const origin = /export const GITHUB_ACTIONS_OIDC_ORIGIN = "([^"]+)";/.exec(outbound)?.[1] ?? "";
    const host = new URL(origin).host;
    expect(host).toBe("token.actions.githubusercontent.com");
    const line = section("What an install connects to")
      .split("\n")
      .find((text) => text.includes(`\`${host}\``));
    expect(line).toBeDefined();
    expect(line).toMatch(/keys that check the tokens of the contract Action's runs/);
  });

  it("list the outbound hosts, which name no model vendor", () => {
    const outbound = section("What an install connects to");
    for (const host of [
      "github.com",
      "api.github.com",
      "token.actions.githubusercontent.com",
      "<name>.atlassian.net",
      "SMTP server",
      "Client ID Metadata Documents",
      "TIEHALL_CLIENT_METADATA_FETCH=off",
    ]) {
      expect(outbound).toContain(host);
    }
    const vendors = [
      "openai",
      "anthropic",
      "claude",
      "gemini",
      "generativelanguage",
      "aiplatform",
      "vertex",
      "bedrock",
      "mistral",
      "cohere",
      "huggingface",
      "replicate",
      "groq",
      "perplexity",
      "together.ai",
      "voyage",
      "cerebras",
      "fal.ai",
      "openrouter",
      "deepseek",
      "ollama",
    ];
    expect(vendors.filter((vendor) => docs.toLowerCase().includes(vendor))).toEqual([]);
  });
});

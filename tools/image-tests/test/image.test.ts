import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { containerState, docker, dockerOk, existingVolumes, processUid, uniqueName, volumesOf, waitFor } from "../src/docker.ts";

// Container tests for the image (task 2.6; self-host-install: Tiehall's
// containers are confined). Every role starts the way an install runs it: a
// read-only root filesystem, a tmpfs /tmp, no capabilities and
// no-new-privileges.

const image = inject("image");

/** The stock Postgres 17 image that the self-host Compose file runs, pinned by digest. */
const POSTGRES_IMAGE = (() => {
  const compose = readFileSync(fileURLToPath(new URL("../../../deploy/compose.yaml", import.meta.url)), "utf8");
  const image = /^\s+image: (postgres:17@sha256:[0-9a-f]{64})$/m.exec(compose)?.[1];
  if (image === undefined) throw new Error("deploy/compose.yaml names no postgres:17 image pinned by digest");
  return image;
})();

const confined = ["--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];

/** The install settings every app role reads, apart from its database connection (self-host-install: One `.env` holds the install settings). */
const install = [
  "--env",
  "TIEHALL_URL=http://localhost:3000",
  "--env",
  `TIEHALL_SECRET_KEY=${randomBytes(32).toString("base64url")}`,
  "--env",
  `TIEHALL_AUTH_SECRET=${randomBytes(32).toString("base64url")}`,
];

/**
 * The lines a role wrote to standard output, each of which must be one JSON
 * object with a time, a level and a message (self-host-install: Logs carry ids,
 * never message text or credentials).
 */
function logLines(stdout: string): { time: string; level: string; msg: string; [field: string]: unknown }[] {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const entry = JSON.parse(line) as { time: string; level: string; msg: string };
      expect(entry).toMatchObject({ time: expect.any(String), level: expect.any(String), msg: expect.any(String) });
      return entry;
    });
}

/** Starts stock Postgres 17 on a network, with a password, and waits until it accepts connections. */
async function startPostgres(network: string, name: string, password: string): Promise<void> {
  dockerOk(["network", "create", network]);
  dockerOk(
    [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      network,
      "--env",
      "POSTGRES_USER=tiehall",
      "--env",
      "POSTGRES_DB=tiehall",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      POSTGRES_IMAGE,
    ],
    300,
  );
  await waitFor(
    "Postgres to accept connections",
    () =>
      docker(["exec", name, "pg_isready", "--host", "127.0.0.1", "--username", "tiehall", "--dbname", "tiehall"]).status === 0
        ? true
        : undefined,
    120,
  );
}

/**
 * Removes Postgres and its network, and checks that nothing of it is left: the
 * image declares its data directory a volume, so each run gets an anonymous one.
 */
function stopPostgres(network: string, name: string): void {
  const volumes = volumesOf(name);
  docker(["rm", "--force", "--volumes", name]);
  docker(["network", "rm", network]);
  expect(existingVolumes(volumes), `volumes that ${name} left behind`).toEqual([]);
}

/**
 * A migrated database for the roles that connect to one: the worker, and all,
 * which runs it. The migrate role installs the job queue's schema, which the
 * worker needs before it starts, and creates the app role they connect as.
 */
const rolesNetwork = uniqueName("tiehall-roles");
const rolesPostgres = uniqueName("postgres-roles");
const rolesPassword = randomBytes(16).toString("hex");
const rolesAppPassword = randomBytes(16).toString("hex");
const appDatabase = [
  "--env",
  `TIEHALL_DATABASE_APP_URL=postgres://tiehall_app@${rolesPostgres}:5432/tiehall`,
  "--env",
  `TIEHALL_DATABASE_APP_PASSWORD=${rolesAppPassword}`,
];
const connected = ["--network", rolesNetwork, ...install, ...appDatabase];

beforeAll(async () => {
  await startPostgres(rolesNetwork, rolesPostgres, rolesPassword);
  const migrate = docker([
    "run",
    "--rm",
    ...confined,
    "--network",
    rolesNetwork,
    "--env",
    `TIEHALL_DATABASE_OWNER_URL=postgres://tiehall@${rolesPostgres}:5432/tiehall`,
    "--env",
    `TIEHALL_DATABASE_OWNER_PASSWORD=${rolesPassword}`,
    ...appDatabase,
    image,
    "migrate",
  ]);
  if (migrate.status !== 0) throw new Error(`The migrate role failed: ${migrate.stdout}${migrate.stderr}`);
  // The roles serve their pages and API only once setup is complete (self-host-install: The setup code guards
  // the setup screen), as the first admin's sign-in on the setup screen leaves the install.
  ownerQuery(rolesPostgres, "INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
}, 300_000);

afterAll(() => {
  stopPostgres(rolesNetwork, rolesPostgres);
});

/** Runs a query as the database owner inside a Postgres container, and returns its rows as text. */
function ownerQuery(postgres: string, query: string): string {
  return dockerOk(["exec", postgres, "psql", "--username", "tiehall", "--dbname", "tiehall", "--tuples-only", "--no-align", "--command", query]);
}

function revision(): string {
  return dockerOk(["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]);
}

/** Starts a role in the background and returns the container name. */
function start(role: string, ...options: string[]): string {
  const name = uniqueName(`tiehall-${role}`);
  dockerOk(["run", "--detach", "--name", name, ...confined, ...options, image, role]);
  return name;
}

function hostPort(name: string): number {
  const mapping = dockerOk(["port", name, "3000/tcp"]).split("\n")[0] ?? "";
  return Number(mapping.slice(mapping.lastIndexOf(":") + 1));
}

async function healthz(port: number): Promise<{ status: number; body: unknown } | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  return { status: response.status, body: await response.json() };
}

/** Sends SIGTERM through `docker stop` and returns the exit code and how long the stop took. */
function stop(name: string): { exitCode: number; seconds: number } {
  const started = Date.now();
  dockerOk(["stop", "--time", "25", name], 60);
  return { exitCode: containerState(name).ExitCode, seconds: (Date.now() - started) / 1000 };
}

/** A write outside /tmp fails; a write inside it works. */
function expectReadOnlyOutsideTmp(name: string): void {
  const write = (path: string) =>
    docker(["exec", name, "node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(path)}, "x")`]);
  const outside = write("/app/probe");
  expect(outside.status).not.toBe(0);
  expect(outside.stderr).toMatch(/EROFS|EACCES/);
  expect(write("/tmp/probe").status).toBe(0);
}

describe("the image", () => {
  it("declares a numeric non-root user and the commit it was built from", () => {
    const user = dockerOk(["image", "inspect", "--format", "{{.Config.User}}", image]);
    expect(user).toMatch(/^\d+:\d+$/);
    expect(Number(user.split(":")[0])).not.toBe(0);
    expect(revision()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("carries its release, which the migrate role records with each migration", () => {
    const label = dockerOk(["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}', image]);
    expect(label).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    const env = dockerOk(["image", "inspect", "--format", "{{json .Config.Env}}", image]);
    expect(JSON.parse(env)).toContain(`TIEHALL_VERSION=${label}`);
  });

  // self-host-install: No telemetry and a documented list of outbound connections.
  it("switches framework telemetry off in the environment every role runs with", () => {
    const env = JSON.parse(dockerOk(["image", "inspect", "--format", "{{json .Config.Env}}", image])) as string[];
    expect(env).toContain("NEXT_TELEMETRY_DISABLED=1");
    const run = docker([
      "run",
      "--rm",
      ...confined,
      "--network",
      "none",
      "--entrypoint",
      "node",
      image,
      "--eval",
      "process.stdout.write(String(process.env.NEXT_TELEMETRY_DISABLED))",
    ]);
    expect(run.stdout).toBe("1");
  });

  it("carries node but no package manager, so nothing at run time can install code", () => {
    const run = docker([
      "run",
      "--rm",
      ...confined,
      "--entrypoint",
      "sh",
      image,
      "-c",
      "for tool in node npm npx corepack yarn yarnpkg pnpm; do command -v $tool || echo no-$tool; done",
    ]);
    expect(run.stdout.trim().split("\n")).toEqual([
      "/usr/local/bin/node",
      "no-npm",
      "no-npx",
      "no-corepack",
      "no-yarn",
      "no-yarnpkg",
      "no-pnpm",
    ]);
  });

  it("exits non-zero on an unknown role, and names the roles it knows", () => {
    const run = docker(["run", "--rm", ...confined, image, "api"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown role "api". Usage: main.mjs <role>, where role is web, worker, migrate, all or init.');
  });

  it("exits non-zero without a role", () => {
    const run = docker(["run", "--rm", ...confined, image]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("No role given.");
  });

  it("refuses to start a role without its settings", () => {
    const run = docker(["run", "--rm", ...confined, image, "web"]);
    expect(run.status).toBe(1);
    expect(logLines(run.stdout)).toContainEqual(
      expect.objectContaining({ level: "error", role: "web", msg: "tiehall web: TIEHALL_URL is not set. Set TIEHALL_URL or TIEHALL_URL_FILE." }),
    );
  });

  // self-host-install: `TIEHALL_URL` and TLS.
  it.each(["http://tiehall.example.com", "http://127.0.0.1:3000"])("refuses to start with TIEHALL_URL=%s, and logs why", (url) => {
    const run = docker(["run", "--rm", ...confined, ...install, ...appDatabase, "--env", `TIEHALL_URL=${url}`, image, "web"]);
    expect(run.status).toBe(1);
    expect(logLines(run.stdout)).toEqual([
      expect.objectContaining({
        level: "error",
        role: "web",
        msg: "tiehall web: TIEHALL_URL must be an https:// URL, or http://localhost with or without a port for a trial on one machine.",
      }),
    ]);
  });
});

/** The NAME=value lines of a .env file. */
function envValues(text: string): Map<string, string> {
  return new Map(
    text
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
  );
}

// self-host-install: `init` prints a complete `.env`.
describe("the init role", () => {
  /** Runs init as `docker run --rm <image> init --url <url>` does, with no network. */
  function init() {
    return docker(["run", "--rm", ...confined, "--network", "none", image, "init", "--url", "https://tiehall.example.com"]);
  }

  it("prints a complete .env with fresh secrets on standard output, and nothing else", () => {
    const first = init();
    const second = init();
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const values = envValues(first.stdout);
    expect(values.get("TIEHALL_URL")).toBe("https://tiehall.example.com");
    const name = JSON.parse(dockerOk(["image", "inspect", "--format", "{{json .Config.Env}}", image]))
      .find((entry: string) => entry.startsWith("TIEHALL_IMAGE_NAME="))
      ?.slice("TIEHALL_IMAGE_NAME=".length);
    expect(values.get("TIEHALL_IMAGE")).toBe(`${name}:sha-${revision()}`);
    for (const secret of ["TIEHALL_DATABASE_OWNER_PASSWORD", "TIEHALL_DATABASE_APP_PASSWORD", "TIEHALL_SECRET_KEY", "TIEHALL_AUTH_SECRET"]) {
      const value = values.get(secret) ?? "";
      expect(value, secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.stdout, secret).not.toContain(value);
    }
  });

  it("refuses a URL the install would refuse, printing nothing on standard output", () => {
    const run = docker(["run", "--rm", ...confined, "--network", "none", image, "init", "--url", "http://tiehall.example.com"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("tiehall init: TIEHALL_URL must be an https:// URL");
  });
});

describe.each(["web", "all"])("the %s role", (role) => {
  let name: string;
  let port: number;

  beforeAll(async () => {
    name = start(role, ...connected, "--publish", "127.0.0.1::3000");
    port = hostPort(name);
    await waitFor(`/healthz of ${role}`, () => healthz(port));
  });

  afterAll(() => {
    docker(["rm", "--force", name]);
  });

  it("serves /healthz as up", async () => {
    expect(await healthz(port)).toEqual({ status: 200, body: { status: "up" } });
  });

  it("runs as a non-root uid", () => {
    expect(processUid(name)).not.toBe(0);
    expect(dockerOk(["logs", name])).toMatch(new RegExp(`tiehall ${role}: starting as uid [1-9]\\d*`));
  });

  // self-host-install: Logs carry ids, never message text or credentials. Next.js prints its version, its
  // addresses and "Ready" at start; they reach standard output as JSON lines like every other.
  it("writes only JSON lines on standard output, what Next.js prints at start included", () => {
    const entries = logLines(docker(["logs", name]).stdout);
    expect(entries).toContainEqual(expect.objectContaining({ msg: expect.stringMatching(/^▲ Next\.js \d+\.\d+\.\d+$/), via: "console" }));
    expect(entries).toContainEqual(expect.objectContaining({ msg: expect.stringMatching(/^✓ Ready in /), via: "console" }));
  });

  it("cannot write outside /tmp", () => {
    expectReadOnlyOutsideTmp(name);
  });

  it("tags its pages with the commit as the deployment id", async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain(`data-dpl-id="${revision()}"`);
  });

  // public-api: Operations not offered on REST answer 404; public-api: Errors are RFC 9457 problem details.
  it("answers a path under /api/v1 that serves no operation with 404 as an RFC 9457 problem", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/no-such-operation`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 404, title: expect.any(String), type: expect.any(String) });
  });

  // self-host-install: Logs carry ids, never message text or credentials.
  it("logs neither the body nor the token of a failing REST request, nor its query string", async () => {
    const text = `Please rotate the staging keys; canary-${randomBytes(8).toString("hex")}`;
    const token = `th_pat_${randomBytes(20).toString("hex")}`;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/probes/FE-142/messages?token=${token}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ body: text }),
    });
    expect(response.status).toBe(404);
    const logs = docker(["logs", name]);
    const all = `${logs.stdout}${logs.stderr}`;
    for (const canary of [text, "canary-", token, token.slice("th_pat_".length), "token="]) expect(all).not.toContain(canary);
  });

  // public-api: Every install serves the OpenAPI 3.1 document without authentication.
  it("serves /api/v1/openapi.json without authentication, as the committed document", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/openapi.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(readFileSync(new URL("../../../openapi/v1.json", import.meta.url), "utf8"));
  });

  // public-api: The API reference page at `/docs/api`.
  it("serves the API reference page and its scripts itself, with a strict Content-Security-Policy", async () => {
    const page = await fetch(`http://127.0.0.1:${port}/docs/api`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/^default-src 'none'; script-src 'nonce-[^']+';/);
    const sources = [...(await page.text()).matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(([, source]) => source);
    expect(sources).toEqual(["/docs/api/reference.js", "/docs/api/scalar.js"]);
    for (const source of sources) {
      const script = await fetch(`http://127.0.0.1:${port}${source}`);
      expect(script.status, source).toBe(200);
      expect(script.headers.get("content-type"), source).toBe("text/javascript; charset=utf-8");
      expect((await script.text()).length, source).toBeGreaterThan(0);
    }
  });

  // public-api: The API reference page at `/docs/api`. The browser tests in apps/web serve the page's handlers
  // from a local server; this one reads the page from the image, through the real Next.js route, in the
  // installed Google Chrome (TIEHALL_TEST_CHROME names another Chromium-based executable).
  it("renders the API reference page for an anonymous browser, loading nothing from another host", async () => {
    const executablePath = process.env["TIEHALL_TEST_CHROME"];
    const browser = await chromium.launch(executablePath === undefined ? { channel: "chrome" } : { executablePath });
    try {
      const page = await (await browser.newContext()).newPage();
      const origin = `http://127.0.0.1:${port}`;
      const loaded: string[] = [];
      page.on("request", (request) => loaded.push(`${request.method()} ${request.url()}`));
      await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { cspViolations: string[] }).cspViolations = seen;
        document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
      });
      const response = await page.goto(`${origin}/docs/api`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"]).toMatch(/^default-src 'none'; script-src 'nonce-[^']+';/);
      await page.getByText("Tiehall API").first().waitFor({ timeout: 30_000 });
      await page.waitForLoadState("networkidle");
      // Not sent to sign in: still on the page, which may add a fragment for the section in view.
      expect(new URL(page.url()).pathname).toBe("/docs/api");
      expect(loaded.filter((request) => !request.startsWith(`GET ${origin}/`) && !request.startsWith("GET data:"))).toEqual([]);
      expect(loaded).toContain(`GET ${origin}/api/v1/openapi.json`);
      expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
      const controls = await page.evaluate(() =>
        [...document.querySelectorAll("button, a, [role=button], input, textarea")]
          .filter((element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
          .map((element) => `${(element.textContent ?? "").trim()} ${element.getAttribute("aria-label") ?? ""}`),
      );
      expect(controls.filter((control) => /test request|send|try it|api client|run request/i.test(control))).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  // public-api: The changelog page and the release notes.
  it("serves the API changelog page without authentication, running no script", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/docs/api/changelog`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toMatch(/^default-src 'none'; style-src 'sha256-/);
    const html = await response.text();
    expect(html).toContain("<h1>API changelog</h1>");
    expect(html).not.toContain("<script");
  });

  if (role === "all") {
    it("runs the worker beside the web server", () => {
      const logs = dockerOk(["logs", name]);
      expect(logs).toMatch(/tiehall web: starting as uid/);
      expect(logs).toMatch(/tiehall worker: starting as uid/);
    });
  }

  it("stops on SIGTERM within the grace period", () => {
    const { exitCode, seconds } = stop(name);
    expect([0, 143]).toContain(exitCode);
    expect(seconds).toBeLessThan(20);
  });
});

// self-host-install: `/healthz` answers only up or down.
describe("/healthz", () => {
  const network = uniqueName("tiehall-healthz");
  const database = uniqueName("postgres-healthz");
  const ownerPassword = randomBytes(16).toString("hex");
  const appPassword = randomBytes(16).toString("hex");
  const appDatabase = [
    "--env",
    `TIEHALL_DATABASE_APP_URL=postgres://tiehall_app@${database}:5432/tiehall`,
    "--env",
    `TIEHALL_DATABASE_APP_PASSWORD=${appPassword}`,
  ];
  let name: string;
  let port: number;

  beforeAll(async () => {
    await startPostgres(network, database, ownerPassword);
    const migrate = docker([
      "run",
      "--rm",
      ...confined,
      "--network",
      network,
      "--env",
      `TIEHALL_DATABASE_OWNER_URL=postgres://tiehall@${database}:5432/tiehall`,
      "--env",
      `TIEHALL_DATABASE_OWNER_PASSWORD=${ownerPassword}`,
      ...appDatabase,
      image,
      "migrate",
    ]);
    if (migrate.status !== 0) throw new Error(`The migrate role failed: ${migrate.stdout}${migrate.stderr}`);
    name = start("web", "--network", network, ...install, ...appDatabase, "--publish", "127.0.0.1::3000");
    port = hostPort(name);
    await waitFor("/healthz of web", () => healthz(port));
  }, 300_000);

  afterAll(() => {
    docker(["rm", "--force", name]);
    stopPostgres(network, database);
  });

  it("answers up without authentication while the database is reachable, and shows nothing else", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"up"}');
    const headers = [...response.headers].map(([header, value]) => `${header}: ${value}`).join("\n");
    expect(headers).not.toMatch(/x-powered-by|next\.js/i);
    expect(headers).not.toContain(revision());
  });

  // self-host-install: The setup code guards the setup screen. This database has no org yet, as a new install.
  it("before setup, leads pages to /setup and answers API calls with 503 setup-required, the OpenAPI document included", async () => {
    for (const path of ["/", "/FE-142", "/docs/api"]) {
      const page = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
      expect(page.status, path).toBe(307);
      expect(page.headers.get("location"), path).toBe("http://localhost:3000/setup");
    }
    for (const [method, path] of [
      ["GET", "/api/v1/openapi.json"],
      ["POST", "/api/v1/requests"],
      ["POST", "/webhooks/github"],
    ] as const) {
      const call = await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(call.status, path).toBe(503);
      expect(call.headers.get("content-type"), path).toBe("application/problem+json");
      expect(await call.json(), path).toMatchObject({ type: "https://tiehall.com/problems/setup-required", status: 503 });
    }
    expect(await healthz(port)).toEqual({ status: 200, body: { status: "up" } });
    expect(ownerQuery(database, "SELECT count(*) FROM orgs WHERE setup_completed_at IS NOT NULL")).toBe("0");
  });

  it("answers down while the database is stopped, and up once it is back", async () => {
    dockerOk(["stop", database], 60);
    try {
      const down = await waitFor("/healthz to answer down", async () => {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        return response.status === 503 ? { status: response.status, body: await response.text() } : undefined;
      });
      expect(down).toEqual({ status: 503, body: '{"status":"down"}' });
    } finally {
      dockerOk(["start", database], 60);
    }
    await waitFor("/healthz to answer up", async () => ((await healthz(port))?.status === 200 ? true : undefined), 120);
    expect(await healthz(port)).toEqual({ status: 200, body: { status: "up" } });
  });

  // self-host-install: A restart stops the app gracefully. A /healthz call to a paused database stays in
  // flight until its timeout, which holds the stopping web role open while a new call arrives.
  it("answers a call during shutdown with 503 and Retry-After: 0, lets the call in flight finish, and exits 0", async () => {
    const stopping = start("web", "--network", network, ...install, ...appDatabase, "--publish", "127.0.0.1::3000");
    const stoppingPort = hostPort(stopping);
    try {
      await waitFor("/healthz of the web role to stop", () => healthz(stoppingPort));
      dockerOk(["pause", database]);
      try {
        const inFlight = fetch(`http://127.0.0.1:${stoppingPort}/healthz`).then(async (response) => ({
          status: response.status,
          body: await response.text(),
        }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        dockerOk(["kill", "--signal", "SIGTERM", stopping]);
        await waitFor("the web role to start stopping", () => (/web: stopping/.test(dockerOk(["logs", stopping])) ? true : undefined));
        const during = await fetch(`http://127.0.0.1:${stoppingPort}/`);
        expect(during.status).toBe(503);
        expect(during.headers.get("retry-after")).toBe("0");
        expect(during.headers.get("content-type")).toBe("application/problem+json");
        expect(await during.json()).toMatchObject({ type: "https://tiehall.com/problems/shutting-down", status: 503 });
        expect(await inFlight).toEqual({ status: 503, body: '{"status":"down"}' });
      } finally {
        dockerOk(["unpause", database]);
      }
      await waitFor("the web role to exit", () => (containerState(stopping).Running ? undefined : true));
      expect(containerState(stopping).ExitCode).toBe(0);
      // Tiehall's own lines; the Next.js server also prints its start banner as plain text.
      const tiehallLines = dockerOk(["logs", stopping])
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .join("\n");
      expect(logLines(tiehallLines).map(({ msg }) => msg)).toEqual(
        expect.arrayContaining(["web: stopping; new calls get 503 until the 1 call in flight finishes", "web: stopped"]),
      );
    } finally {
      docker(["rm", "--force", stopping]);
    }
  });
});

describe("the worker role", () => {
  let name: string;

  beforeAll(async () => {
    name = start("worker", ...connected);
    await waitFor("the worker to start", () => (/worker: started/.test(dockerOk(["logs", name])) ? true : undefined));
  });

  afterAll(() => {
    docker(["rm", "--force", name]);
  });

  it("keeps running", () => {
    expect(containerState(name).Running).toBe(true);
  });

  it("runs as a non-root uid", () => {
    expect(processUid(name)).not.toBe(0);
  });

  it("cannot write outside /tmp", () => {
    expectReadOnlyOutsideTmp(name);
  });

  it("stops on SIGTERM within the grace period, letting go of the job queue", () => {
    const { exitCode, seconds } = stop(name);
    expect(exitCode).toBe(0);
    expect(seconds).toBeLessThan(20);
    const logs = docker(["logs", name]);
    expect(logLines(logs.stdout).map(({ msg }) => msg)).toEqual([
      expect.stringMatching(/^tiehall worker: starting as uid [1-9]\d*/),
      expect.stringMatching(/^worker: started, working \d+ queues?$/),
      "worker: stopped",
    ]);
  });
});

describe("the migrate role", () => {
  const network = uniqueName("tiehall-image-tests");
  const database = uniqueName("postgres");
  let secrets: string;

  beforeAll(async () => {
    secrets = mkdtempSync(join(tmpdir(), "tiehall-image-tests-"));
    for (const [file, value] of [
      ["database_password", "correct-horse-battery-staple\n"],
      ["wrong_password", "not-the-password\n"],
      ["app_database_password", "app-role-password\n"],
    ] as const) {
      writeFileSync(join(secrets, file), value);
      chmodSync(join(secrets, file), 0o644);
    }
    await startPostgres(network, database, "correct-horse-battery-staple");
  });

  afterAll(() => {
    stopPostgres(network, database);
    rmSync(secrets, { recursive: true, force: true });
  });

  /**
   * Runs the migrate role to completion with the owner's password and the app
   * role's password in files, and returns the result.
   */
  function migrate(passwordFile: string) {
    return docker([
      "run",
      "--rm",
      ...confined,
      "--network",
      network,
      "--env",
      `TIEHALL_DATABASE_OWNER_URL=postgres://tiehall@${database}:5432/tiehall`,
      "--env",
      "TIEHALL_DATABASE_OWNER_PASSWORD_FILE=/run/secrets/database_password",
      "--volume",
      `${join(secrets, passwordFile)}:/run/secrets/database_password:ro`,
      "--env",
      `TIEHALL_DATABASE_APP_URL=postgres://tiehall_app@${database}:5432/tiehall`,
      "--env",
      "TIEHALL_DATABASE_APP_PASSWORD_FILE=/run/secrets/app_database_password",
      "--volume",
      `${join(secrets, "app_database_password")}:/run/secrets/app_database_password:ro`,
      image,
      "migrate",
    ]);
  }

  /** Runs a query over the network as a user with a password, from a psql client in its own container. */
  function psql(user: string, password: string, query: string) {
    return docker([
      "run",
      "--rm",
      "--network",
      network,
      "--env",
      `PGPASSWORD=${password}`,
      POSTGRES_IMAGE,
      "psql",
      "--host",
      database,
      "--username",
      user,
      "--dbname",
      "tiehall",
      "--tuples-only",
      "--no-align",
      "--command",
      query,
    ]);
  }

  it("connects to Postgres 17 with the password from its secret file, as a non-root uid, and exits 0", () => {
    const run = migrate("database_password");
    expect(run.stdout).not.toContain("tiehall migrate: failed");
    expect(run.stdout).toMatch(/tiehall migrate: starting as uid [1-9]\d*/);
    // self-host-install: Logs carry ids, never message text or credentials. Every line is JSON on standard output.
    expect(logLines(run.stdout).map(({ msg }) => msg)).toContain("tiehall migrate: done");
    expect(run.status).toBe(0);
  });

  it("applies the repository's migrations, which the image carries", () => {
    const journal = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../packages/db/migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ) as { entries: { tag: string }[] };
    const applied = psql("tiehall", "correct-horse-battery-staple", "SELECT id FROM tiehall_migrate.applied_migrations ORDER BY id");
    expect(applied.stderr).toBe("");
    expect(applied.stdout.split("\n").filter((line) => line !== "")).toEqual(journal.entries.map(({ tag }) => tag).sort());
    const again = migrate("database_password");
    expect(again.stdout).toContain("tiehall migrate: the schema is up to date");
    expect(again.status).toBe(0);
  });

  it("creates the app role that TIEHALL_DATABASE_APP_URL names, with the password from its secret file", () => {
    const run = migrate("database_password");
    expect(run.stdout).not.toContain("tiehall migrate: failed");
    expect(run.status).toBe(0);
    expect(run.stderr + run.stdout).not.toContain("app-role-password");

    const login = psql("tiehall_app", "app-role-password", "SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user");
    expect(login.stdout.trim()).toBe("tiehall_app|f");
    expect(psql("tiehall", "app-role-password", "SELECT 1").stderr).toContain("password authentication failed");
  });

  it("exits non-zero when the database refuses it", () => {
    const run = migrate("wrong_password");
    expect(run.status).toBe(1);
    expect(logLines(run.stdout)).toContainEqual(
      expect.objectContaining({ level: "error", msg: expect.stringContaining("password authentication failed") }),
    );
    expect(run.stderr + run.stdout).not.toContain("not-the-password");
  });
});

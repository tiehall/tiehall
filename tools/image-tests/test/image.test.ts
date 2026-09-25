import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { containerState, docker, dockerOk, processUid, uniqueName, waitFor } from "../src/docker.ts";

// Container tests for the image (task 2.7; operations: Production runs the
// self-host Compose file and image). Every role starts the way production runs
// it: a read-only root filesystem, a tmpfs /tmp, no capabilities and
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
/** A database URL for roles that do not connect yet; every role requires one. */
const unusedDatabase = ["--env", "DATABASE_URL=postgres://tiehall@database.invalid:5432/tiehall"];

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
    const run = docker(["run", "--rm", ...confined, ...unusedDatabase, image, "api"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown role "api". Usage: main.mjs <role>, where role is web, worker, migrate or all.');
  });

  it("exits non-zero without a role", () => {
    const run = docker(["run", "--rm", ...confined, ...unusedDatabase, image]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("No role given.");
  });

  it("refuses to start a role without its configuration", () => {
    const run = docker(["run", "--rm", ...confined, image, "web"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("DATABASE_URL is not set. Set DATABASE_URL or DATABASE_URL_FILE.");
  });
});

describe.each(["web", "all"])("the %s role", (role) => {
  let name: string;
  let port: number;

  beforeAll(async () => {
    name = start(role, ...unusedDatabase, "--publish", "127.0.0.1::3000");
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

  it("cannot write outside /tmp", () => {
    expectReadOnlyOutsideTmp(name);
  });

  it("tags its pages with the commit as the deployment id", async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain(`data-dpl-id="${revision()}"`);
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

describe("the worker role", () => {
  let name: string;

  beforeAll(async () => {
    name = start("worker", ...unusedDatabase);
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

  it("stops on SIGTERM within the grace period", () => {
    const { exitCode, seconds } = stop(name);
    expect(exitCode).toBe(0);
    expect(seconds).toBeLessThan(20);
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
    dockerOk(["network", "create", network]);
    dockerOk([
      "run",
      "--detach",
      "--name",
      database,
      "--network",
      network,
      "--env",
      "POSTGRES_USER=tiehall",
      "--env",
      "POSTGRES_DB=tiehall",
      "--env",
      "POSTGRES_PASSWORD=correct-horse-battery-staple",
      POSTGRES_IMAGE,
    ], 300);
    await waitFor("Postgres to accept connections", () =>
      docker(["exec", database, "pg_isready", "--host", "127.0.0.1", "--username", "tiehall", "--dbname", "tiehall"]).status === 0
        ? true
        : undefined,
    120);
  });

  afterAll(() => {
    docker(["rm", "--force", database]);
    docker(["network", "rm", network]);
    rmSync(secrets, { recursive: true, force: true });
  });

  /** Runs the migrate role to completion with a password file and returns the result. */
  function migrate(passwordFile: string, ...options: string[]) {
    return docker([
      "run",
      "--rm",
      ...confined,
      "--network",
      network,
      "--env",
      `DATABASE_URL=postgres://tiehall@${database}:5432/tiehall`,
      "--env",
      "DATABASE_PASSWORD_FILE=/run/secrets/database_password",
      "--volume",
      `${join(secrets, passwordFile)}:/run/secrets/database_password:ro`,
      ...options,
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
    expect(run.stderr).not.toContain("tiehall migrate: failed");
    expect(run.stdout).toMatch(/tiehall migrate: starting as uid [1-9]\d*/);
    expect(run.status).toBe(0);
  });

  it("creates the app role that APP_DATABASE_URL names, with the password from its secret file", () => {
    const run = migrate(
      "database_password",
      "--env",
      `APP_DATABASE_URL=postgres://tiehall_app@${database}:5432/tiehall`,
      "--env",
      "APP_DATABASE_PASSWORD_FILE=/run/secrets/app_database_password",
      "--volume",
      `${join(secrets, "app_database_password")}:/run/secrets/app_database_password:ro`,
    );
    expect(run.stderr).not.toContain("tiehall migrate: failed");
    expect(run.status).toBe(0);
    expect(run.stderr + run.stdout).not.toContain("app-role-password");

    const login = psql("tiehall_app", "app-role-password", "SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user");
    expect(login.stdout.trim()).toBe("tiehall_app|f");
    expect(psql("tiehall", "app-role-password", "SELECT 1").stderr).toContain("password authentication failed");
  });

  it("exits non-zero when the database refuses it", () => {
    const run = migrate("wrong_password");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("password authentication failed");
    expect(run.stderr + run.stdout).not.toContain("not-the-password");
  });
});

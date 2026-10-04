import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformFlags, waitFor, type Run } from "./docker.ts";

// A self-hosted install for the operator tests (self-host-install: Compose runs
// Tiehall and Postgres; self-host-install: Backups with the shipped scripts;
// self-host-install: Upgrades apply migrations before the app starts): a
// folder that holds what a release publishes (compose.yaml, the Caddyfile,
// backup.sh and restore.sh) and the .env the image's init role prints, as an
// operator's install folder does, under a Compose project name of its own.
// Commands run in that folder as an operator runs them, with nothing of the
// shell running the test that names Tiehall or Compose, except the project's
// name, so several installs can run side by side and none meets another's.
// On a host whose platform is not the image's, such as CI's linux/amd64 image
// on an arm64 laptop, Compose needs the image's platform to pull such an image
// from a registry: a Compose file of the tests' own, outside the folder, asks
// for it for Tiehall's own services alone, so Postgres, Caddy and every other
// service keep the host's platform.

const DEPLOY = fileURLToPath(new URL("../../../deploy/", import.meta.url));

/** The files a release publishes next to the .env that init prints. */
export const RELEASE_FILES = ["compose.yaml", "Caddyfile", "backup.sh", "restore.sh"] as const;

/** A port on 127.0.0.1 that nothing listens on now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export interface InstallOptions {
  /** The image init runs from, and the install runs: init pins it with --image. */
  image: string;
  /** The port the app is published on, on 127.0.0.1; a free one unless given. */
  port?: number;
  /** A prefix for the Compose project's name. */
  name?: string;
}

/** A Compose file of the tests' own, outside every install's folder, that asks for this platform for Tiehall's own services alone. */
function platformFile(platform: string): string {
  const file = join(tmpdir(), `tiehall-image-tests-platform-${platform.replace(/[^A-Za-z0-9]+/g, "-")}.yaml`);
  writeFileSync(
    file,
    ["# Written by the image tests (tools/image-tests/src/install.ts).", "services:", "  migrate:", `    platform: ${platform}`, "  app:", `    platform: ${platform}`, ""].join("\n"),
  );
  return file;
}

export class Install {
  /** The install's folder: the release files and .env. */
  readonly dir: string;
  /** The Compose project's name. */
  readonly project: string;
  /** The port the app is published on, on 127.0.0.1. */
  readonly port: number;
  /** TIEHALL_URL: http://localhost and the port, a trial URL on one machine. */
  readonly url: string;
  /** The platform of the image the install was created with, when it is not the host's. */
  private platform: string | undefined;

  private constructor(dir: string, project: string, port: number) {
    this.dir = dir;
    this.project = project;
    this.port = port;
    this.url = `http://localhost:${port}`;
  }

  /**
   * A new install folder: the release files, and the .env that
   * `docker run --rm <image> init --url <url> --image <image>` prints, with
   * the app published on the install's own port. Nothing runs yet.
   */
  static async create(options: InstallOptions): Promise<Install> {
    const install = await Install.empty(options);
    install.platform = platformFlags(options.image)[1];
    try {
      for (const file of RELEASE_FILES) copyFileSync(join(DEPLOY, file), join(install.dir, file));
      const init = install.shell(`docker run --rm --network none ${quote(options.image)} init --url ${quote(install.url)} --image ${quote(options.image)} > .env`);
      if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
      install.publishOnItsPort();
      return install;
    } catch (error) {
      rmSync(install.dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** A new, empty install folder, for a test that fills it as the docs say; its URL is http://localhost and its own port. */
  static async empty(options: Pick<InstallOptions, "port" | "name">): Promise<Install> {
    const port = options.port ?? (await freePort());
    const project = `${options.name ?? "tiehall-install"}-${randomBytes(4).toString("hex")}`;
    return new Install(mkdtempSync(join(tmpdir(), `${project}-`)), project, port);
  }

  /** Publishes the app on the install's own port, which init's 127.0.0.1:3000 may not be free for, as an operator changes it in .env. */
  publishOnItsPort(): void {
    this.setEnv("TIEHALL_HTTP_BIND", `127.0.0.1:${this.port}`);
  }

  /**
   * The environment every command of the install runs with: the Compose project's name, and nothing else of Tiehall or
   * Compose, but for an image whose platform is not the host's, the Compose files to read: the folder's own, then the
   * tests' file that asks for the image's platform for Tiehall's services.
   */
  environment(): Record<string, string> {
    const env: Record<string, string> = { COMPOSE_PROJECT_NAME: this.project };
    if (this.platform !== undefined && existsSync(join(this.dir, "compose.yaml"))) {
      const own = ["compose.yaml", "compose.override.yaml"].map((name) => join(this.dir, name)).filter((file) => existsSync(file));
      env["COMPOSE_FILE"] = [...own, platformFile(this.platform)].join(":");
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !name.startsWith("TIEHALL_") && !name.startsWith("COMPOSE_")) env[name] ??= value;
    }
    return env;
  }

  /** Runs a shell command in the install's folder, as an operator types it there. */
  shell(command: string, options: { timeoutSeconds?: number; input?: string | Buffer } = {}): Run {
    const run = spawnSync("bash", ["-c", command], {
      cwd: this.dir,
      env: this.environment(),
      encoding: "utf8",
      timeout: (options.timeoutSeconds ?? 300) * 1000,
      maxBuffer: 64 * 1024 * 1024,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    if (run.error) throw run.error;
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  /**
   * Runs a shell command in the install's folder without holding up this
   * process, for a command that reaches a server of the test itself, such as
   * one that downloads the release files from it.
   */
  shellAsync(command: string, options: { timeoutSeconds?: number } = {}): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", command], { cwd: this.dir, env: this.environment(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), (options.timeoutSeconds ?? 300) * 1000);
      child.on("error", reject);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }

  /** Runs `docker compose` in the install's folder. */
  compose(args: string[], options: { timeoutSeconds?: number } = {}): Run {
    return this.shell(["docker", "compose", ...args].map(quote).join(" "), options);
  }

  /** `docker compose up -d --wait`: every service up and healthy, or it throws with the stack's state and logs. */
  up(extra: string[] = []): void {
    const up = this.compose(["up", "--detach", "--wait", "--wait-timeout", "240", ...extra], { timeoutSeconds: 300 });
    if (up.status !== 0) throw new Error(`docker compose up failed:\n${up.stderr}\n${this.describe()}`);
  }

  /** The stack's state and logs, for a failure's message. */
  describe(): string {
    return `${this.compose(["ps", "--all"]).stdout}\n${this.compose(["logs", "--no-color"]).stdout}`;
  }

  /** A service's log. */
  logs(service: string): string {
    return this.compose(["logs", "--no-color", "--no-log-prefix", service]).stdout;
  }

  /** Runs SQL as the database owner in the bundled Postgres, and returns its rows as text, one per line. */
  sql(query: string): string {
    const run = this.shell(
      "docker compose exec -T postgres psql --username tiehall --dbname tiehall --tuples-only --no-align --quiet -v ON_ERROR_STOP=1",
      { input: query },
    );
    if (run.status !== 0) throw new Error(`psql failed: ${run.stderr}`);
    return run.stdout.trim();
  }

  /** A setting of the install's .env. */
  readEnv(name: string): string | undefined {
    const line = readFileSync(join(this.dir, ".env"), "utf8")
      .split("\n")
      .find((entry) => entry.startsWith(`${name}=`));
    return line?.slice(name.length + 1);
  }

  /** Sets a setting of the install's .env, as an operator edits it. */
  setEnv(name: string, value: string): void {
    const file = join(this.dir, ".env");
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at === -1) lines.push(`${name}=${value}`);
    else lines[at] = `${name}=${value}`;
    writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  }

  /** A request to the app, on its published port, as a client on the host sends it. */
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${path}`, init);
  }

  /** Waits until the app answers /healthz with "up". */
  async healthy(): Promise<void> {
    await waitFor(
      "the app's /healthz",
      async () => ((await this.fetch("/healthz").catch(() => undefined))?.ok === true ? true : undefined),
      240,
    );
  }

  /** Stops the stack and removes it with its volumes, and the folder. */
  destroy(): void {
    this.compose(["--profile", "caddy", "down", "--volumes", "--remove-orphans", "--timeout", "10"], { timeoutSeconds: 120 });
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A word for bash, quoted. */
export function quote(word: string): string {
  return /^[A-Za-z0-9_./:@=,+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** What seeded an install: a member's personal access token and the request opened with it. */
export interface Seeded {
  token: string;
  requestKey: string;
  requestTitle: string;
}

/**
 * Data for an install whose setup the test completes by SQL, as its first
 * admin's sign-in leaves it, and a request opened through /api/v1: the company
 * Acme, Dana its admin in the team BE, the team FE, and a personal access token
 * of Dana's, with which a request is opened from BE to FE.
 */
export async function seed(install: Install): Promise<Seeded> {
  const token = `th_pat_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  install.sql(`
    UPDATE orgs SET name = 'Acme', setup_completed_at = now();
    DELETE FROM setup_codes;
    INSERT INTO users (org_id, id, github_account_id, github_login, sign_in_key)
      SELECT id, '5c1c1b5e-0d6e-4c52-9d0f-3a3c8f2b7a01', 4242, 'dana', 'github:4242' FROM orgs;
    INSERT INTO members (org_id, user_id, role) SELECT id, '5c1c1b5e-0d6e-4c52-9d0f-3a3c8f2b7a01', 'admin' FROM orgs;
    INSERT INTO teams (org_id, key, name) SELECT id, 'FE', 'Frontend' FROM orgs;
    INSERT INTO teams (org_id, key, name) SELECT id, 'BE', 'Backend' FROM orgs;
    INSERT INTO team_members (org_id, team_id, user_id)
      SELECT t.org_id, t.id, '5c1c1b5e-0d6e-4c52-9d0f-3a3c8f2b7a01' FROM teams t WHERE t.key = 'BE';
    INSERT INTO personal_access_tokens (org_id, user_id, name, scopes, token_hash, created_at, expires_at)
      SELECT id, '5c1c1b5e-0d6e-4c52-9d0f-3a3c8f2b7a01', 'operator tests', ARRAY['requests:read', 'requests:write'], '${hash}', now(), now() + interval '30 days' FROM orgs;
  `);
  const requestTitle = "Show the invoice total on the order page";
  const key = await openRequest(install, token, requestTitle);
  return { token, requestKey: key, requestTitle };
}

/** Opens a request from BE to FE through /api/v1 with a personal access token, and returns its key. */
export async function openRequest(install: Install, token: string, title: string): Promise<string> {
  const answer = await install.fetch("/api/v1/requests", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      targetTeam: "FE",
      requestingTeam: "BE",
      title,
      packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "Expose the invoice total in the orders API." } },
    }),
  });
  const body = (await answer.json()) as { key?: string };
  if (answer.status !== 200 || typeof body.key !== "string") throw new Error(`opening a request answered ${answer.status}: ${JSON.stringify(body)}`);
  return body.key;
}

/** Reads a request through /api/v1 with a personal access token: its status and title. */
export async function readRequest(install: Install, token: string, key: string): Promise<{ status: number; title?: string }> {
  const answer = await install.fetch(`/api/v1/requests/${key}`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await answer.json()) as { untrusted?: { title?: unknown } };
  const title = body.untrusted?.title;
  return typeof title === "string" ? { status: answer.status, title } : { status: answer.status };
}

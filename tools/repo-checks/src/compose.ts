import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Reads Compose files the way Docker Compose itself does: `docker compose
// config` merges the files, resolves `extends`, `!override` and `!reset`,
// interpolates variables and applies profiles. The checks read that model, so
// they see exactly what `docker compose up` would run.

export type ComposeModel = {
  name: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
  secrets?: Record<string, { file?: string; environment?: string }>;
};

export type ComposeService = Record<string, unknown> & {
  command?: string[];
  image?: string;
  ports?: unknown[];
  secrets?: { source: string; target?: string }[];
  networks?: Record<string, unknown>;
};

/** Stand-ins for the variables an install sets, so the files can be read anywhere. */
export const EXAMPLE_ENVIRONMENT = {
  TIEHALL_IMAGE: `ghcr.io/example/tiehall@sha256:${"0".repeat(64)}`,
};

export interface ComposeResult {
  status: number | null;
  stderr: string;
  model?: ComposeModel;
}

export interface ComposeConfigOptions {
  profiles?: string[];
  cwd?: string;
  /** A .env file to read the settings from, as an install does; without one, only the example variables. */
  envFile?: string;
}

/** Runs `docker compose config` over the files, with the example variables or an env file, and the given profiles. */
export function composeConfig(files: string[], options: ComposeConfigOptions = {}): ComposeResult {
  const args = ["compose", ...files.flatMap((file) => ["--file", file])];
  for (const profile of options.profiles ?? []) args.push("--profile", profile);
  // Without an env file, --env-file /dev/null keeps Compose from reading a .env beside the files.
  args.push("--env-file", options.envFile ?? "/dev/null");
  args.push("config", "--format", "json");
  // No inherited settings and no COMPOSE_* variables: only the env file's, or the example variables.
  const env: Record<string, string> = options.envFile === undefined ? { ...EXAMPLE_ENVIRONMENT } : {};
  for (const name of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const run = spawnSync("docker", args, { cwd: options.cwd ?? join(files[0] ?? ".", ".."), encoding: "utf8", env });
  if (run.error) throw run.error;
  if (run.status !== 0) return { status: run.status, stderr: run.stderr };
  return { status: 0, stderr: run.stderr, model: JSON.parse(run.stdout) as ComposeModel };
}

/** The role a service runs: the first word of its command, for the Tiehall image's services. */
export function roleOf(service: ComposeService): string | undefined {
  return Array.isArray(service.command) ? service.command[0] : undefined;
}

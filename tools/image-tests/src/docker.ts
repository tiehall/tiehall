import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The environment variable in which the global setup names the platform of
 * each image under test that does not run on the host's own, as JSON that
 * maps the image to its platform, such as linux/amd64 for the image CI
 * builds on an arm64 host.
 */
export const IMAGE_PLATFORMS = "TIEHALL_TEST_IMAGE_PLATFORMS";

/** The images under test that run on another platform than the host's, with their platforms. */
function imagePlatforms(): Record<string, string> {
  try {
    const platforms: unknown = JSON.parse(process.env[IMAGE_PLATFORMS] ?? "{}");
    return typeof platforms === "object" && platforms !== null ? (platforms as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Gives `image`, a copy of an image under test, such as its tag in a test's
 * registry or a fixture image built on it, the platform of `like`, when that
 * is not the host's, so that it is asked for wherever the original is.
 */
export function sharePlatform(image: string, like: string): void {
  const platforms = imagePlatforms();
  if (!Object.hasOwn(platforms, like)) return;
  process.env[IMAGE_PLATFORMS] = JSON.stringify({ ...platforms, [image]: platforms[like] });
}

/** The flags that ask docker for an image's own platform, when it is an image under test that is not the host's; none for any other. */
export function platformFlags(image: string): string[] {
  const platforms = imagePlatforms();
  const platform = Object.hasOwn(platforms, image) ? platforms[image] : undefined;
  return platform === undefined ? [] : ["--platform", platform];
}

/**
 * A `docker run` or `docker create` of an image under test asks for the
 * image's own platform; every other command, and every other image, such as
 * Postgres or Caddy, is left to docker, which runs the host's platform.
 */
function withPlatform(args: readonly string[]): string[] {
  const [command, ...rest] = args;
  if ((command !== "run" && command !== "create") || rest.includes("--platform")) return [...args];
  const image = rest.find((arg) => platformFlags(arg).length > 0);
  return image === undefined ? [...args] : [command, ...platformFlags(image), ...rest];
}

/** Runs the docker CLI and returns its exit status and output. */
export function docker(args: string[], timeoutSeconds = 120): Run {
  const run = spawnSync("docker", withPlatform(args), { encoding: "utf8", timeout: timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Like docker(), but throws unless the command succeeds, and returns its trimmed output. */
export function dockerOk(args: string[], timeoutSeconds = 120): string {
  const run = docker(args, timeoutSeconds);
  if (run.status !== 0) throw new Error(`docker ${args.join(" ")} exited with ${run.status}: ${run.stderr}`);
  return run.stdout.trim();
}

/** The platform an image runs on, as os/architecture, or undefined when docker cannot say. */
function platformOf(image: string, platform?: string): string | undefined {
  const run = docker(["image", "inspect", ...(platform === undefined ? [] : ["--platform", platform]), "--format", "{{.Os}}/{{.Architecture}}", image]);
  const found = run.stdout.trim();
  return run.status === 0 && found !== "/" && found !== "" ? found : undefined;
}

/**
 * The platform to run an image on when it is not the host's, such as
 * linux/amd64 for the image CI builds on an arm64 host; undefined when the
 * image runs on the host's own platform. Docker runs such an image under
 * emulation and warns on standard error unless it is asked for the platform.
 * An image pulled into Docker Desktop's containerd store is an index whose
 * own os and architecture are empty, so it is asked for each platform.
 */
export function foreignPlatformOf(image: string): string | undefined {
  const host = dockerOk(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
  if (platformOf(image, host) === host) return undefined;
  const own = platformOf(image) ?? ["linux/amd64", "linux/arm64"].find((platform) => platformOf(image, platform) === platform);
  return own === undefined || own === host ? undefined : own;
}

/** A name that no other test run uses. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/** Polls until check() returns a value other than undefined, or throws after the timeout. */
export async function waitFor<T>(what: string, check: () => T | undefined | Promise<T | undefined>, timeoutSeconds = 60): Promise<T> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeoutSeconds}s waiting for ${what}`, { cause: lastError });
}

/** The container's state as `docker inspect` reports it. */
export function containerState(name: string): { Status: string; Running: boolean; ExitCode: number } {
  return JSON.parse(dockerOk(["inspect", "--format", "{{json .State}}", name])) as {
    Status: string;
    Running: boolean;
    ExitCode: number;
  };
}

/** The volumes mounted into a container, anonymous ones included; none when the container does not exist. */
export function volumesOf(name: string): string[] {
  const run = docker(["inspect", "--format", '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}', name]);
  return run.status === 0 ? run.stdout.split("\n").filter((line) => line !== "") : [];
}

/** The volumes among these that still exist. */
export function existingVolumes(volumes: string[]): string[] {
  return volumes.filter((volume) => docker(["volume", "inspect", volume]).status === 0);
}

/** The effective uid of a running container's first process. */
/** The environment the container's main process started with, as KEY=value entries. */
export function processEnvironment(name: string): string[] {
  return dockerOk(["exec", name, "cat", "/proc/1/environ"])
    .split("\0")
    .filter((entry) => entry !== "");
}

export function processUid(name: string): number {
  const status = dockerOk(["exec", name, "cat", "/proc/1/status"]);
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  if (uid === undefined) throw new Error(`No Uid line in /proc/1/status of ${name}`);
  return Number(uid);
}

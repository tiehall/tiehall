import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

// self-host-install: Release pipeline integrity: install scripts run only for
// an allowlist of packages. This installs a dependency with a postinstall script
// under the repository's own pnpm settings, in a scratch workspace.

const workspaceFile = fileURLToPath(new URL("../../../pnpm-workspace.yaml", import.meta.url));
const packageSource = fileURLToPath(new URL("./fixtures/install-scripts/has-install-script/", import.meta.url));

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, CI: "true" } });
  if (result.error) throw result.error;
  return result;
}

describe("install scripts under the repository's pnpm settings", { timeout: 60_000 }, () => {
  let scratch: string;
  /** The dependency spec, relative to each workspace, as pnpm records it and allowBuilds names it. */
  let spec: string;

  // npm pack runs as a child process: the hook gets the tests' timeout, not Vitest's 10-second default for hooks.
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "tiehall-install-scripts-"));
    const packed = run("npm", ["pack", "--silent", "--pack-destination", scratch, packageSource], scratch);
    expect(packed.status, packed.stderr).toBe(0);
    const file = readdirSync(scratch).find((name) => name.endsWith(".tgz"));
    if (file === undefined) throw new Error("npm pack wrote no tarball");
    spec = `file:../${file}`;
  }, 60_000);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A workspace that depends on the fixture package, with every pnpm setting of the repository plus `extra`. */
  function workspace(name: string, extra: Record<string, unknown> = {}): string {
    const settings = parse(readFileSync(workspaceFile, "utf8")) as Record<string, unknown>;
    const directory = join(scratch, name);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, private: true, dependencies: { "has-install-script": spec } }),
    );
    const allowBuilds = { ...(settings["allowBuilds"] as object | undefined), ...(extra["allowBuilds"] as object) };
    writeFileSync(join(directory, "pnpm-workspace.yaml"), stringify({ ...settings, packages: [], allowBuilds }));
    return directory;
  }

  it("refuse to install a dependency whose install script nobody has reviewed, and do not run it", () => {
    const directory = workspace("unreviewed");
    const install = run("pnpm", ["install"], directory);
    expect(install.status).not.toBe(0);
    expect(install.stdout + install.stderr).toContain("ERR_PNPM_IGNORED_BUILDS");
    expect(existsSync(join(directory, "install-script-ran"))).toBe(false);
  });

  it("run the install script only once the package is on the allowlist", () => {
    const directory = workspace("allowlisted", { allowBuilds: { [`has-install-script@${spec}`]: true } });
    const install = run("pnpm", ["install"], directory);
    expect(install.status, install.stdout + install.stderr).toBe(0);
    expect(existsSync(join(directory, "install-script-ran"))).toBe(true);
  });
});

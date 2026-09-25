import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkLicenses, loadLicenseMap } from "../src/licenses.ts";

// The license-map check (task 3.3; public-api: The license map; design.md,
// Self-hosting decisions: S16). It runs the same script as the CI job against
// committed fixture workspaces and the real tree.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-licenses.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/licenses/${name}/`, import.meta.url));

function check(root: string) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

describe("the license-map check", () => {
  it("fails when a client piece says AGPL-3.0", () => {
    const run = check(fixture("client-says-agpl"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'packages/cli/package.json: license is "AGPL-3.0-only", but the license map makes packages/cli (tiehall) Apache-2.0.',
    );
    expect(checkLicenses(fixture("client-says-agpl"), loadLicenseMap())).toEqual([
      {
        file: "packages/cli/package.json",
        detail: 'license is "AGPL-3.0-only", but the license map makes packages/cli (tiehall) Apache-2.0.',
      },
    ]);
  });

  it("fails when a server package says Apache-2.0", () => {
    const run = check(fixture("server-says-apache"));
    expect(run.status).toBe(1);
    expect(checkLicenses(fixture("server-says-apache"), loadLicenseMap())).toEqual([
      {
        file: "packages/catalog/package.json",
        detail:
          'license is "Apache-2.0", but the license map makes every package other than the five client pieces AGPL-3.0-only.',
      },
    ]);
    expect(run.stderr).toContain("packages/catalog/package.json: license is \"Apache-2.0\"");
  });

  it("fails when a client piece the map names is not a workspace package", () => {
    const run = check(fixture("missing-packet-package"));
    expect(run.status).toBe(1);
    expect(checkLicenses(fixture("missing-packet-package"), loadLicenseMap())).toEqual([
      {
        file: "packages/packet/package.json",
        detail: "the license map names packages/packet (@tiehall/packet) as Apache-2.0, but it is not a workspace package.",
      },
    ]);
  });

  it("passes on the real tree, where the root and every workspace package carry the license the map gives them", () => {
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Apache-2\.0 in the 5 client pieces of the license map, and AGPL-3\.0-only in the root and the \d+ other workspace packages\.$/m);
    expect(checkLicenses(repoRoot, loadLicenseMap())).toEqual([]);
  });

  it("names exactly the five Apache-2.0 client pieces of design.md S16, with the packet schema package among them", () => {
    expect(loadLicenseMap()).toEqual({
      serverLicense: "AGPL-3.0-only",
      clientLicense: "Apache-2.0",
      clientPieces: {
        "packages/cli": "tiehall",
        "packages/client": "@tiehall/client",
        "packages/claude-plugin": "@tiehall/claude-plugin",
        "actions/contract": "@tiehall/contract-action",
        "packages/packet": "@tiehall/packet",
      },
    });
  });

  it("is the list the dependency rule for Apache-2.0 pieces reads", () => {
    const require = createRequire(import.meta.url);
    const config = require("../../../.dependency-cruiser.cjs") as {
      forbidden: { name: string; from: { path: string[] } }[];
    };
    const rule = config.forbidden.find(({ name }) => name === "apache-2.0-imports-no-agpl-3.0");
    const folders = Object.keys(loadLicenseMap().clientPieces).map((folder) => `^${folder}/`);
    expect(rule?.from.path).toEqual(folders);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The MCP SDK the server and the MCP tests run on is the release line that
// design.md names (design.md, Technical decisions: T9), so the contract tests
// run on the SDK the design was checked against.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const design = readFileSync(join(root, "openspec", "changes", "add-tiehall-oss-v1", "design.md"), "utf8");

/** The pinned versions of a package across the workspace's package.json files that name it. */
function pinsOf(name: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const manifest of ["packages/commands/package.json", "tools/image-tests/package.json"]) {
    const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(join(root, manifest), "utf8")) as Record<string, Record<string, string>>;
    const version = dependencies[name] ?? devDependencies[name];
    if (version !== undefined) pins[manifest] = version;
  }
  return pins;
}

describe("the MCP SDK", () => {
  it("is pinned, server and client alike, to the release line design.md T9 names", () => {
    const line = /`@modelcontextprotocol\/server` (\d+)\.(\d+)\.x/.exec(design);
    expect(line).not.toBeNull();
    const [, major, minor] = line!;
    const pins = { ...pinsOf("@modelcontextprotocol/server"), ...Object.fromEntries(Object.entries(pinsOf("@modelcontextprotocol/client")).map(([file, version]) => [`${file} (client)`, version])) };
    expect(Object.keys(pins)).toHaveLength(3);
    for (const [file, version] of Object.entries(pins)) expect(version, file).toMatch(new RegExp(`^${major}\\.${minor}\\.\\d+$`));
  });
});

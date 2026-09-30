import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MINIMUM_PLUGIN_VERSION, MINIMUM_SKILL_VERSION } from "@tiehall/core";
import { pluginProblems } from "../src/plugin.ts";

// The Claude Code plugin's check (agent-surfaces: The Claude Code plugin;
// design.md, Design rules: Agent surfaces; design.md, Where the specs leave
// room). The plugin in packages/claude-plugin holds a manifest that states its
// version, an MCP connection to /mcp on the install whose URL the user gives
// once, and a skill in the Agent Skills format that states its own version.
// Tiehall keeps a minimum for each version, and the check fails on a manifest
// or a skill without a version, or with one below its minimum, on a manifest
// key Claude Code does not know, on a skill whose frontmatter the format
// refuses, and on an MCP connection that names one install. The plugin's
// hooks run `tiehall hook session-start` when a session starts, `tiehall hook
// wait` with asyncRewake and a timeout longer than the waiter's 30-minute cap
// when a turn ends, and `tiehall hook session-end` when a session ends, each
// through the plugin's launcher, and the plugin declares no channel.

const script = fileURLToPath(new URL("../src/check-plugin.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/plugin/${name}/`, import.meta.url));
const plugin = fileURLToPath(new URL("../../../packages/claude-plugin/", import.meta.url));
const minimums = { plugin: MINIMUM_PLUGIN_VERSION, skill: MINIMUM_SKILL_VERSION };

function check(root: string) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

describe("the plugin check", () => {
  it("passes the plugin in packages/claude-plugin, whose manifest and skill state versions no older than Tiehall's minimums", () => {
    const run = check(plugin);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^The Claude Code plugin tiehall \d+\.\d+\.\d+ connects to \$\{TIEHALL_URL\}\/mcp and holds the skill tiehall \d+\.\d+\.\d+\.$/m);
    expect(pluginProblems(plugin, minimums)).toEqual([]);
  });

  it("passes a valid fixture", () => {
    expect(pluginProblems(fixture("valid"), minimums)).toEqual([]);
  });

  it("fails on a manifest without a version", () => {
    const run = check(fixture("no-version"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(".claude-plugin/plugin.json: states no version, a semantic version such as 0.1.0.");
    expect(pluginProblems(fixture("no-version"), minimums)).toEqual([".claude-plugin/plugin.json: states no version, a semantic version such as 0.1.0."]);
  });

  it("fails on a version below Tiehall's minimum for the plugin or the skill", () => {
    expect(pluginProblems(fixture("valid"), { plugin: "9.0.0", skill: "9.0.0" })).toEqual([
      ".claude-plugin/plugin.json: states version 0.1.0, which is older than the minimum Tiehall keeps for the plugin, 9.0.0.",
      "skills/tiehall/SKILL.md: states version 0.1.0, which is older than the minimum Tiehall keeps for the skill, 9.0.0.",
    ]);
  });

  it("fails on a manifest key that Claude Code does not know", () => {
    expect(pluginProblems(fixture("unknown-key"), minimums)).toEqual([".claude-plugin/plugin.json: has the key minimumVersion, which a Claude Code plugin manifest does not have."]);
  });

  it("fails on an MCP connection that names one install, rather than the URL the user gives", () => {
    expect(pluginProblems(fixture("fixed-mcp-url"), minimums)).toEqual([
      ".mcp.json: connects the server tiehall to https://tiehall.example.com/mcp; it connects to ${TIEHALL_URL}/mcp, the /mcp of the install whose URL the user gives.",
    ]);
  });

  it("fails on a skill without a version, and on a skill whose name is not its folder's", () => {
    expect(pluginProblems(fixture("skill-without-version"), minimums)).toEqual([
      "skills/tiehall/SKILL.md: states no version under metadata, a semantic version such as 0.1.0.",
    ]);
    expect(pluginProblems(fixture("skill-name-mismatch"), minimums)).toEqual([
      "skills/tiehall/SKILL.md: is named tie-hall, but an Agent Skill is named as its folder, tiehall.",
    ]);
  });

  // requester-loop: Claude Code SessionStart digest; requester-loop: Claude Code Stop-hook waiter.
  it("fails on a plugin without its hooks", () => {
    expect(pluginProblems(fixture("no-hooks"), minimums)).toEqual([
      "hooks/hooks.json: is missing: the plugin runs tiehall hook session-start when a session starts, tiehall hook wait when a turn ends and tiehall hook session-end when a session ends.",
      "hooks/tiehall-hook.sh: is missing: the plugin's hooks run tiehall through this launcher, which stays quiet without the CLI.",
    ]);
  });

  it("fails on a Stop hook without asyncRewake, or with a timeout no longer than the waiter's 30-minute cap", () => {
    expect(pluginProblems(fixture("stop-without-rewake"), minimums)).toEqual([
      "hooks/hooks.json: runs the Stop hook without asyncRewake, so the waiter could not wake Claude.",
      "hooks/hooks.json: gives the Stop hook a timeout of 600 seconds; the waiter's cap is 30 minutes, so its timeout is longer, 1900 seconds.",
    ]);
  });

  // requester-loop: No push paths other than the hooks, "No channel in the plugin".
  it("fails on a plugin that declares a channel", () => {
    expect(pluginProblems(fixture("channel"), minimums)).toEqual([".claude-plugin/plugin.json: declares a channel; the plugin's only push path is its hooks."]);
  });
});

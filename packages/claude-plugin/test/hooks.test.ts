import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The plugin's hooks and its manifest (requester-loop: Claude Code
// SessionStart digest; requester-loop: Claude Code Stop-hook waiter;
// requester-loop: No push paths other than the hooks; agent-surfaces: CLI
// contract and hook commands; agent-surfaces: The Claude Code plugin;
// design.md, Technical decisions: T15). The plugin registers three hooks in
// hooks/hooks.json, each through the launcher, which runs `tiehall hook
// <name>`: SessionStart runs the digest, `session-start`; Stop runs the
// waiter, `wait`, with Claude Code's asyncRewake option, so that it waits in
// the background and wakes Claude when it exits with code 2, and a timeout of
// 1900 seconds, longer than the waiter's 30-minute cap, so that Claude Code
// does not end it first; SessionEnd frees the session's lock, `session-end`.
// The plugin declares no channel. This release of the plugin, the first with
// the hooks, is 0.2.0.

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL(".claude-plugin/plugin.json", root), "utf8")) as Record<string, unknown>;
const registered = JSON.parse(readFileSync(new URL("hooks/hooks.json", root), "utf8")) as {
  hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; asyncRewake?: boolean; timeout?: number }[] }[]>;
};

/** How Claude Code runs the launcher for a hook: with sh, from the plugin's folder, whatever its path holds. */
const launch = (name: string) => `sh "\${CLAUDE_PLUGIN_ROOT}/hooks/tiehall-hook.sh" ${name}`;

/** The one command hook registered for an event. */
function only(event: string) {
  const groups = registered.hooks[event] ?? [];
  expect(groups, event).toHaveLength(1);
  const [group] = groups;
  expect(group?.matcher, event).toBeUndefined();
  expect(group?.hooks, event).toHaveLength(1);
  return group!.hooks[0]!;
}

describe("the plugin's hooks", () => {
  // requester-loop: No push paths other than the hooks, "No channel in the plugin".
  it("are SessionStart, Stop and SessionEnd, and no other", () => {
    expect(Object.keys(registered.hooks).sort()).toEqual(["SessionEnd", "SessionStart", "Stop"]);
  });

  // requester-loop: Claude Code SessionStart digest.
  it("run tiehall hook session-start when a session starts", () => {
    expect(only("SessionStart")).toMatchObject({ type: "command", command: launch("session-start") });
    expect(only("SessionStart").asyncRewake).toBeUndefined();
  });

  // requester-loop: Claude Code Stop-hook waiter.
  it("run tiehall hook wait when a turn ends, with asyncRewake and a timeout of 1900 seconds, longer than the 30-minute cap", () => {
    const stop = only("Stop");
    expect(stop).toEqual({ type: "command", command: launch("wait"), asyncRewake: true, timeout: 1900 });
    expect(stop.timeout! * 1000).toBeGreaterThan(30 * 60_000);
  });

  it("run tiehall hook session-end when a session ends, which frees its lock", () => {
    expect(only("SessionEnd")).toMatchObject({ type: "command", command: launch("session-end") });
  });

  it("run the launcher the plugin holds", () => {
    expect(existsSync(new URL("hooks/tiehall-hook.sh", root))).toBe(true);
  });
});

describe("the plugin's manifest", () => {
  it("states version 0.2.0, the first release with the hooks", () => {
    expect(manifest["version"]).toBe("0.2.0");
  });

  // requester-loop: No push paths other than the hooks, "No channel in the plugin".
  it("declares no channel, and nothing in the plugin does", () => {
    expect(Object.keys(manifest)).not.toContain("channels");
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.json$/.test(entry.name) && !entry.parentPath.includes("node_modules"))
      .map((entry) => `${entry.parentPath}/${entry.name}`);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/"channels?"\s*:/);
  });
});

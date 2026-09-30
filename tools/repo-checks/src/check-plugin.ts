// CI check for agent-surfaces: The Claude Code plugin. It fails when the
// plugin's manifest, its MCP connection or its skills are not what Claude
// Code and the Agent Skills format take, or state no version, or one older
// than the minimum Tiehall keeps.
// Usage: node tools/repo-checks/src/check-plugin.ts [plugin folder]
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MINIMUM_PLUGIN_VERSION, MINIMUM_SKILL_VERSION } from "@tiehall/core";
import { checkPlugin, MCP_URL } from "./plugin.ts";

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../packages/claude-plugin/", import.meta.url)));
const report = checkPlugin(root, { plugin: MINIMUM_PLUGIN_VERSION, skill: MINIMUM_SKILL_VERSION });

if (report.problems.length === 0) {
  const skills = report.skills.map(({ name, version }) => `${name} ${version}`).join(", ");
  console.log(`The Claude Code plugin ${report.name} ${report.version} connects to ${MCP_URL} and holds the skill${report.skills.length === 1 ? "" : "s"} ${skills}.`);
} else {
  for (const problem of report.problems) console.error(problem);
  console.error(
    `\nThe plugin states its version in .claude-plugin/plugin.json and each skill its own in its frontmatter's metadata, ` +
      `neither older than the minimum Tiehall keeps (the plugin's ${MINIMUM_PLUGIN_VERSION}, the skill's ${MINIMUM_SKILL_VERSION}), ` +
      "and its MCP connection points at the install whose URL the user gives (agent-surfaces: The Claude Code plugin).",
  );
  process.exitCode = 1;
}

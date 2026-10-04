// CI check for agent-surfaces: The Claude Code plugin. It fails when the
// plugin's manifest, its MCP connection, its hooks or its skills are not what
// Claude Code and the Agent Skills format take, or state no version, or one
// older than the minimum Tiehall keeps. Run without a folder, it also checks
// the repository's marketplace file, .claude-plugin/marketplace.json, through
// which Claude Code installs the plugin from the repository (marketplace.ts).
// Usage: node tools/repo-checks/src/check-plugin.ts [plugin folder]
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MINIMUM_PLUGIN_VERSION, MINIMUM_SKILL_VERSION } from "@tiehall/core";
import { checkMarketplace, MARKETPLACE_FILE } from "./marketplace.ts";
import { checkPlugin, MCP_URL } from "./plugin.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const minimums = { plugin: MINIMUM_PLUGIN_VERSION, skill: MINIMUM_SKILL_VERSION };
const root = resolve(process.argv[2] ?? `${repository}packages/claude-plugin/`);
const report = checkPlugin(root, minimums);
const marketplace = process.argv[2] === undefined ? checkMarketplace(repository, minimums) : undefined;

if (report.problems.length === 0) {
  const skills = report.skills.map(({ name, version }) => `${name} ${version}`).join(", ");
  console.log(`The Claude Code plugin ${report.name} ${report.version} connects to ${MCP_URL} and holds the skill${report.skills.length === 1 ? "" : "s"} ${skills}.`);
} else {
  for (const problem of report.problems) console.error(problem);
  console.error(
    `\nThe plugin states its version in .claude-plugin/plugin.json and each skill its own in its frontmatter's metadata, ` +
      `neither older than the minimum Tiehall keeps (the plugin's ${MINIMUM_PLUGIN_VERSION}, the skill's ${MINIMUM_SKILL_VERSION}), ` +
      "its MCP connection points at the install whose URL the user gives, and its hooks run tiehall hook through its launcher " +
      "(agent-surfaces: The Claude Code plugin; requester-loop: Claude Code Stop-hook waiter).",
  );
  process.exitCode = 1;
}

if (marketplace !== undefined) {
  // The plugin's own problems were printed above; the marketplace's are the rest.
  const own = marketplace.problems.filter((problem) => problem.startsWith(MARKETPLACE_FILE));
  for (const { name, version, source } of marketplace.plugins) {
    console.log(`The marketplace ${marketplace.name} lists the plugin ${name} ${version} from ${source}: claude plugin install ${name}@${marketplace.name}.`);
  }
  if (own.length > 0) {
    for (const problem of own) console.error(problem);
    console.error(
      `\nThe repository's ${MARKETPLACE_FILE} makes it a Claude Code plugin marketplace that lists the plugin tiehall from ` +
        "./packages/claude-plugin, with only the keys Claude Code reads (agent-surfaces: The Claude Code plugin).",
    );
    process.exitCode = 1;
  }
}

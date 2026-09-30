import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { compareVersions, isVersion } from "@tiehall/core";

// The Claude Code plugin's check (agent-surfaces: The Claude Code plugin;
// agent-surfaces: What the skill teaches; design.md, Design rules: Agent
// surfaces; design.md, Where the specs leave room). The plugin in
// packages/claude-plugin, which Claude Code installs, holds:
// - its manifest, .claude-plugin/plugin.json, which states the plugin's name
//   and its version, a semantic version no older than the minimum Tiehall
//   keeps for the plugin, and no key a Claude Code plugin manifest does not
//   have;
// - its MCP connection, .mcp.json, one HTTP server named tiehall at
//   ${TIEHALL_URL}/mcp: the /mcp of the install whose URL the user gives
//   once, as TIEHALL_URL, which Claude Code expands in a plugin's MCP
//   configuration (the path spike 1.9 checks in a real Claude Code);
// - its skills, each a folder under skills/ with a SKILL.md in the Agent
//   Skills format, which also loads on its own in other clients: YAML
//   frontmatter that names the skill as its folder, describes it, and states
//   its version under metadata, no older than the minimum Tiehall keeps for
//   the skill; the Tiehall skill, tiehall, among them.

export interface Minimums {
  plugin: string;
  skill: string;
}

/** The keys a Claude Code plugin manifest has. */
const MANIFEST_KEYS: ReadonlySet<string> = new Set([
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "commands",
  "agents",
  "skills",
  "hooks",
  "mcpServers",
  "outputStyles",
  "lspServers",
]);

/** The keys of an Agent Skill's frontmatter. */
const SKILL_KEYS: ReadonlySet<string> = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

/** A plugin's or a skill's name: lower-case letters and digits in words joined by hyphens, at most 64 characters. */
const NAME = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;

/** Where the plugin's MCP server is: the /mcp of the install whose URL the user gives once. */
export const MCP_URL = "${TIEHALL_URL}/mcp";

/** The plugin's name, its version, and its skills with their versions, as the check read them. */
export interface PluginReport {
  problems: string[];
  name?: string;
  version?: string;
  skills: { name: string; version: string }[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(root: string, file: string, problems: string[]): unknown {
  const path = join(root, file);
  if (!existsSync(path)) {
    problems.push(`${file}: is missing.`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    problems.push(`${file}: is not JSON.`);
    return undefined;
  }
}

/** A version's problems: none, or that there is none, or that it is older than the minimum. */
function versionProblems(file: string, version: unknown, minimum: string, what: string, where = ""): string[] {
  if (typeof version !== "string" || !isVersion(version)) return [`${file}: states no version${where}, a semantic version such as 0.1.0.`];
  if (compareVersions(version, minimum) < 0) return [`${file}: states version ${version}, which is older than the minimum Tiehall keeps for the ${what}, ${minimum}.`];
  return [];
}

/** Checks the plugin whose root is this folder; returns what it read and every problem, in order. */
export function checkPlugin(root: string, minimums: Minimums): PluginReport {
  const problems: string[] = [];
  const report: PluginReport = { problems, skills: [] };

  const manifestFile = ".claude-plugin/plugin.json";
  const manifest = readJson(root, manifestFile, problems);
  if (manifest !== undefined && !isObject(manifest)) problems.push(`${manifestFile}: is not a JSON object.`);
  if (isObject(manifest)) {
    for (const key of Object.keys(manifest)) {
      if (!MANIFEST_KEYS.has(key)) problems.push(`${manifestFile}: has the key ${key}, which a Claude Code plugin manifest does not have.`);
    }
    if (typeof manifest["name"] !== "string" || !NAME.test(manifest["name"])) problems.push(`${manifestFile}: names the plugin in lower-case words joined by hyphens.`);
    else report.name = manifest["name"];
    const versioned = versionProblems(manifestFile, manifest["version"], minimums.plugin, "plugin");
    problems.push(...versioned);
    if (versioned.length === 0) report.version = String(manifest["version"]);
    if (typeof manifest["description"] !== "string" || manifest["description"].trim() === "") problems.push(`${manifestFile}: describes the plugin.`);
    if (manifest["license"] !== "Apache-2.0") problems.push(`${manifestFile}: states the plugin's license, Apache-2.0.`);
  }

  const mcpFile = ".mcp.json";
  const mcp = readJson(root, mcpFile, problems);
  const servers = isObject(mcp) && isObject(mcp["mcpServers"]) ? mcp["mcpServers"] : undefined;
  if (mcp !== undefined && servers === undefined) problems.push(`${mcpFile}: holds no mcpServers.`);
  if (servers !== undefined) {
    const names = Object.keys(servers);
    if (names.length !== 1 || names[0] !== "tiehall") problems.push(`${mcpFile}: holds one MCP server, named tiehall.`);
    const server = servers["tiehall"];
    if (isObject(server)) {
      if (server["type"] !== "http") problems.push(`${mcpFile}: connects the server tiehall over HTTP, with type http.`);
      if (server["url"] !== MCP_URL) {
        problems.push(`${mcpFile}: connects the server tiehall to ${String(server["url"])}; it connects to ${MCP_URL}, the /mcp of the install whose URL the user gives.`);
      }
    }
  }

  const skillsFolder = join(root, "skills");
  const folders = existsSync(skillsFolder) ? readdirSync(skillsFolder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map(({ name }) => name).sort() : [];
  if (!folders.includes("tiehall")) problems.push("skills/tiehall/SKILL.md: is missing: the plugin holds the Tiehall skill.");
  for (const folder of folders) {
    const file = `skills/${folder}/SKILL.md`;
    const path = join(root, file);
    if (!existsSync(path)) {
      problems.push(`${file}: is missing.`);
      continue;
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(readFileSync(path, "utf8"));
    let frontmatter: unknown;
    try {
      frontmatter = match === null ? undefined : parse(match[1] ?? "");
    } catch {
      frontmatter = undefined;
    }
    if (!isObject(frontmatter)) {
      problems.push(`${file}: starts with YAML frontmatter between --- lines, as an Agent Skill does.`);
      continue;
    }
    for (const key of Object.keys(frontmatter)) {
      if (!SKILL_KEYS.has(key)) problems.push(`${file}: has the frontmatter key ${key}, which an Agent Skill does not have.`);
    }
    const name = frontmatter["name"];
    if (typeof name !== "string" || !NAME.test(name)) problems.push(`${file}: names the skill in lower-case words joined by hyphens.`);
    else if (name !== folder) problems.push(`${file}: is named ${name}, but an Agent Skill is named as its folder, ${folder}.`);
    const description = frontmatter["description"];
    if (typeof description !== "string" || description.trim() === "" || description.length > 1024) {
      problems.push(`${file}: describes the skill and when to use it, in at most 1,024 characters.`);
    }
    const metadata = isObject(frontmatter["metadata"]) ? frontmatter["metadata"] : {};
    const versioned = versionProblems(file, metadata["version"], minimums.skill, "skill", " under metadata");
    problems.push(...versioned);
    if (versioned.length === 0 && typeof name === "string") report.skills.push({ name, version: String(metadata["version"]) });
  }
  return report;
}

/** Every problem of the plugin whose root is this folder. */
export function pluginProblems(root: string, minimums: Minimums): string[] {
  return checkPlugin(root, minimums).problems;
}

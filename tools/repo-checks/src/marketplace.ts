import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { checkPlugin, type Minimums } from "./plugin.ts";

// The repository as a Claude Code plugin marketplace (agent-surfaces: The
// Claude Code plugin; public-api: Client pieces are built from public source
// with provenance). The repository's root holds .claude-plugin/
// marketplace.json, which Claude Code reads when someone runs `claude plugin
// marketplace add <owner>/<repo>`, at a tag with `#<tag>`: it clones the
// repository, and `claude plugin install tiehall@tiehall` then copies the
// plugin's folder into its cache. The file lists exactly one plugin, tiehall,
// from the relative path ./packages/claude-plugin, so what installs is the
// plugin as this repository holds it. The check holds the file to what Claude
// Code reads, as its marketplace reference describes it, more strictly where
// Claude Code would only warn:
// - only the keys Claude Code reads, at the top and in the entry, since it
//   ignores any other;
// - the name tiehall, which Claude Code can install from (letters, digits,
//   ".", "_" and "-", starting with a letter or digit, no "..") and which no
//   official marketplace reserves;
// - an owner with a name, and a description, which people see when they add
//   the marketplace;
// - one entry, named as the plugin's manifest names it, whose source is a
//   relative path from the root that starts with "./", holds no "..", and
//   leads to the plugin's folder in this repository;
// - no version in the entry, which the plugin's manifest states, and no
//   component, which the plugin's own files declare;
// - and the plugin there passing the plugin check (plugin.ts).

/** The marketplace file, relative to the repository's root. */
export const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";

/** The marketplace's name: people install the plugin as tiehall@tiehall. */
export const MARKETPLACE_NAME = "tiehall";

/** Where the marketplace takes the plugin from: its folder in this repository. */
export const PLUGIN_SOURCE = "./packages/claude-plugin";

/** The keys Claude Code reads at the top of a marketplace file. */
const TOP_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "name",
  "owner",
  "plugins",
  "description",
  "version",
  "metadata",
  "forceRemoveDeletedPlugins",
  "allowCrossMarketplaceDependenciesOn",
  "renames",
]);

/** The components a plugin entry can declare, which the plugin's own files declare here. */
const COMPONENT_KEYS: readonly string[] = ["commands", "agents", "skills", "hooks", "outputStyles", "themes", "mcpServers", "lspServers", "userConfig", "channels"];

/** The keys Claude Code reads in a plugin entry: its own, the display fields, and the components. */
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "name",
  "source",
  "description",
  "version",
  "category",
  "tags",
  "strict",
  "relevance",
  "dependencies",
  "defaultEnabled",
  "displayName",
  "metadata",
  "headers",
  "headersHelper",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  ...COMPONENT_KEYS,
]);

/** A marketplace's or a plugin entry's name that Claude Code can install from. */
const INSTALLABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The names Claude Code reserves for marketplaces of its own, or for plugins that come from no marketplace. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "anthropic-marketplace",
  "anthropic-plugins",
  "agent-skills",
  "anthropic-agent-skills",
  "life-sciences",
  "knowledge-work-plugins",
  "claude-for-legal",
  "claude-for-financial-services",
  "financial-services-plugins",
  "first-party-plugins",
  "claude-tag-plugins",
  "claude-community",
  "claude-plugins-community",
  "healthcare",
  "anthropic-plugin-directory",
  "claude-plugin-directory",
  "inline",
  "builtin",
  "skills-dir",
  "synced",
  "claude-plugin-test",
  "npm",
  "pip",
  "uv",
  "cargo",
  "github",
  "gh",
]);

/** A plugin the marketplace lists: its entry's name and source, and the version its manifest states. */
export interface ListedPlugin {
  name: string;
  source: string;
  version: string;
}

export interface MarketplaceReport {
  problems: string[];
  /** The marketplace's name, when the file names one. */
  name?: string;
  /** The plugins it lists whose entries and plugins pass. */
  plugins: ListedPlugin[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The folder a relative source names, from the marketplace's root. */
export function pluginSourceFolder(root: string, source: string): string {
  return resolve(root, source);
}

/** Whether a name is one Claude Code reserves, in any casing for the names of package tools, or starts with claudeai-. */
function isReserved(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_NAMES.has(name) || ["npm", "pip", "uv", "cargo", "github", "gh"].includes(lower) || lower.startsWith("claudeai-");
}

/** Checks the marketplace file at this root and the plugin it lists; returns what it read and every problem, in order. */
export function checkMarketplace(root: string, minimums: Minimums): MarketplaceReport {
  const problems: string[] = [];
  const report: MarketplaceReport = { problems, plugins: [] };
  const file = MARKETPLACE_FILE;
  const path = join(root, file);
  if (!existsSync(path)) {
    problems.push(`${file}: is missing: it makes the repository a Claude Code plugin marketplace that lists the plugin.`);
    return report;
  }
  let marketplace: unknown;
  try {
    marketplace = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    problems.push(`${file}: is not JSON.`);
    return report;
  }
  if (!isObject(marketplace)) {
    problems.push(`${file}: is not a JSON object.`);
    return report;
  }

  for (const key of Object.keys(marketplace)) {
    if (!TOP_KEYS.has(key)) problems.push(`${file}: has the key ${key}, which a Claude Code marketplace file does not have.`);
  }
  const name = marketplace["name"];
  if (typeof name !== "string" || !INSTALLABLE_NAME.test(name) || name.includes("..")) {
    problems.push(
      `${file}: names the marketplace ${JSON.stringify(name ?? null)}; a marketplace name uses only letters, digits, ".", "_" and "-", starts with a letter or digit, and holds no "..".`,
    );
  } else if (isReserved(name)) {
    problems.push(`${file}: names the marketplace ${JSON.stringify(name)}, which Claude Code reserves.`);
  } else if (name !== MARKETPLACE_NAME) {
    problems.push(`${file}: names the marketplace ${JSON.stringify(name)}; it is ${MARKETPLACE_NAME}, so the plugin installs as tiehall@${MARKETPLACE_NAME}.`);
  } else {
    report.name = name;
  }
  const owner = marketplace["owner"];
  if (!isObject(owner) || typeof owner["name"] !== "string" || owner["name"].trim() === "") {
    problems.push(`${file}: names no owner; owner.name names who maintains the marketplace.`);
  }
  const description = marketplace["description"] ?? (isObject(marketplace["metadata"]) ? marketplace["metadata"]["description"] : undefined);
  if (typeof description !== "string" || description.trim() === "") {
    problems.push(`${file}: describes no marketplace; Claude Code shows the description to people who add it.`);
  }

  const plugins = Array.isArray(marketplace["plugins"]) ? (marketplace["plugins"] as unknown[]) : undefined;
  if (plugins === undefined || plugins.length !== 1) {
    problems.push(`${file}: lists ${plugins?.length ?? 0} plugins; it lists one, the plugin tiehall from ${PLUGIN_SOURCE}.`);
  }
  for (const [index, entry] of (plugins ?? []).entries()) {
    const listed = checkEntry(root, entry, `${file}: plugins[${index}]`, minimums, problems);
    if (listed !== undefined) report.plugins.push(listed);
  }
  return report;
}

/** Checks one plugin entry and the plugin its source names; the plugin when both pass. */
function checkEntry(root: string, entry: unknown, where: string, minimums: Minimums, problems: string[]): ListedPlugin | undefined {
  if (!isObject(entry)) {
    problems.push(`${where} is not a JSON object.`);
    return undefined;
  }
  const before = problems.length;
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) problems.push(`${where} has the key ${key}, which a Claude Code plugin entry does not have.`);
  }
  if (entry["version"] !== undefined) {
    problems.push(`${where} sets a version; the plugin's manifest states it, and Claude Code takes the manifest's.`);
  }
  for (const key of COMPONENT_KEYS) {
    if (entry[key] !== undefined) problems.push(`${where} declares ${key}; the plugin's own files declare its components.`);
  }
  const name = entry["name"];
  if (typeof name !== "string" || !INSTALLABLE_NAME.test(name)) {
    problems.push(`${where} names the plugin ${JSON.stringify(name ?? null)}; a plugin's name uses only letters, digits, ".", "_" and "-", and starts with a letter or digit.`);
  }

  const source = entry["source"];
  if (typeof source !== "string") {
    problems.push(`${where} takes the plugin from another repository; it takes it from this one, ${PLUGIN_SOURCE}.`);
    return undefined;
  }
  if (!source.startsWith("./")) {
    problems.push(`${where} takes the plugin from ${JSON.stringify(source)}; a relative source starts with "./" and is written from the repository's root.`);
    return undefined;
  }
  if (source.split("/").includes("..") || source.includes("\\")) {
    problems.push(`${where} takes the plugin from ${JSON.stringify(source)}, which holds "..": Claude Code refuses a source that leaves the marketplace's root.`);
    return undefined;
  }
  const folder = pluginSourceFolder(root, source);
  if (!existsSync(join(folder, ".claude-plugin/plugin.json")) || !statSync(folder).isDirectory()) {
    problems.push(`${where} takes the plugin from ${JSON.stringify(source)}, where no plugin is: the folder holds no .claude-plugin/plugin.json.`);
    return undefined;
  }
  if (folder !== pluginSourceFolder(root, PLUGIN_SOURCE)) {
    problems.push(`${where} takes the plugin from ${JSON.stringify(source)}; it takes it from the plugin's folder, ${PLUGIN_SOURCE}.`);
    return undefined;
  }

  // The plugin's own problems, named by their path from the repository's root.
  const plugin = checkPlugin(folder, minimums);
  const prefix = relative(root, folder).split(sep).join("/");
  problems.push(...plugin.problems.map((problem) => `${prefix}/${problem}`));
  if (typeof name === "string" && plugin.name !== undefined && name !== plugin.name) {
    problems.push(`${where} is named ${JSON.stringify(name)}, while the plugin's manifest names it ${JSON.stringify(plugin.name)}; the two are the same.`);
  }
  if (problems.length > before || typeof name !== "string" || plugin.version === undefined) return undefined;
  return { name, source, version: plugin.version };
}

/** Every problem of the marketplace file at this root and the plugin it lists. */
export function marketplaceProblems(root: string, minimums: Minimums): string[] {
  return checkMarketplace(root, minimums).problems;
}

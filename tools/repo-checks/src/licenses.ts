import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// The license map (public-api: The license map; design.md, Self-hosting
// decisions: S16): the client pieces carry the client license in their package
// metadata, and the repository's root and every other workspace package the
// server license.

export interface LicenseMap {
  /** The SPDX identifier of the server: the root and every workspace package that is not a client piece. */
  serverLicense: string;
  /** The SPDX identifier of the client pieces. */
  clientLicense: string;
  /** The client pieces: folder, relative to the root, to package name. */
  clientPieces: Record<string, string>;
}

export interface LicenseViolation {
  /** The package.json, relative to the root, with forward slashes. */
  file: string;
  detail: string;
}

export interface LicenseReport {
  violations: LicenseViolation[];
  /** The workspace packages the check read, as folders relative to the root ("." is the root). */
  packages: string[];
}

export function loadLicenseMap(): LicenseMap {
  const file = new URL("../license-map.json", import.meta.url);
  const { serverLicense, clientLicense, clientPieces } = JSON.parse(readFileSync(file, "utf8")) as LicenseMap;
  return { serverLicense, clientLicense, clientPieces };
}

/** Checks every workspace package under root against the map. */
export function checkLicenses(root: string, map: LicenseMap): LicenseViolation[] {
  return licenseReport(root, map).violations;
}

export function licenseReport(root: string, map: LicenseMap): LicenseReport {
  const packages = workspacePackages(root);
  const violations: LicenseViolation[] = [];

  for (const [folder, name] of Object.entries(map.clientPieces)) {
    if (!packages.includes(folder)) {
      violations.push({
        file: manifestPath(folder),
        detail: `the license map names ${folder} (${name}) as ${map.clientLicense}, but it is not a workspace package.`,
      });
    }
  }

  for (const folder of packages) {
    const file = manifestPath(folder);
    const manifest = JSON.parse(readFileSync(join(root, file), "utf8")) as { name?: unknown; license?: unknown };
    const clientName = Object.hasOwn(map.clientPieces, folder) ? map.clientPieces[folder] : undefined;
    const expected = clientName === undefined ? map.serverLicense : map.clientLicense;
    const why =
      clientName === undefined
        ? `the license map makes every package other than the ${countOf(map)} client pieces ${map.serverLicense}.`
        : `the license map makes ${folder} (${clientName}) ${map.clientLicense}.`;

    if (clientName !== undefined && manifest.name !== clientName) {
      violations.push({
        file,
        detail: `is named ${JSON.stringify(manifest.name)}, but the license map names ${folder} as ${clientName}.`,
      });
    }
    if (typeof manifest.license !== "string") {
      violations.push({ file, detail: `has no license field, but ${why}` });
    } else if (manifest.license !== expected) {
      violations.push({ file, detail: `license is ${JSON.stringify(manifest.license)}, but ${why}` });
    }
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.detail.localeCompare(b.detail));
  return { violations, packages };
}

function countOf(map: LicenseMap): string {
  const words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const count = Object.keys(map.clientPieces).length;
  return words[count] ?? String(count);
}

function manifestPath(folder: string): string {
  return folder === "." ? "package.json" : `${folder}/package.json`;
}

/**
 * The workspace packages pnpm-workspace.yaml defines, plus the root: each
 * folder with a package.json that a `packages` pattern matches and no "!"
 * pattern excludes. Patterns are folders or folder/*; any other form fails,
 * so a pattern the check does not understand never leaves a package out.
 */
export function workspacePackages(root: string): string[] {
  const settings = parse(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")) as { packages?: unknown };
  const patterns = Array.isArray(settings.packages) ? settings.packages.map(String) : [];
  const excluded = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => excludedPrefix(pattern));
  const packages = new Set<string>(["."]);

  for (const pattern of patterns.filter((pattern) => !pattern.startsWith("!"))) {
    const trimmed = pattern.replace(/^\.\//, "").replace(/\/$/, "");
    if (/[*?[\]{}]/.test(trimmed.replace(/\/\*$/, ""))) {
      throw new Error(`pnpm-workspace.yaml: the license-map check cannot read the pattern ${JSON.stringify(pattern)}.`);
    }
    const folders = trimmed.endsWith("/*") ? subfolders(root, trimmed.slice(0, -2)) : [trimmed];
    for (const folder of folders) {
      if (existsSync(join(root, folder, "package.json"))) packages.add(folder);
    }
  }

  return [...packages]
    .filter((folder) => !excluded.some((prefix) => folder === prefix || folder.startsWith(`${prefix}/`)))
    .sort();
}

function excludedPrefix(pattern: string): string {
  const prefix = pattern.slice(1).replace(/^\.\//, "").replace(/\/\*\*$/, "");
  if (/[*?[\]{}]/.test(prefix)) {
    throw new Error(`pnpm-workspace.yaml: the license-map check cannot read the pattern ${JSON.stringify(pattern)}.`);
  }
  return prefix;
}

function subfolders(root: string, parent: string): string[] {
  if (!existsSync(join(root, parent))) return [];
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

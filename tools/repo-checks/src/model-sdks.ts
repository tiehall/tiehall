import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Denylist {
  /** npm scopes such as "@anthropic-ai"; every package in them is denied. */
  scopes: Record<string, string>;
  /** Exact package names. */
  packages: Record<string, string>;
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

export interface Finding {
  /** The package.json, relative to the scanned root, with forward slashes. */
  file: string;
  field: (typeof DEPENDENCY_FIELDS)[number];
  /** The package that gets installed, after resolving an npm: alias. */
  name: string;
  /** The key it is listed under in the package.json. */
  as: string;
  /** The denylist entry it matched: a scope or a package name. */
  listedAs: string;
}

/** Folders that hold no workspace package: installs, VCS data and build output. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", ".next"]);
/** Top-level folders that are never workspace packages: agent state, spikes and the OpenSpec plan. */
const SKIPPED_TOP_LEVEL = new Set([".claude", "spikes", "openspec"]);

/** The model SDK denylist (self-host-install: No model calls). */
export function loadDenylist(): Denylist {
  return readDenylist("../model-sdk-denylist.json");
}

/**
 * The telemetry denylist: analytics SDKs, error-reporting SDKs and update
 * checkers (self-host-install: No telemetry and a documented list of outbound
 * connections).
 */
export function loadTelemetryDenylist(): Denylist {
  return readDenylist("../telemetry-sdk-denylist.json");
}

function readDenylist(path: string): Denylist {
  const { scopes, packages } = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Denylist;
  return { scopes, packages };
}

/** What a denylist says about the entry a finding matched. */
export function denylistReason(denylist: Denylist, listedAs: string): string | undefined {
  return Object.hasOwn(denylist.packages, listedAs) ? denylist.packages[listedAs] : denylist.scopes[listedAs];
}

/** Finds every dependency on a denylisted package in the package.json files under root. */
export function findModelSdkDependencies(root: string, denylist: Denylist): Finding[] {
  const findings: Finding[] = [];
  for (const path of packageJsonFiles(root)) {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const file = relative(root, path).split(sep).join("/");
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (typeof dependencies !== "object" || dependencies === null) continue;
      for (const [as, spec] of Object.entries(dependencies)) {
        const name = installedName(as, spec);
        const listedAs = denylistEntry(name, denylist);
        if (listedAs !== undefined) findings.push({ file, field, name, as, listedAs });
      }
    }
  }
  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.field.localeCompare(b.field) || a.as.localeCompare(b.as),
  );
}

/** An "npm:" alias installs another package under the listed key. */
function installedName(as: string, spec: unknown): string {
  if (typeof spec !== "string" || !spec.startsWith("npm:")) return as;
  const target = spec.slice("npm:".length);
  const versionAt = target.indexOf("@", target.startsWith("@") ? 1 : 0);
  return versionAt === -1 ? target : target.slice(0, versionAt);
}

/** A package a lockfile resolves, or an image holds, that a denylist names. */
export interface PackageFinding {
  /** Where it was found: the lockfile, relative to the scanned root, or a path in an image. */
  file: string;
  name: string;
  version: string;
  /** The denylist entry it matched: a scope or a package name. */
  listedAs: string;
}

/** The lockfile the check reads beside the root package.json: pnpm's. */
export const LOCKFILE = "pnpm-lock.yaml";

/**
 * Every package a pnpm lockfile resolves, by name and version, sorted: the
 * keys of its packages and snapshots, in each of its documents (pnpm writes
 * its own install in a document of its own before the workspace's), with the
 * peers a snapshot's key names after its version left out. Whatever depends on
 * a package, directly or through others, the lockfile resolves it here. The
 * lockfile is read line by line, with Node alone, so the check needs no
 * install: pnpm writes each of these keys on a line of its own, indented by
 * two spaces under its section, and quoted when it starts with "@".
 */
export function lockfilePackages(text: string): { name: string; version: string }[] {
  const found = new Map<string, { name: string; version: string }>();
  let section: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z][A-Za-z0-9]*):/.exec(line);
    if (top !== null || line === "---") {
      section = top?.[1];
      continue;
    }
    if (section !== "packages" && section !== "snapshots") continue;
    const entry = /^  (?:'([^']+)'|([^\s'#][^\s]*?)):(?:\s|$)/.exec(line);
    if (entry === null) continue;
    const resolved = resolvedPackage(entry[1] ?? entry[2] ?? "");
    found.set(`${resolved.name}@${resolved.version}`, resolved);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** A lockfile key, name@version with any peers in parentheses after it, as its name and version. */
function resolvedPackage(key: string): { name: string; version: string } {
  const withoutPeers = key.includes("(") ? key.slice(0, key.indexOf("(")) : key;
  const at = withoutPeers.indexOf("@", withoutPeers.startsWith("@") ? 1 : 0);
  if (at <= 0) throw new Error(`a lockfile key that names no version: ${key}`);
  return { name: withoutPeers.slice(0, at), version: withoutPeers.slice(at + 1) };
}

/** The packages the lockfile beside root resolves that the denylist names; none when root holds no lockfile. */
export function findLockfilePackages(root: string, denylist: Denylist): PackageFinding[] {
  const path = join(root, LOCKFILE);
  if (!existsSync(path)) return [];
  return deniedPackages(
    lockfilePackages(readFileSync(path, "utf8")).map((resolved) => ({ ...resolved, file: LOCKFILE })),
    denylist,
  );
}

/** The packages among these that the denylist names, sorted by where they were found, then by name and version. */
export function deniedPackages(packages: readonly { file: string; name: string; version: string }[], denylist: Denylist): PackageFinding[] {
  const findings: PackageFinding[] = [];
  for (const found of packages) {
    const listedAs = denylistEntry(found.name, denylist);
    if (listedAs !== undefined) findings.push({ file: found.file, name: found.name, version: found.version, listedAs });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function denylistEntry(name: string, denylist: Denylist): string | undefined {
  if (Object.hasOwn(denylist.packages, name)) return name;
  const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined;
  if (scope !== undefined && Object.hasOwn(denylist.scopes, scope)) return scope;
  return undefined;
}

function* packageJsonFiles(root: string, folder = root): Generator<string> {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_FOLDERS.has(entry.name)) continue;
      if (folder === root && SKIPPED_TOP_LEVEL.has(entry.name)) continue;
      // Test fixtures are not workspace packages, and some break this rule on purpose.
      if (entry.name === "fixtures" && folder.endsWith(`${sep}test`)) continue;
      yield* packageJsonFiles(root, path);
    } else if (entry.name === "package.json") {
      yield path;
    }
  }
}

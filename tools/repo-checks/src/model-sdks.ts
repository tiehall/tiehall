import { readdirSync, readFileSync } from "node:fs";
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

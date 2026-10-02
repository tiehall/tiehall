import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Nothing on the server reads OpenAPI documents (contract-changes: Contract
// diffs run only where the specs already are; design.md, Design rules:
// Contract changes; design.md, Technical decisions: T12). Contract diffs run
// in the provider's CI and on developers' machines; Tiehall never fetches,
// receives, parses or diffs an OpenAPI document, and its GitHub App has no
// access to repository contents. Two checks keep it so:
// - no server package depends on a package that parses, dereferences,
//   validates or diffs OpenAPI documents, as openapi-reader-denylist.json
//   names them, in any dependency field, under its own name or an npm alias;
// - no server package's code calls GitHub's endpoints that read a
//   repository's files: the contents and readme endpoints, blobs and trees,
//   the archive downloads, Octokit's methods for them, GitHub's raw and
//   codeload hosts, and a GraphQL read of a file's object.
// The server packages are the apps the image runs, apps/server and apps/web,
// and every workspace package they depend on, directly or through another;
// their tests, test fixtures and build output are no server code. Developer
// tools, the CLI and the contract Action are not server packages, and run
// diffs on purpose. The workspace packages are the ones pnpm-workspace.yaml
// makes: one folder deep in apps, packages, actions and tools, so a package
// kept anywhere else, such as a spike, is none of them.

export interface Denylist {
  /** npm scopes such as "@useoptic"; every package in them is denied. */
  scopes: Record<string, string>;
  /** Exact package names. */
  packages: Record<string, string>;
}

/** The apps the image runs, by their folders, whose workspace dependencies are server packages too. */
export const SERVER_APPS = ["apps/server", "apps/web"] as const;

/** The folders whose subfolders pnpm-workspace.yaml makes workspace packages, as its apps/*, packages/*, actions/* and tools/* say. */
export const WORKSPACE_FOLDERS = ["apps", "packages", "actions", "tools"] as const;

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Folders of a server package that hold no server code. */
const NOT_SERVER_CODE = new Set(["node_modules", ".next", "dist", "test", "tests", "fixtures", "__tests__"]);
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** A dependency of a server package on a package the denylist names. */
export interface ReaderFinding {
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

/** A line of a server package's code that reads a repository's files on GitHub. */
export interface ContentsFinding {
  /** The file, relative to the scanned root, with forward slashes. */
  file: string;
  line: number;
  /** What the line calls, in the check's words. */
  reads: string;
}

/** The ways to read a repository's files on GitHub, each with what it reads. */
const CONTENTS_CALLS: readonly { pattern: RegExp; reads: string }[] = [
  { pattern: /\/repos\/[^\s"'`]*\/(contents|readme)\b/i, reads: "a repository's contents or readme endpoint" },
  { pattern: /\/repos\/[^\s"'`]*\/git\/(blobs|trees)\b/i, reads: "a repository's git blobs or trees" },
  { pattern: /\/repos\/[^\s"'`]*\/(tarball|zipball)\b/i, reads: "a repository's archive" },
  { pattern: /\b(getContent|getReadme|getReadmeInDirectory|getBlob|getTree|downloadArchive|downloadTarballArchive|downloadZipballArchive)\s*\(/, reads: "Octokit's method for a repository's files" },
  { pattern: /\braw\.githubusercontent\.com\b/i, reads: "GitHub's raw file host" },
  { pattern: /\bcodeload\.github\.com\b/i, reads: "GitHub's archive host" },
  { pattern: /\bobject\s*\(\s*expression\s*:/, reads: "a GraphQL read of a file's object" },
];

/** The denylist of OpenAPI parsers and diff tools. */
export function loadReaderDenylist(): Denylist {
  const { scopes, packages } = JSON.parse(readFileSync(new URL("../openapi-reader-denylist.json", import.meta.url), "utf8")) as Denylist;
  return { scopes, packages };
}

interface WorkspacePackage {
  /** Its folder, relative to the root, with forward slashes. */
  folder: string;
  manifest: Record<string, unknown>;
}

/** The server packages under root: the server apps, and the workspace packages they depend on, directly or through another. */
export function serverPackages(root: string): WorkspacePackage[] {
  const all = [...packageJsonFiles(root)].map((path): WorkspacePackage => ({
    folder: relative(root, path.slice(0, -"/package.json".length)).split(sep).join("/"),
    manifest: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
  }));
  const byName = new Map(all.flatMap((pkg) => (typeof pkg.manifest["name"] === "string" ? [[pkg.manifest["name"], pkg] as const] : [])));
  const found = new Map<string, WorkspacePackage>();
  const visit = (pkg: WorkspacePackage) => {
    if (found.has(pkg.folder)) return;
    found.set(pkg.folder, pkg);
    const dependencies = pkg.manifest["dependencies"];
    if (typeof dependencies !== "object" || dependencies === null) return;
    for (const [name, spec] of Object.entries(dependencies)) {
      const dependency = typeof spec === "string" && spec.startsWith("workspace:") ? byName.get(name) : undefined;
      if (dependency !== undefined) visit(dependency);
    }
  };
  for (const app of SERVER_APPS) {
    const pkg = all.find(({ folder }) => folder === app);
    if (pkg !== undefined) visit(pkg);
  }
  return [...found.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

/** Every dependency of a server package on a package that reads or diffs OpenAPI documents. */
export function findReaderDependencies(root: string, denylist: Denylist): ReaderFinding[] {
  const findings: ReaderFinding[] = [];
  for (const { folder, manifest } of serverPackages(root)) {
    const file = folder === "" ? "package.json" : `${folder}/package.json`;
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
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.field.localeCompare(b.field) || a.as.localeCompare(b.as));
}

/** Every line of a server package's code that reads a repository's files on GitHub. */
export function findContentsCalls(root: string): ContentsFinding[] {
  const findings: ContentsFinding[] = [];
  for (const { folder } of serverPackages(root)) {
    for (const path of codeFiles(join(root, folder))) {
      const file = relative(root, path).split(sep).join("/");
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((text, index) => {
          for (const { pattern, reads } of CONTENTS_CALLS) {
            if (pattern.test(text)) findings.push({ file, line: index + 1, reads });
          }
        });
    }
  }
  return findings;
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

/** The package.json of each workspace package under root: one folder deep in each workspace folder. */
function* packageJsonFiles(root: string): Generator<string> {
  for (const workspaceFolder of WORKSPACE_FOLDERS) {
    const parent = join(root, workspaceFolder);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const manifest = join(parent, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(manifest)) yield manifest;
    }
  }
}

/** The code files of a server package, outside its tests, fixtures and build output. */
function* codeFiles(folder: string): Generator<string> {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_SERVER_CODE.has(entry.name)) yield* codeFiles(path);
    } else if (CODE_FILE.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) {
      yield path;
    }
  }
}

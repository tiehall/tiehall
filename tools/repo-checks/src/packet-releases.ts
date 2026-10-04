import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The release-URL tree of the published packet schema (handoff-packet: Fixed
// release URLs; design.md, Design rules: Handoff packet; D26). Each published
// release lives at its own URL under https://tiehall.com/schemas/packet/,
// which is also its $id and never changes: v1.0.json, then v1.1.json and so
// on; v1.json always serves the latest v1.x release, as a copy of its file,
// so its $id names that release. The repository holds the tree in
// packages/packet/releases/, which the schema's host serves as it is, and
// which is empty until the schema is published (handoff-packet: When the
// schema is published).
// - addRelease adds the next release to a tree: the schema with the
//   release's URL as $id, its keys sorted and two-space indented, as every
//   generated file of the repository; every earlier release's file is kept
//   byte for byte; and v1.json becomes the new release's file. It refuses a
//   release that exists, one that skips the next, one outside v1, and a
//   schema that is still beta.
// - releaseTreeProblems checks a tree: only release files and v1.json,
//   releases from v1.0 on with no gap, each with its URL as $id, and v1.json
//   the latest release byte for byte.
// - releaseHistoryProblems checks the repository's history: a release's file
//   that any commit published is in the working tree with exactly those
//   bytes.
// Whether a candidate may be released at all, because it only adds optional
// fields, is the forward-compatibility check's (packet-forward.ts).

/** Where the release URLs live: the schema's host serves the tree's files under this address. */
export const RELEASE_BASE = "https://tiehall.com/schemas/packet/";

/** The tree's folder, relative to the repository's root. */
export const RELEASES_FOLDER = "packages/packet/releases";

/** The file that serves the latest v1.x release. */
export const LATEST_V1 = "v1.json";

/** A release's file: v1.<minor>.json. */
const RELEASE_FILE = /^v1\.(0|[1-9]\d*)\.json$/;

/** A v1 release's version: 1.<minor>. */
const RELEASE_VERSION = /^1\.(0|[1-9]\d*)$/;

/** The tree's files, by name, such as v1.0.json, each with its text. */
export type ReleaseTree = ReadonlyMap<string, string>;

type Json = Record<string, unknown>;

/** A release's URL, which is also its $id. */
export function releaseUrl(version: string): string {
  return `${RELEASE_BASE}v${version}.json`;
}

/** The versions the tree publishes, oldest first, such as ["1.0", "1.1"]. */
export function releasedVersions(tree: ReleaseTree): string[] {
  return [...tree.keys()]
    .map((name) => RELEASE_FILE.exec(name)?.[1])
    .filter((minor): minor is string => minor !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
    .map((minor) => `1.${minor}`);
}

/** A JSON value with every object's keys sorted. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Json)[key])]),
  );
}

/** Whether a schema fixes schema_version to the beta value anywhere. */
function isBeta(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(isBeta);
  if (typeof schema !== "object" || schema === null) return false;
  const node = schema as Json;
  const version = (node["properties"] as Json | undefined)?.["schema_version"] as Json | undefined;
  if (version !== undefined && (version["const"] === "1-beta" || (Array.isArray(version["enum"]) && version["enum"].includes("1-beta")))) return true;
  return Object.values(node).some(isBeta);
}

/**
 * The tree with the next release added: the schema with the release's URL as
 * its $id, every earlier release's file as it was, and v1.json moved to the
 * new release. The version, such as 1.1, defaults to the next one.
 */
export function addRelease(tree: ReleaseTree, schema: string, version?: string): ReleaseTree {
  const released = releasedVersions(tree);
  const next = `1.${released.length}`;
  const chosen = version ?? next;
  if (!RELEASE_VERSION.test(chosen)) throw new Error(`The tree holds the releases of v1, v1.0, v1.1 and on; ${chosen} is not one.`);
  if (released.includes(chosen)) throw new Error(`v${chosen} is published already, and a published release never changes; the next release is v${next}.`);
  if (chosen !== next) throw new Error(`The next release is v${next}, not v${chosen}: releases follow one another.`);
  const parsed = JSON.parse(schema) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("The schema is not a JSON object.");
  if (isBeta(parsed)) {
    throw new Error('The schema fixes schema_version to "1-beta": a beta schema is not a release. Turn the publication switch on and regenerate the schema first.');
  }
  const text = `${JSON.stringify(sortKeys({ ...(parsed as Json), $id: releaseUrl(chosen) }), null, 2)}\n`;
  const added = new Map(tree);
  added.set(`v${chosen}.json`, text);
  added.set(LATEST_V1, text);
  return added;
}

/** Every rule the tree breaks, as a sentence; none for a well-formed tree, or an empty one. */
export function releaseTreeProblems(tree: ReleaseTree): string[] {
  const problems: string[] = [];
  for (const name of [...tree.keys()].sort()) {
    if (name !== LATEST_V1 && !RELEASE_FILE.test(name)) problems.push(`${name} is not a release: the tree holds v1.<minor>.json files and v1.json.`);
  }
  const released = releasedVersions(tree);
  if (released.length === 0) {
    if (tree.has(LATEST_V1)) problems.push(`${LATEST_V1} is in the tree before any release.`);
    return problems;
  }
  released.forEach((version, index) => {
    if (version !== `1.${index}`) {
      problems.push(`The tree has no v1.${index}.json: releases start at v1.0 and follow one another.`);
    }
  });
  for (const version of released) {
    const name = `v${version}.json`;
    let id: unknown;
    try {
      id = (JSON.parse(tree.get(name) ?? "") as Json)["$id"];
    } catch {
      problems.push(`${name} is not JSON.`);
      continue;
    }
    if (id !== releaseUrl(version)) problems.push(`${name} has the $id ${String(id)}; a release's $id is its URL, ${releaseUrl(version)}.`);
  }
  const latest = `v${released.at(-1) ?? ""}.json`;
  const served = tree.get(LATEST_V1);
  if (served === undefined) problems.push(`${LATEST_V1} is missing: it serves ${latest}, the latest v1.x release.`);
  else if (served !== tree.get(latest)) problems.push(`${LATEST_V1} is not ${latest}, the latest v1.x release, byte for byte.`);
  return [...new Set(problems)];
}

/** The tree a folder holds; an empty tree when the folder does not exist. */
export function readReleaseTree(folder: string): ReleaseTree {
  if (!existsSync(folder)) return new Map();
  return new Map(
    readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, readFileSync(join(folder, entry.name), "utf8")]),
  );
}

/** Writes a tree's files into a folder. */
export function writeReleaseTree(folder: string, tree: ReleaseTree): void {
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of tree) writeFileSync(join(folder, name), text);
}

/** Every release's file that a commit of the repository at this root published and the working tree changed or removed. */
export function releaseHistoryProblems(root: string): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const lines = (text: string) => text.split("\n").filter((line) => line !== "");
  const current = readReleaseTree(join(root, RELEASES_FOLDER));
  const problems = new Set<string>();
  for (const commit of lines(git("log", "--format=%H", "HEAD", "--", RELEASES_FOLDER))) {
    for (const path of lines(git("ls-tree", "-r", "--name-only", commit, "--", `${RELEASES_FOLDER}/`))) {
      const name = path.slice(RELEASES_FOLDER.length + 1);
      if (!RELEASE_FILE.test(name)) continue;
      const now = current.get(name);
      if (now === undefined) problems.add(`${name} was published and is gone; a published release is never removed.`);
      else if (now !== git("show", `${commit}:${path}`)) problems.add(`${name} differs from what an earlier commit published; a published release never changes.`);
    }
  }
  return [...problems].sort();
}

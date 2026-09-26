import { fileURLToPath } from "node:url";

// The API changelog (public-api: The `api-breaking` label for urgent security
// fixes; public-api: The changelog page and the release notes; D28 #28).
// openapi/changelog.json holds the maintainers' dated entries: a pull request
// that must announce something about the API, such as the breaking change of
// an urgent security fix, adds its entry under `unreleased`, and the entry is
// shown with the release that carries it. `releases` holds what each release
// changed. The compatibility check in CI reads the file at a pull request's
// merge base and in the pull request, so this module imports nothing outside
// Node and runs in that job without the catalog's own dependencies.

/** The label a pull request carries to make a breaking change without notice, for an urgent security fix. */
export const API_BREAKING_LABEL = "api-breaking";

/**
 * The kinds of entry: `breaking`, a breaking change released without the
 * usual notice, which the api-breaking label needs; `note`, anything else the
 * maintainers announce.
 */
export const CHANGELOG_ENTRY_KINDS = ["breaking", "note"] as const;
export type ChangelogEntryKind = (typeof CHANGELOG_ENTRY_KINDS)[number];

/** One entry the maintainers wrote. */
export interface ChangelogEntry {
  /** The calendar day the entry was written, such as 2026-11-02; a notice counts from it. */
  date: string;
  kind: ChangelogEntryKind;
  /** What changed and what a client does about it, in the maintainers' words. */
  text: string;
  /** The ids of the operations it is about, such as requests.get. */
  operationIds?: string[];
}

export interface Changelog {
  /** The entries of the changes no release carries yet. */
  unreleased: ChangelogEntry[];
  /** What each release changed, newest first. */
  releases: unknown[];
}

/** A changelog file that breaks the format; its message names every problem, one per line. */
export class ChangelogError extends Error {
  override name = "ChangelogError";
}

/** openapi/changelog.json, next to the document it describes. */
export const COMMITTED_CHANGELOG = fileURLToPath(new URL("../../../openapi/changelog.json", import.meta.url));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPERATION_ID = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const ENTRY_FIELDS = new Set(["date", "kind", "text", "operationIds"]);
const TOP_LEVEL_FIELDS = new Set(["$comment", "unreleased", "releases"]);

/** The changelog in this JSON text; throws ChangelogError naming every problem when it breaks the format. */
export function parseChangelog(text: string): Changelog {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ChangelogError("The changelog is not JSON.");
  }
  if (!isObject(value)) throw new ChangelogError("The changelog is a JSON object with unreleased and releases.");
  const problems: string[] = [];
  for (const key of Object.keys(value)) if (!TOP_LEVEL_FIELDS.has(key)) problems.push(`${key} is not a field of the changelog.`);
  const { unreleased, releases } = value;
  if (!Array.isArray(unreleased)) problems.push("unreleased is a list of entries.");
  else unreleased.forEach((entry, index) => problems.push(...entryProblems(entry).map((problem) => `unreleased[${index}]: ${problem}`)));
  if (!Array.isArray(releases)) problems.push("releases is a list of releases.");
  if (problems.length > 0) throw new ChangelogError(problems.join("\n"));
  return { unreleased: unreleased as ChangelogEntry[], releases: releases as unknown[] };
}

function entryProblems(entry: unknown): string[] {
  if (!isObject(entry)) return ["an entry is an object with a date, a kind and a text."];
  const problems: string[] = [];
  const { date, kind, text, operationIds } = entry;
  if (typeof date !== "string" || !isDate(date)) problems.push("date is a calendar day, such as 2026-12-15.");
  if (!(CHANGELOG_ENTRY_KINDS as readonly unknown[]).includes(kind)) problems.push(`kind is one of ${CHANGELOG_ENTRY_KINDS.join(", ")}.`);
  if (typeof text !== "string" || text.trim() === "") problems.push("text says what changed.");
  if (operationIds !== undefined && (!Array.isArray(operationIds) || !operationIds.every((id) => typeof id === "string" && OPERATION_ID.test(id)))) {
    problems.push("operationIds lists operation ids, such as requests.get.");
  }
  for (const key of Object.keys(entry)) if (!ENTRY_FIELDS.has(key)) problems.push(`${key} is not a field of an entry.`);
  return problems;
}

/**
 * The unreleased entries of a pull request's changelog that its merge base did
 * not hold, an edited entry included; every entry when the merge base had no
 * changelog.
 */
export function addedEntries(base: Changelog | undefined, revision: Changelog): ChangelogEntry[] {
  const before = new Set((base?.unreleased ?? []).map(canonical));
  return revision.unreleased.filter((entry) => !before.has(canonical(entry)));
}

function canonical(entry: ChangelogEntry): string {
  return JSON.stringify([entry.date, entry.kind, entry.text, entry.operationIds ?? []]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A real calendar day written as YYYY-MM-DD. */
function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}

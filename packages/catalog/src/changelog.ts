
// The API changelog (public-api: The `api-breaking` label for urgent security
// fixes; public-api: The changelog page and the release notes; D28 #28).
// openapi/changelog.json holds the maintainers' dated entries: a pull request
// that must announce something about the API, such as the breaking change of
// an urgent security fix, adds its entry under `unreleased`, and the entry is
// shown with the release that carries it. `releases` holds what each release
// changed, newest first: when a release is made, the pinned oasdiff's
// changelog of openapi/v1.json since the previous release is recorded with
// the unreleased entries (design.md, Technical decisions: T12). A release
// candidate, such as 1.4.0-rc.1, gets no record of its own: every change and
// every entry, the hand-written ones included, is recorded under its final
// version (design.md, Technical decisions: T13, R-e). The changelog
// page at /docs/api/changelog and each release's notes show the same items,
// which releaseItems() gives. The compatibility check in CI reads the file at
// a pull request's merge base and in the pull request, so this module imports
// nothing outside Node and runs in that job without the catalog's own
// dependencies.

/** The label a pull request carries to make a breaking change without notice, for an urgent security fix. */
export const API_BREAKING_LABEL = "api-breaking";

/**
 * The kinds of entry: `breaking`, a breaking change released without the
 * usual notice, which the api-breaking label needs; `note`, anything else the
 * maintainers announce; `graduation`, the maintainers' decision to graduate
 * the operations it names to stable, dated the day they decided, which an
 * operation needs before it carries x-stability-level stable (public-api:
 * Each operation graduates on its own; tools/repo-checks/src/graduation.ts).
 */
export const CHANGELOG_ENTRY_KINDS = ["breaking", "note", "graduation"] as const;
export type ChangelogEntryKind = (typeof CHANGELOG_ENTRY_KINDS)[number];

/**
 * The schemas an entry can be about, next to the operations it names: the
 * packet, whose breaking changes before publication are announced here, with the
 * api-breaking label, at least 14 days before a release contains them
 * (handoff-packet: Breaking packet changes before publication).
 */
export const CHANGELOG_SCHEMAS = ["packet"] as const;
export type ChangelogSchema = (typeof CHANGELOG_SCHEMAS)[number];

/** One entry the maintainers wrote. */
export interface ChangelogEntry {
  /** The calendar day the entry was written, such as 2026-11-02; a notice counts from it. */
  date: string;
  kind: ChangelogEntryKind;
  /** What changed and what a client does about it, in the maintainers' words. */
  text: string;
  /** The ids of the operations it is about, such as requests.get. */
  operationIds?: string[];
  /** The schemas it is about, such as packet. */
  schemas?: ChangelogSchema[];
}

/** One change oasdiff's changelog found between two releases' documents. */
export interface ApiChange {
  /** oasdiff's id for the kind of change, such as endpoint-deprecated-with-sunset. */
  id: string;
  /** 3 for an error (a breaking change), 2 for a warning, 1 for information. */
  level: 1 | 2 | 3;
  method?: string;
  path?: string;
  operationId?: string;
  /** oasdiff's sentence, with names and values in backticks. */
  text: string;
}

/** What one release changed in the API. */
export interface ChangelogRelease {
  /** Tiehall's release, such as 1.4.0. */
  version: string;
  /** The calendar day of the release. */
  date: string;
  /** The OpenAPI document's info.version in the release, such as 0.4.0. */
  apiVersion: string;
  /** The maintainers' entries that the release carries. */
  entries: ChangelogEntry[];
  /** The changes to the document since the previous release. */
  changes: ApiChange[];
}

export interface Changelog {
  /** The entries of the changes no release carries yet. */
  unreleased: ChangelogEntry[];
  /** What each release changed, newest first. */
  releases: ChangelogRelease[];
}

/** One line of a release on the changelog page and in its notes. */
export interface ChangelogItem {
  /** A maintainers' entry by its kind, or a change by its level. */
  kind: ChangelogEntryKind | "error" | "warning" | "info";
  method?: string;
  path?: string;
  operationIds?: string[];
  /** The text, with names and values in backticks. */
  text: string;
}

/** A changelog file that breaks the format; its message names every problem, one per line. */
export class ChangelogError extends Error {
  override name = "ChangelogError";
}


const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A final release's version: a release candidate's, such as 1.4.0-rc.1, gets no record of its own. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const CANDIDATE_VERSION = /^(\d+\.\d+\.\d+)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;
const API_VERSION = /^\d+\.\d+\.\d+$/;
const RELEASE_FIELDS = new Set(["version", "date", "apiVersion", "entries", "changes"]);
const CHANGE_FIELDS = new Set(["id", "level", "method", "path", "operationId", "text"]);
const OPERATION_ID = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const ENTRY_FIELDS = new Set(["date", "kind", "text", "operationIds", "schemas"]);
const TOP_LEVEL_FIELDS = new Set(["$comment", "unreleased", "releases"]);

/**
 * The final version a release candidate's version names, such as 1.4.0 for 1.4.0-rc.1, under which its changes and
 * entries are recorded; undefined for a final release's version.
 */
export function finalVersionOf(version: string): string | undefined {
  return CANDIDATE_VERSION.exec(version)?.[1];
}

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
  else releases.forEach((release, index) => problems.push(...releaseProblems(release, `releases[${index}]`)));
  if (problems.length > 0) throw new ChangelogError(problems.join("\n"));
  return { unreleased: unreleased as ChangelogEntry[], releases: releases as ChangelogRelease[] };
}

function releaseProblems(release: unknown, at: string): string[] {
  if (!isObject(release)) return [`${at}: a release is an object with a version, a date, an apiVersion, entries and changes.`];
  const problems: string[] = [];
  const { version, date, apiVersion, entries, changes } = release;
  const final = typeof version === "string" ? finalVersionOf(version) : undefined;
  if (final !== undefined) {
    problems.push(
      `${at}: version ${version as string} is a release candidate's, which gets no record of its own: its changes and entries are recorded under the final version, ${final}.`,
    );
  } else if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
    problems.push(`${at}: version is a release version, such as 1.4.0.`);
  }
  if (typeof date !== "string" || !isDate(date)) problems.push(`${at}: date is a calendar day, such as 2026-12-15.`);
  if (typeof apiVersion !== "string" || !API_VERSION.test(apiVersion)) {
    problems.push(`${at}: apiVersion is the document's info.version, such as 0.4.0.`);
  }
  for (const key of Object.keys(release)) if (!RELEASE_FIELDS.has(key)) problems.push(`${at}: ${key} is not a field of a release.`);
  if (!Array.isArray(entries)) problems.push(`${at}: entries is a list of entries.`);
  else entries.forEach((entry, index) => problems.push(...entryProblems(entry).map((problem) => `${at}.entries[${index}]: ${problem}`)));
  if (!Array.isArray(changes)) problems.push(`${at}: changes is a list of changes.`);
  else changes.forEach((change, index) => problems.push(...changeProblems(change).map((problem) => `${at}.changes[${index}]: ${problem}`)));
  return problems;
}

function changeProblems(change: unknown): string[] {
  if (!isObject(change)) return ["a change is an object with an id, a level and a text."];
  const problems: string[] = [];
  const { id, level, text } = change;
  if (typeof id !== "string" || id === "") problems.push("id is the checker's id for the change.");
  if (level !== 1 && level !== 2 && level !== 3) problems.push("level is 1 (information), 2 (warning) or 3 (error).");
  if (typeof text !== "string" || text.trim() === "") problems.push("text says what changed.");
  for (const key of ["method", "path", "operationId"]) {
    if (change[key] !== undefined && typeof change[key] !== "string") problems.push(`${key} is a string.`);
  }
  for (const key of Object.keys(change)) if (!CHANGE_FIELDS.has(key)) problems.push(`${key} is not a field of a change.`);
  return problems;
}

const LEVELS = { 3: "error", 2: "warning", 1: "info" } as const;

/**
 * The lines of a release, as the changelog page and the release notes show
 * them: the maintainers' entries first, then the changes, most severe first,
 * each kind in the order the checker gave.
 */
export function releaseItems(release: Pick<ChangelogRelease, "entries" | "changes">): ChangelogItem[] {
  const entries = release.entries.map(({ kind, text, operationIds }): ChangelogItem => ({
    kind,
    ...(operationIds === undefined ? {} : { operationIds }),
    text,
  }));
  const changes = [...release.changes]
    .sort((a, b) => b.level - a.level)
    .map(({ level, method, path, operationId, text }): ChangelogItem => ({
      kind: LEVELS[level],
      ...(method === undefined ? {} : { method }),
      ...(path === undefined ? {} : { path }),
      ...(operationId === undefined ? {} : { operationIds: [operationId] }),
      text,
    }));
  return [...entries, ...changes];
}

function entryProblems(entry: unknown): string[] {
  if (!isObject(entry)) return ["an entry is an object with a date, a kind and a text."];
  const problems: string[] = [];
  const { date, kind, text, operationIds, schemas } = entry;
  if (typeof date !== "string" || !isDate(date)) problems.push("date is a calendar day, such as 2026-12-15.");
  if (!(CHANGELOG_ENTRY_KINDS as readonly unknown[]).includes(kind)) problems.push(`kind is one of ${CHANGELOG_ENTRY_KINDS.join(", ")}.`);
  if (typeof text !== "string" || text.trim() === "") problems.push("text says what changed.");
  if (operationIds !== undefined && (!Array.isArray(operationIds) || !operationIds.every((id) => typeof id === "string" && OPERATION_ID.test(id)))) {
    problems.push("operationIds lists operation ids, such as requests.get.");
  }
  if (schemas !== undefined && (!Array.isArray(schemas) || !schemas.every((name) => (CHANGELOG_SCHEMAS as readonly unknown[]).includes(name)))) {
    problems.push(`schemas lists schemas, of ${CHANGELOG_SCHEMAS.join(", ")}.`);
  }
  if (kind === "graduation") {
    if (!Array.isArray(operationIds) || operationIds.length === 0) problems.push("a graduation names the operations it graduates in operationIds.");
    if (schemas !== undefined) problems.push("a graduation is about operations, so it names no schemas.");
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
  return JSON.stringify([entry.date, entry.kind, entry.text, entry.operationIds ?? [], entry.schemas ?? []]);
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

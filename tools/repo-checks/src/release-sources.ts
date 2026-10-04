import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangelog, type ChangelogRelease } from "@tiehall/catalog/changelog";
import { compareVersions, isVersion } from "@tiehall/core";

// What a release's notes say besides its image (public-api: The changelog page
// and the release notes; self-host-install: Migrations expand, then contract;
// self-host-install: Upgrades apply migrations before the app starts):
// - the release's API changes, as `pnpm changelog:release` recorded them in
//   openapi/changelog.json before the release was tagged, the same entries the
//   changelog page of an install running it lists;
// - the contract steps it adds since the previous release: the migrations of
//   packages/db/migrations marked `-- migrate: contract after <release>` that
//   the previous release's tag does not hold. A contract step ships at least
//   one release after the expand step it follows, so its expand release must
//   be out already: no later than the previous release, and the first release
//   holds no contract step;
// - every release up to this one that must not be skipped, which the
//   maintainers list in release/no-skip.json with the reason, such as a
//   background job of that release that a later contract step relies on.

/** The migrations folder, relative to the repository's root, as drizzle-kit writes it. */
export const MIGRATIONS = "packages/db/migrations";

/** The maintainers' list of the releases an install must not skip, relative to the repository's root. */
export const NO_SKIP_LIST = "release/no-skip.json";

const CHANGELOG = "openapi/changelog.json";
const DOCUMENT = "openapi/v1.json";

export interface ContractStep {
  /** The migration's tag, such as 0042_drop_name. */
  migration: string;
  /** The release of the expand step it follows, such as 1.3.0. */
  after: string;
}

export interface NoSkipRelease {
  /** The release that must not be skipped, such as 1.3.0. */
  version: string;
  /** Why, in the maintainers' words: a sentence. */
  reason: string;
}

export interface ReleaseSources {
  api: ChangelogRelease;
  contractSteps: ContractStep[];
  noSkip: NoSkipRelease[];
}

interface Journal {
  entries?: { idx: number; tag: string }[];
}

/** The release a migration's text marks it a contract step after, from the comment lines it starts with; undefined for none. */
export function contractAfter(text: string): string | undefined {
  for (const line of text.split("\n").map((each) => each.trim())) {
    if (line === "") continue;
    if (!line.startsWith("--") || line.startsWith("--> statement-breakpoint")) break;
    const after = /^--\s*migrate:\s*contract\s+after\s+(\d+\.\d+\.\d+)\s*$/.exec(line)?.[1];
    if (after !== undefined) return after;
  }
  return undefined;
}

/** A file of the repository: in the working tree, or at a git ref such as v1.3.0. */
function readAt(root: string, file: string, ref?: string): string {
  if (ref === undefined) return readFileSync(join(root, file), "utf8");
  return execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The migrations' tags in journal order, with the release each contract step follows, in the working tree or at a ref. */
export function migrations(root: string, ref?: string): { id: string; after: string | undefined }[] {
  const journal = JSON.parse(readAt(root, `${MIGRATIONS}/meta/_journal.json`, ref)) as Journal;
  return [...(journal.entries ?? [])]
    .sort((a, b) => a.idx - b.idx)
    .map(({ tag }) => ({ id: tag, after: contractAfter(readAt(root, `${MIGRATIONS}/${tag}.sql`, ref)) }));
}

/** The contract steps the working tree adds since the previous release's tag, refusing one whose expand release is not out. */
export function newContractSteps(root: string, version: string, previous: string | undefined): ContractStep[] {
  const before = new Set(previous === undefined ? [] : migrations(root, previous).map(({ id }) => id));
  const steps = migrations(root)
    .filter(({ id, after }) => after !== undefined && !before.has(id))
    .map(({ id, after }) => ({ migration: id, after: after as string }));
  for (const { migration, after } of steps) {
    if (previous === undefined) {
      throw new Error(
        `The migration ${migration} is a contract step, and the first release can hold none: a contract step ships at least one release after its expand step.`,
      );
    }
    if (compareVersions(after, version) >= 0 || compareVersions(after, previous.slice(1)) > 0) {
      throw new Error(
        `The migration ${migration} is a contract step after the expand step of ${after}, which is not a release before this one: ` +
          `a contract step ships at least one release after its expand step, which ${previous}, the previous release, must hold.`,
      );
    }
  }
  return steps;
}

/** The maintainers' list of the releases an install must not skip, refusing one that is not well formed. */
export function noSkipReleases(root: string): NoSkipRelease[] {
  const file = join(root, NO_SKIP_LIST);
  if (!existsSync(file)) throw new Error(`${NO_SKIP_LIST} is missing: it lists the releases an install must not skip, and may list none.`);
  const list = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const releases = typeof list === "object" && list !== null && !Array.isArray(list) ? (list as { releases?: unknown }).releases : undefined;
  if (!Array.isArray(releases)) throw new Error(`${NO_SKIP_LIST} holds an object with a list of releases, each with its version and reason.`);
  const seen = new Set<string>();
  return releases.map((entry: unknown, index) => {
    const { version, reason } = (typeof entry === "object" && entry !== null ? entry : {}) as { version?: unknown; reason?: unknown };
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || !isVersion(version) || typeof reason !== "string" || reason.trim() === "") {
      throw new Error(`${NO_SKIP_LIST}: releases[${index}] names a release version, such as 1.3.0, and the reason in a sentence.`);
    }
    if (seen.has(version)) throw new Error(`${NO_SKIP_LIST} names release ${version} twice.`);
    seen.add(version);
    return { version, reason: reason.trim() };
  });
}

/** The API changes openapi/changelog.json records for the release, refusing a release it does not record or records stale. */
export function recordedApiChanges(root: string, version: string, previous: string | undefined): ChangelogRelease {
  const release = parseChangelog(readFileSync(join(root, CHANGELOG), "utf8")).releases.find((each) => each.version === version);
  if (release === undefined) {
    throw new Error(
      `${CHANGELOG} records no release ${version}: record it with pnpm changelog:release ${version}${previous === undefined ? "" : ` --previous ${previous}`}, ` +
        "and merge that, before tagging the release.",
    );
  }
  const apiVersion = (JSON.parse(readFileSync(join(root, DOCUMENT), "utf8")) as { info?: { version?: string } }).info?.version;
  if (apiVersion !== release.apiVersion) {
    throw new Error(
      `${CHANGELOG} records release ${version} with the API at version ${release.apiVersion}, but ${DOCUMENT} is at version ${apiVersion ?? "none"}: ` +
        "the document changed after the release was recorded, so record the release again.",
    );
  }
  return release;
}

/** What the release's notes say besides its image, read from the repository at root, whose previous release is the tag previous. */
export function releaseSources(root: string, version: string, previous: string | undefined): ReleaseSources {
  return {
    api: recordedApiChanges(root, version, previous),
    contractSteps: newContractSteps(root, version, previous),
    noSkip: noSkipReleases(root).filter((entry) => compareVersions(entry.version, version) <= 0),
  };
}

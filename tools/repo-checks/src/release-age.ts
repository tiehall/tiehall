import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// Reviewed exceptions to the release age (self-host-install: Release pipeline
// integrity; decisions-from-groups-15-28: design.md, Decisions this change
// rests on: D55 (86); Technical decisions: T16). pnpm resolves only versions
// published at least 7 days ago (minimumReleaseAge in pnpm-workspace.yaml),
// the same age Renovate waits for. When the image scan reports a fixable HIGH
// or CRITICAL finding in Node's binary or in an npm package, and the fixed
// version is younger than that, a reviewed pull request may take exactly the
// version the advisory names as fixed before it is 7 days old: it excludes
// that one version from the release age (minimumReleaseAgeExclude, as
// `<package>@<version>`), records the exception in
// tools/repo-checks/release-age-exceptions.json with the advisory, the label
// release-age-exception and the day the version turns 7 days old, and carries
// that label. Such an update is never proposed or merged automatically.
//
// The workflow check (pnpm check:workflows, workflows.ts) fails an exclusion
// that names a package without one exact version, one the list does not
// record, a record without its advisory, its label or its day, one whose day
// has passed, which is then removed with its exclusion, and a record of an
// exclusion the workspace does not make, so the list holds exactly the
// exceptions in force. The API-compatibility workflow's label step
// (check-release-age-label.ts) fails a pull request that adds an exclusion
// without the label, and the release notes list the exceptions a release
// carries (release-notes.ts).

/** Where the list of exceptions lives, relative to the repository's root. */
export const RELEASE_AGE_EXCEPTIONS = "tools/repo-checks/release-age-exceptions.json";

/** The label a pull request that adds an exception carries. */
export const RELEASE_AGE_LABEL = "release-age-exception";

/** An exception to the release age, as the list records it. */
export interface ReleaseAgeException {
  /** The package, such as undici or @octokit/request. */
  package: string;
  /** The one exact version the exception lets in, the one the advisory names as fixed. */
  version: string;
  /** The advisory that names the version as fixed, such as GHSA-xxxx-xxxx-xxxx or CVE-2026-12345. */
  advisory: string;
  /** The label of the pull request that adds it: release-age-exception. */
  label: string;
  /** The day the version turns 7 days old, after which the exception must go, such as 2026-10-19. */
  agedOn: string;
}

/** A violation of the rule, as the workflow check reports it: the file it is in, and what is wrong. */
export interface ReleaseAgeViolation {
  rule: "release-age";
  file: string;
  detail: string;
}

/** An npm package name, scoped or not, and one exact version of it. */
const EXACT_VERSION = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const ADVISORY = /^(?:GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The exclusions from the release age that pnpm reads from a pnpm-workspace.yaml's text, as written. */
export function exclusionsIn(workspace: string | undefined): string[] {
  if (workspace === undefined) return [];
  const settings = parse(workspace) as unknown;
  const excluded = isMapping(settings) ? settings["minimumReleaseAgeExclude"] : undefined;
  return Array.isArray(excluded) ? excluded.map((entry) => String(entry)) : [];
}

/** The exclusions from the release age the repository at this root makes, in pnpm-workspace.yaml and package.json's pnpm settings. */
export function exclusionsAt(root: string): { file: string; entry: string }[] {
  const found: { file: string; entry: string }[] = [];
  const workspace = join(root, "pnpm-workspace.yaml");
  if (existsSync(workspace)) found.push(...exclusionsIn(readFileSync(workspace, "utf8")).map((entry) => ({ file: "pnpm-workspace.yaml", entry })));
  const manifest = join(root, "package.json");
  if (existsSync(manifest)) {
    const pnpm = (JSON.parse(readFileSync(manifest, "utf8")) as Mapping)["pnpm"];
    const excluded = isMapping(pnpm) ? pnpm["minimumReleaseAgeExclude"] : undefined;
    if (Array.isArray(excluded)) found.push(...excluded.map((entry) => ({ file: "package.json", entry: String(entry) })));
  }
  return found;
}

/** The list's records as written, each a mapping; none when the list is missing. */
function recordsAt(root: string): Mapping[] | undefined {
  const file = join(root, RELEASE_AGE_EXCEPTIONS);
  if (!existsSync(file)) return undefined;
  const list = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const exceptions = isMapping(list) ? list["exceptions"] : undefined;
  if (!Array.isArray(exceptions)) throw new Error(`${RELEASE_AGE_EXCEPTIONS} holds an object with a list of exceptions, which may be empty.`);
  return exceptions.map((each) => (isMapping(each) ? each : {}));
}

/** The exceptions to the release age the repository at this root records, which its release notes list; none when it records none. */
export function releaseAgeExceptions(root: string): ReleaseAgeException[] {
  return (recordsAt(root) ?? []).map((record) => ({
    package: String(record["package"] ?? ""),
    version: String(record["version"] ?? ""),
    advisory: String(record["advisory"] ?? ""),
    label: String(record["label"] ?? ""),
    agedOn: String(record["agedOn"] ?? ""),
  }));
}

/** Whether a day is a real calendar day, written as YYYY-MM-DD. */
function isDay(value: string): boolean {
  return DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/**
 * The violations of the rule on exceptions to the release age, for the
 * repository at this root on this UTC day (YYYY-MM-DD).
 */
export function releaseAgeViolations(root: string, today: string): ReleaseAgeViolation[] {
  const violations: ReleaseAgeViolation[] = [];
  const violation = (file: string, detail: string) => violations.push({ rule: "release-age", file, detail });
  const exceptions = releaseAgeExceptions(root);
  const recorded = new Map(exceptions.map((exception) => [`${exception.package}@${exception.version}`, exception]));
  const excluded = new Set<string>();
  for (const { file, entry } of exclusionsAt(root)) {
    if (!EXACT_VERSION.test(entry)) {
      violation(file, `the exclusion ${JSON.stringify(entry)} must name one package at one exact version, such as undici@7.16.1`);
      continue;
    }
    excluded.add(entry);
    const exception = recorded.get(entry);
    if (exception === undefined) {
      violation(file, `${entry} is excluded from the release age, but ${RELEASE_AGE_EXCEPTIONS} records no such exception`);
    } else if (isDay(exception.agedOn) && today > exception.agedOn) {
      violation(
        file,
        `${entry} turned 7 days old on ${exception.agedOn}, so it needs no exception any more: remove its exclusion from the release age and its record`,
      );
    }
  }
  for (const exception of exceptions) {
    const name = `${exception.package}@${exception.version}`;
    const record = (what: string) => violation(RELEASE_AGE_EXCEPTIONS, `the exception for ${name} must record ${what}`);
    if (!EXACT_VERSION.test(name)) record("one package and one exact version of it, such as undici and 7.16.1");
    if (!ADVISORY.test(exception.advisory)) record("the advisory that names the version as fixed, such as GHSA-xxxx-xxxx-xxxx or CVE-2026-12345");
    if (exception.label !== RELEASE_AGE_LABEL) record(`the label ${RELEASE_AGE_LABEL}`);
    if (!isDay(exception.agedOn)) record("the day the version turns 7 days old, such as 2026-10-19");
    if (EXACT_VERSION.test(name) && !excluded.has(name)) {
      violation(RELEASE_AGE_EXCEPTIONS, `it records an exception for ${name}, which pnpm-workspace.yaml does not exclude from the release age`);
    }
  }
  return violations;
}

/**
 * What the label step finds wrong with a pull request: an exclusion from the
 * release age that it adds, against its merge base, without the
 * release-age-exception label.
 */
export function releaseAgeLabelProblems({ base, revision, labels }: { base: readonly string[]; revision: readonly string[]; labels: readonly string[] }): string[] {
  if (labels.includes(RELEASE_AGE_LABEL)) return [];
  const before = new Set(base);
  return revision
    .filter((entry) => !before.has(entry))
    .map((entry) => `This pull request excludes ${entry} from the 7-day release age, which only a reviewed pull request with the ${RELEASE_AGE_LABEL} label may do.`);
}

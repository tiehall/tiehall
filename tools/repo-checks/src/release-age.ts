import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// Reviewed exceptions to the release age (self-host-install: Release pipeline
// integrity; decisions-from-groups-15-28: design.md, Decisions this change
// rests on: D55 (86); Technical decisions: T16; release-age-maintainer-exception:
// design.md, Decisions this change rests on; Technical decisions: T1). pnpm
// resolves only versions published at least 7 days ago (minimumReleaseAge in
// pnpm-workspace.yaml), the same age Renovate waits for. A reviewed pull
// request may take a version younger than that in two cases: exactly the
// version an advisory names as fixed, when the image scan reports a fixable
// HIGH or CRITICAL finding in Node's binary or in an npm package; or exactly
// the version of an npm package that a maintainer's recorded answer calls
// for, once a supply-chain review of that version comes out clean. Either way
// it excludes that one version from the release age
// (minimumReleaseAgeExclude, as `<package>@<version>`), records the exception
// in tools/repo-checks/release-age-exceptions.json with the label
// release-age-exception and the day the version turns 7 days old, and carries
// that label. The record names the advisory, or, in its place, the answer, by
// the day it was given and where it is recorded, and the review, by its day
// and where it is recorded, with what it compared, the version's provenance,
// its install scripts and its dependencies; never both. Such an update is
// never proposed or merged automatically.
//
// The workflow check (pnpm check:workflows, workflows.ts) fails an exclusion
// that names a package without one exact version, one the list does not
// record, a record without its label or its day, a record that names neither
// an advisory nor an answer or names both, an advisory that is none, an
// answer or a review without one of its parts, a record whose day has passed,
// which is then removed with its exclusion, and a record of an exclusion the
// workspace does not make, so the list holds exactly the exceptions in
// force. The API-compatibility workflow's label step
// (check-release-age-label.ts) fails a pull request that adds an exclusion
// without the label, and the release notes list the exceptions a release
// carries (release-notes.ts).

/** Where the list of exceptions lives, relative to the repository's root. */
export const RELEASE_AGE_EXCEPTIONS = "tools/repo-checks/release-age-exceptions.json";

/** The label a pull request that adds an exception carries. */
export const RELEASE_AGE_LABEL = "release-age-exception";

/** The maintainer's answer that calls for an update, as an exception's record names it. */
export interface MaintainerAnswer {
  /** The day the answer was given, such as 2026-10-16. */
  day: string;
  /** Where the answer is recorded, such as an OpenSpec change's design.md. */
  recordedIn: string;
}

/** The supply-chain review of a version that a maintainer's answer calls for, as an exception's record names it. */
export interface SupplyChainReview {
  /** The day of the review, such as 2026-10-16. */
  day: string;
  /** Where the review is recorded. */
  recordedIn: string;
  /** What the review compared, such as every published file of the old version against the new. */
  compared: string;
  /** The version's provenance, as the review found it: its checksums, signatures and the workflow that published it. */
  provenance: string;
  /** The version's install scripts, as the review found them. */
  scripts: string;
  /** The version's dependencies, as the review found them. */
  dependencies: string;
}

/** An exception to the release age, as the list records it: one that rests on an advisory, or on a maintainer's answer and a review. */
export interface ReleaseAgeException {
  /** The package, such as undici or @octokit/request. */
  package: string;
  /** The one exact version the exception lets in. */
  version: string;
  /** The advisory that names the version as fixed, such as GHSA-xxxx-xxxx-xxxx or CVE-2026-12345; absent for an answer's exception. */
  advisory?: string;
  /** The maintainer's answer that calls for the version; absent for an advisory's exception. */
  answer?: MaintainerAnswer;
  /** The supply-chain review of the version that the answer rests on; absent for an advisory's exception. */
  review?: SupplyChainReview;
  /** The label of the pull request that adds it: release-age-exception. */
  label: string;
  /** The day the version turns 7 days old, after which the exception must go, such as 2026-10-19. */
  agedOn: string;
}

/** The parts of a maintainer's answer, each with what a record that lacks it must record. */
const ANSWER_PARTS: readonly (readonly [keyof MaintainerAnswer, string])[] = [
  ["day", "the day the maintainer's answer that calls for it was given, such as 2026-10-16"],
  ["recordedIn", "where the maintainer's answer that calls for it is recorded"],
];

/** The parts of a supply-chain review, each with what a record that lacks it must record. */
const REVIEW_PARTS: readonly (readonly [keyof SupplyChainReview, string])[] = [
  ["day", "the day of the supply-chain review of the version, such as 2026-10-16"],
  ["recordedIn", "where the supply-chain review of the version is recorded"],
  ["compared", "what the supply-chain review of the version compared"],
  ["provenance", "the version's provenance, as the supply-chain review found it"],
  ["scripts", "the version's install scripts, as the supply-chain review found them"],
  ["dependencies", "the version's dependencies, as the supply-chain review found them"],
];

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

/** A record's part as written: each of these fields as a text, empty when it is missing. */
function textsOf<K extends string>(value: unknown, fields: readonly (readonly [K, string])[]): Record<K, string> {
  const part = isMapping(value) ? value : {};
  return Object.fromEntries(fields.map(([field]) => [field, typeof part[field] === "string" ? part[field] : ""])) as Record<K, string>;
}

/** The exceptions to the release age the repository at this root records, which its release notes list; none when it records none. */
export function releaseAgeExceptions(root: string): ReleaseAgeException[] {
  return (recordsAt(root) ?? []).map((record) => ({
    package: String(record["package"] ?? ""),
    version: String(record["version"] ?? ""),
    ...("advisory" in record ? { advisory: String(record["advisory"] ?? "") } : {}),
    ...("answer" in record ? { answer: textsOf(record["answer"], ANSWER_PARTS) } : {}),
    ...("review" in record ? { review: textsOf(record["review"], REVIEW_PARTS) } : {}),
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
    for (const problem of basisProblems(exception)) record(problem);
    if (exception.label !== RELEASE_AGE_LABEL) record(`the label ${RELEASE_AGE_LABEL}`);
    if (!isDay(exception.agedOn)) record("the day the version turns 7 days old, such as 2026-10-19");
    if (EXACT_VERSION.test(name) && !excluded.has(name)) {
      violation(RELEASE_AGE_EXCEPTIONS, `it records an exception for ${name}, which pnpm-workspace.yaml does not exclude from the release age`);
    }
  }
  return violations;
}

/**
 * What an exception's record lacks of what it rests on, each as what it must
 * record: an advisory that names the version as fixed, or, in its place, the
 * maintainer's answer that calls for the version and the supply-chain review
 * of the version, each with every one of its parts; never both.
 */
function basisProblems({ advisory, answer, review }: ReleaseAgeException): string[] {
  const answered = answer !== undefined || review !== undefined;
  if (advisory !== undefined && answered) return ["either the advisory that names the version as fixed or the maintainer's answer that calls for it, not both"];
  if (advisory !== undefined) return ADVISORY.test(advisory) ? [] : ["the advisory that names the version as fixed, such as GHSA-xxxx-xxxx-xxxx or CVE-2026-12345"];
  if (!answered) {
    return [
      "the advisory that names the version as fixed, such as GHSA-xxxx-xxxx-xxxx or CVE-2026-12345, or the maintainer's answer that calls for it and the supply-chain review of the version",
    ];
  }
  const lacking = (part: Record<string, string>, parts: readonly (readonly [string, string])[]) =>
    parts.filter(([field]) => (field === "day" ? !isDay(part[field] ?? "") : (part[field] ?? "").trim() === "")).map(([, problem]) => problem);
  return [
    ...(answer === undefined
      ? ["the maintainer's answer that calls for it, with the day it was given and where it is recorded"]
      : lacking({ ...answer }, ANSWER_PARTS)),
    ...(review === undefined
      ? ["the supply-chain review of the version, with its day, where it is recorded, what it compared, the version's provenance, its install scripts and its dependencies"]
      : lacking({ ...review }, REVIEW_PARTS)),
  ];
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

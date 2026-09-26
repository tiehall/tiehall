import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addedEntries, API_BREAKING_LABEL, parseChangelog, type Changelog } from "@tiehall/catalog/changelog";
import { oasdiff } from "./oasdiff.ts";

// Notice before a breaking change, enforced in CI (public-api: Notice before a
// breaking change is enforced in CI; public-api: The API version number while
// the API is beta; design.md, Technical decisions: T12). The pinned oasdiff
// compares two OpenAPI documents, the one at a pull request's merge base and
// the pull request's, and the check fails on any error-level finding:
// - a breaking change to a beta or stable operation that skips the notice
//   steps: a sunset date closer than 14 days (beta) or 180 days (stable), a
//   removal before the sunset date, and any other breaking change;
// - a breaking change that leaves info.version as it was, which oasdiff
//   reports as information and this check raises to an error, so that the
//   version is bumped with every breaking change while the API is beta.
// oasdiff itself does not hold alpha operations to the notice rules, reports
// a removal after the sunset date as sanctioned, and does not count a new
// optional response field as breaking. It runs with external $refs off and in
// a folder of its own, so no configuration file of the repository changes it.
//
// The api-breaking label (public-api: The `api-breaking` label for urgent
// security fixes) lets a pull request make a breaking change without the
// notice, which is allowed only for an urgent security fix, and only when the
// pull request also adds a changelog entry of kind breaking to
// openapi/changelog.json and bumps info.version. The breaking change is still
// reported; without all three, the check fails as it does on any breaking
// change. A changelog that does not parse fails the check, label or not,
// because the changelog page is built from it.

export const DEPRECATION_DAYS = { beta: 14, stable: 180 } as const;

/** One of oasdiff's findings: its check's id, its level (3 is an error) and what it says. */
export interface Finding {
  id: string;
  level: number;
  text: string;
  operationId?: string;
  path?: string;
}

export interface CompatResult {
  passed: boolean;
  /** The error-level findings, which fail the check. */
  errors: Finding[];
}

const ERROR = 3;
const WORK = fileURLToPath(new URL("../../../node_modules/.cache/tiehall-oasdiff/work/", import.meta.url));

/** Compares a revision of the OpenAPI document with its base, both as JSON text. */
export async function compareDocuments(base: string, revision: string): Promise<CompatResult> {
  const binary = await oasdiff();
  mkdirSync(WORK, { recursive: true });
  const folder = mkdtempSync(join(WORK, "compare-"));
  try {
    writeFileSync(join(folder, "base.json"), base);
    writeFileSync(join(folder, "revision.json"), revision);
    writeFileSync(join(folder, "severity-levels.txt"), "api-version-not-bumped err\n");
    const run = spawnSync(
      binary,
      [
        "breaking",
        "base.json",
        "revision.json",
        "--format=json",
        "--fail-on=ERR",
        `--deprecation-days-beta=${DEPRECATION_DAYS.beta}`,
        `--deprecation-days-stable=${DEPRECATION_DAYS.stable}`,
        "--severity-levels=severity-levels.txt",
        "--allow-external-refs=false",
      ],
      { cwd: folder, encoding: "utf8" },
    );
    if (run.error) throw run.error;
    let findings: Finding[];
    try {
      findings = JSON.parse(run.stdout) as Finding[];
    } catch {
      throw new Error(`oasdiff could not compare the documents (exit ${run.status}): ${run.stderr.trim()}`);
    }
    const errors = findings.filter(({ level }) => level >= ERROR).map(({ id, level, text, operationId, path }) => ({
      id,
      level,
      text,
      ...(operationId === undefined ? {} : { operationId }),
      ...(path === undefined ? {} : { path }),
    }));
    return { passed: errors.length === 0, errors };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** A pull request, as the check sees it: the document and the changelog at its merge base and in it, and its labels. */
export interface PullRequest {
  /** openapi/v1.json at the merge base. */
  base: string;
  /** openapi/v1.json in the pull request. */
  revision: string;
  labels: readonly string[];
  /** openapi/changelog.json at the merge base; undefined when it did not exist there. */
  changelogBase?: string;
  /** openapi/changelog.json in the pull request. */
  changelogRevision: string;
}

export interface PullRequestResult extends CompatResult {
  /** Whether the pull request carries the api-breaking label. */
  labelled: boolean;
  /** Why the check fails besides the error-level findings: the label's conditions not met, or a changelog that does not parse. */
  problems: string[];
}

/** The compatibility check of a pull request, with the api-breaking label's rule. */
export async function checkPullRequest(pullRequest: PullRequest): Promise<PullRequestResult> {
  const labelled = pullRequest.labels.includes(API_BREAKING_LABEL);
  const problems: string[] = [];
  let base: Changelog | undefined;
  let revision: Changelog | undefined;
  try {
    base = pullRequest.changelogBase === undefined ? undefined : parseChangelog(pullRequest.changelogBase);
  } catch {
    // An unparsable changelog at the merge base counts as none: every entry of the pull request's is new.
    base = undefined;
  }
  try {
    revision = parseChangelog(pullRequest.changelogRevision);
  } catch (error) {
    problems.push(`openapi/changelog.json does not parse:\n${(error as Error).message}`);
  }
  const { errors } = await compareDocuments(pullRequest.base, pullRequest.revision);
  if (errors.length > 0 && labelled) {
    const from = infoVersion(pullRequest.base);
    const to = infoVersion(pullRequest.revision);
    if (!isNewerVersion(from, to)) {
      problems.push(
        `The pull request carries the ${API_BREAKING_LABEL} label but leaves info.version at ${to ?? "(none)"}; ` +
          `a breaking change bumps it${from === undefined ? "" : `, from ${from} to 0.N.0 with a larger N`}.`,
      );
    }
    if (revision !== undefined && !addedEntries(base, revision).some(({ kind }) => kind === "breaking")) {
      problems.push(
        `The pull request carries the ${API_BREAKING_LABEL} label but adds no changelog entry of kind breaking to openapi/changelog.json; ` +
          "add one under unreleased that says what breaks and why it could not wait for the notice.",
      );
    }
  }
  const allowed = labelled && problems.length === 0;
  return { passed: problems.length === 0 && (errors.length === 0 || allowed), labelled, errors, problems };
}

/** The labels of a pull request, from the JSON list GitHub Actions gives (toJSON of the labels' names). */
export function parseLabels(json: string | undefined): string[] {
  if (json === undefined || json.trim() === "") return [];
  const labels: unknown = JSON.parse(json);
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
    throw new Error("PR_LABELS is a JSON list of the pull request's label names.");
  }
  return labels;
}

function infoVersion(document: string): string | undefined {
  const version = (JSON.parse(document) as { info?: { version?: unknown } }).info?.version;
  return typeof version === "string" ? version : undefined;
}

/** Whether `to` is a later MAJOR.MINOR.PATCH version than `from`. */
function isNewerVersion(from: string | undefined, to: string | undefined): boolean {
  const parse = (version: string | undefined) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "")?.slice(1).map(Number);
  const a = parse(from);
  const b = parse(to);
  if (a === undefined || b === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

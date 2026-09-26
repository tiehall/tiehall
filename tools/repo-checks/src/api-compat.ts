import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

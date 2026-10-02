import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { breakingArguments, changelogArguments } from "./oasdiff.ts";

// The recorded outputs of the pinned oasdiff (contract-changes: The contract
// Action; design.md, Technical decisions: T12). Each fixture pair is a folder
// with two OpenAPI documents, base.yaml and revision.yaml, and what the pinned
// oasdiff prints for them, with the arguments the Action runs it with:
// `oasdiff breaking` as text, in breaking.txt, and `oasdiff changelog --format
// json`, in changelog.json. The pairs make ERR, WARN and INFO changes
// (breaking), WARN and INFO changes (warning), INFO changes alone
// (informational), and no classified change (unchanged). Tests of the Action,
// of the CLI and of routing read these outputs, so they stand for what the
// engine says without each test running it; the recorder writes them again
// with the checksum-verified binary, and a test holds them to it byte for
// byte.

/** The fixture pairs, by folder. */
export const OASDIFF_FIXTURE_PAIRS = ["breaking", "warning", "informational", "unchanged"] as const;
export type OasdiffFixturePair = (typeof OASDIFF_FIXTURE_PAIRS)[number];

/** The folder that holds the fixture pairs. */
export const OASDIFF_FIXTURES = fileURLToPath(new URL("../test/fixtures/oasdiff/", import.meta.url));

/** Where the scripts and tests of this package keep the verified binary: this package's node_modules/.cache, outside the tracked files. */
export const OASDIFF_CACHE = fileURLToPath(new URL("../node_modules/.cache/tiehall-contract-action/oasdiff/", import.meta.url));

/** The files each pair's outputs are recorded in. */
export const RECORDED_FILES = ["breaking.txt", "changelog.json"] as const;

/** Runs oasdiff with these arguments in the folder; returns what it printed, or throws when it failed. */
function oasdiffOutput(binary: string, args: readonly string[], cwd: string): string {
  const run = spawnSync(binary, args, { cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`oasdiff ${args[0] ?? ""} exited with ${String(run.status)}: ${run.stderr}`);
  return run.stdout;
}

/**
 * Records one pair's outputs into the target folder: oasdiff runs on copies of
 * the pair's two documents in a folder of its own, as the Action runs it, so
 * the documents' names in its output are base.yaml and revision.yaml and no
 * configuration file applies.
 */
export function recordPair(binary: string, pair: OasdiffFixturePair, target: string, source = OASDIFF_FIXTURES): void {
  const work = mkdtempSync(join(tmpdir(), "tiehall-oasdiff-fixture-"));
  try {
    copyFileSync(join(source, pair, "base.yaml"), join(work, "base.yaml"));
    copyFileSync(join(source, pair, "revision.yaml"), join(work, "revision.yaml"));
    const breaking = oasdiffOutput(binary, breakingArguments("base.yaml", "revision.yaml"), work);
    const changelog = oasdiffOutput(binary, changelogArguments("base.yaml", "revision.yaml"), work);
    mkdirSync(join(target, pair), { recursive: true });
    writeFileSync(join(target, pair, "breaking.txt"), breaking);
    writeFileSync(join(target, pair, "changelog.json"), changelog);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Records every pair's outputs into the target folder, the fixtures' own unless given; returns the pairs recorded. */
export function recordOasdiffFixtures(binary: string, target = OASDIFF_FIXTURES): OasdiffFixturePair[] {
  const pairs = readdirSync(OASDIFF_FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  const unknown = pairs.filter((name) => !(OASDIFF_FIXTURE_PAIRS as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`The fixture folder holds pairs the recorder does not know: ${unknown.join(", ")}.`);
  for (const pair of OASDIFF_FIXTURE_PAIRS) recordPair(binary, pair, target);
  return [...OASDIFF_FIXTURE_PAIRS];
}

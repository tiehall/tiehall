// Checks the Renovate configuration for self-host-install: Release pipeline
// integrity.
// It validates renovate.json with Renovate's own validator, then runs a lookup
// dry run on the local checkout and fails when Renovate would propose an update
// younger than 7 days, or one whose age it cannot tell. Renovate runs from its
// image pinned by digest, with the checkout mounted read-only; the dry run
// needs the network to look up versions, and it gets no token, so it cannot
// look up GitHub Actions pins (the report lists them). renovate.json must be
// tracked or staged, because Renovate finds files through git.
// Usage: node tools/repo-checks/src/check-renovate.ts [repo] [--save-log <file>]
//        node tools/repo-checks/src/check-renovate.ts --log <Renovate JSON log>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { describeUpdate, MINIMUM_RELEASE_AGE_DAYS, summarizeDryRun } from "./renovate-dry-run.ts";

/** Renovate proposes new digests for this image after the 7-day release age (renovate.json). */
export const RENOVATE_IMAGE =
  "ghcr.io/renovatebot/renovate:44.103.0@sha256:255f98c1c8da761deb006d70cd2e864c9b3f35c474c95b1bd19753ca8962667d";

const CONTAINER = ["run", "--rm", "--cap-drop=ALL", "--security-opt=no-new-privileges"];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { log: { type: "string" }, "save-log": { type: "string" } },
});

process.exitCode = main();

function main(): number {
  let log: string;
  if (values.log === undefined) {
    const repo = resolve(positionals[0] ?? ".");

    console.log("Validating renovate.json with Renovate's validator...");
    const validate = spawnSync(
      "docker",
      [
        ...CONTAINER,
        "--network=none",
        `--volume=${repo}/renovate.json:/usr/src/app/renovate.json:ro`,
        RENOVATE_IMAGE,
        "renovate-config-validator",
        "--strict",
      ],
      { stdio: "inherit" },
    );
    if (validate.error) throw validate.error;
    if (validate.status !== 0) return 1;

    console.log("\nRunning Renovate's lookup on the checkout as a dry run...");
    const dryRun = spawnSync(
      "docker",
      [
        ...CONTAINER,
        "--env=RENOVATE_PLATFORM=local",
        "--env=RENOVATE_DRY_RUN=lookup",
        "--env=LOG_LEVEL=debug",
        "--env=LOG_FORMAT=json",
        // The checkout belongs to another uid; trust it for this read-only run.
        "--env=GIT_CONFIG_COUNT=1",
        "--env=GIT_CONFIG_KEY_0=safe.directory",
        "--env=GIT_CONFIG_VALUE_0=*",
        `--volume=${repo}:/usr/src/app:ro`,
        RENOVATE_IMAGE,
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
    );
    if (dryRun.error) throw dryRun.error;
    log = dryRun.stdout;
    if (values["save-log"] !== undefined) writeFileSync(values["save-log"], log);
  } else {
    log = readFileSync(values.log, "utf8");
  }

  let summary;
  try {
    summary = summarizeDryRun(log);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  for (const update of summary.proposed) console.log(`proposed      ${describeUpdate(update)}`);
  for (const update of summary.held) console.log(`held back     ${describeUpdate(update)}`);
  if (summary.notLookedUp.length > 0) {
    const names = summary.notLookedUp.map(({ depName, reason }) => `${depName} (${reason})`).join(", ");
    console.log(`not looked up ${names}`);
  }
  if (summary.disabled > 0) {
    console.log(
      `Renovate dropped ${summary.disabled} disabled update(s), such as majors that renovate.json turns off; ` +
        "its log does not say which, so they are listed above too.",
    );
  }
  console.log(
    `\n${summary.proposed.length} update(s) proposed, ${summary.held.length} held back by the ` +
      `${MINIMUM_RELEASE_AGE_DAYS}-day minimum release age.`,
  );
  if (summary.tooYoung.length === 0) return 0;

  for (const update of summary.tooYoung) console.error(`too young     ${describeUpdate(update)}`);
  console.error(
    `\nRenovate would propose ${summary.tooYoung.length} update(s) younger than ${MINIMUM_RELEASE_AGE_DAYS} days, ` +
      "or of unknown age. See self-host-install: Release pipeline integrity and minimumReleaseAge in renovate.json.",
  );
  return 1;
}

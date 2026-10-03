// CI check: fails when any package.json in the repository depends on an LLM or
// model-vendor SDK from model-sdk-denylist.json (self-host-install: No model
// calls), or on an analytics SDK, an error-reporting SDK or an update checker
// from telemetry-sdk-denylist.json (self-host-install: No telemetry and a
// documented list of outbound connections), or when the lockfile resolves
// one, whatever depends on it. The image tests check the built image the same
// way (tools/image-tests/test/image.test.ts).
// Usage: node tools/repo-checks/src/check-model-sdks.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { denylistReason, findLockfilePackages, findModelSdkDependencies, loadDenylist, loadTelemetryDenylist } from "./model-sdks.ts";

const root = resolve(process.argv[2] ?? ".");

const lists = [
  {
    denylist: loadDenylist(),
    name: "the model SDK denylist",
    reason:
      "Tiehall calls no language model and sends no data to a model vendor (D3). " +
      "Remove these dependencies; the list is tools/repo-checks/model-sdk-denylist.json.",
    describe: false,
  },
  {
    denylist: loadTelemetryDenylist(),
    name: "the telemetry denylist",
    reason:
      "An install sends nothing to the Tiehall project or to any service it runs (S13): no usage statistics, " +
      "no error reports and no update check. Remove these dependencies; the list is " +
      "tools/repo-checks/telemetry-sdk-denylist.json.",
    describe: true,
  },
];

let failed = false;
for (const { denylist, name, reason, describe } of lists) {
  const findings = findModelSdkDependencies(root, denylist);
  for (const { file, field, name: dependency, as, listedAs } of findings) {
    const alias = as === dependency ? "" : ` (installed as "${as}")`;
    const why = describe ? ` (${denylistReason(denylist, listedAs) ?? "listed"})` : "";
    console.error(`${file}: ${field} has ${dependency}${alias}, which ${name} names as ${listedAs}${why}.`);
  }
  const resolved = findLockfilePackages(root, denylist);
  for (const { file, name: dependency, version, listedAs } of resolved) {
    const why = describe ? ` (${denylistReason(denylist, listedAs) ?? "listed"})` : "";
    console.error(`${file}: resolves ${dependency}@${version}, which ${name} names as ${listedAs}${why}.`);
  }
  if (findings.length > 0 || resolved.length > 0) {
    console.error(`\n${reason}\n`);
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("No LLM or model-vendor SDK, and no analytics, error-reporting or update-check SDK, in any package.json or in the lockfile.");
}

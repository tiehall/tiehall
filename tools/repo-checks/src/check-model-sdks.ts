// CI check: fails when any package.json in the repository depends on an LLM or
// model-vendor SDK from model-sdk-denylist.json (operations: No model calls and
// no model vendor). Usage: node tools/repo-checks/src/check-model-sdks.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { findModelSdkDependencies, loadDenylist } from "./model-sdks.ts";

const root = resolve(process.argv[2] ?? ".");
const findings = findModelSdkDependencies(root, loadDenylist());

if (findings.length === 0) {
  console.log("No LLM or model-vendor SDK in any package.json.");
} else {
  for (const { file, field, name, as, listedAs } of findings) {
    const alias = as === name ? "" : ` (installed as "${as}")`;
    console.error(`${file}: ${field} has ${name}${alias}, which the model SDK denylist names as ${listedAs}.`);
  }
  console.error(
    "\nTiehall calls no language model and sends no data to a model vendor (D3). " +
      "Remove these dependencies; the list is tools/repo-checks/model-sdk-denylist.json.",
  );
  process.exitCode = 1;
}

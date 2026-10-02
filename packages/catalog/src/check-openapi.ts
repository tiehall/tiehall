import { readFileSync } from "node:fs";
import { apiMajorsOf } from "./catalog.ts";
import { CATALOG } from "./commands.ts";
import { committedDocumentPath } from "./committed-files.ts";
import { documentDrift } from "./openapi-drift.ts";

// CI's check that openapi/v1.json, and the document of each later major
// version the catalog serves, is the document the catalog generates
// (public-api: Every API change is reviewed as a document diff): `pnpm check:openapi`.

let failed = false;
for (const major of apiMajorsOf(CATALOG)) {
  let committed = "";
  try {
    committed = readFileSync(committedDocumentPath(major), "utf8");
  } catch {
    committed = "";
  }
  const drift = documentDrift(CATALOG, committed, major);
  if (drift !== undefined) {
    console.error(drift);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`${apiMajorsOf(CATALOG).map((major) => `openapi/v${major}.json`).join(" and ")} ${apiMajorsOf(CATALOG).length === 1 ? "is the document" : "are the documents"} the catalog generates.`);

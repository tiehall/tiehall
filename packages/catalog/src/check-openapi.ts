import { readFileSync } from "node:fs";
import { CATALOG } from "./commands.ts";
import { COMMITTED_DOCUMENT, documentDrift } from "./openapi-drift.ts";

// CI's check that openapi/v1.json is the document the catalog generates
// (public-api: Every API change is reviewed as a document diff): `pnpm check:openapi`.

const drift = documentDrift(CATALOG, readFileSync(COMMITTED_DOCUMENT, "utf8"));
if (drift !== undefined) {
  console.error(drift);
  process.exit(1);
}
console.log("openapi/v1.json is the document the catalog generates.");

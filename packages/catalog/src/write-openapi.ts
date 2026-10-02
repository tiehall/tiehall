import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { apiMajorsOf } from "./catalog.ts";
import { CATALOG } from "./commands.ts";
import { openApiDocument, serializeDocument } from "./openapi.ts";
import { committedDocumentPath } from "./committed-files.ts";

// Writes openapi/v1.json, the committed OpenAPI document of /api/v1, from the
// catalog (public-api: What the document states for each operation; design.md,
// Technical decisions: T10): `pnpm openapi:generate`. Every change to an
// operation is then reviewed as a diff of this file. Once an operation has
// moved to a later major version, the document of each, such as
// openapi/v2.json, is written beside it (design.md, Where the specs leave
// room: Two API versions).

for (const major of apiMajorsOf(CATALOG)) {
  const path = committedDocumentPath(major);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeDocument(openApiDocument(CATALOG, { major })));
  console.log(`Wrote ${path} from the catalog's operations under /api/v${major}.`);
}

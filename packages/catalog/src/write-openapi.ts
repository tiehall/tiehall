import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CATALOG } from "./commands.ts";
import { openApiDocument, serializeDocument } from "./openapi.ts";
import { committedDocumentPath } from "./committed-files.ts";

// Writes openapi/v1.json, the committed OpenAPI document of /api/v1, from the
// catalog (public-api: What the document states for each operation; design.md,
// Technical decisions: T10): `pnpm openapi:generate`. Every change to an
// operation is then reviewed as a diff of this file.

const path = committedDocumentPath();
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, serializeDocument(openApiDocument(CATALOG)));
console.log(`Wrote ${path} from the catalog's ${CATALOG.commands.length} operations.`);

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./commands.ts";
import { openApiDocument, serializeDocument } from "./openapi.ts";

// Writes openapi/v1.json, the committed OpenAPI document of /api/v1, from the
// catalog (public-api: What the document states for each operation; design.md,
// Technical decisions: T10): `pnpm openapi:generate`. Every change to an
// operation is then reviewed as a diff of this file.

/** Where the committed document lives, at the repository's root. */
const DOCUMENT_PATH = fileURLToPath(new URL("../../../openapi/v1.json", import.meta.url));

mkdirSync(dirname(DOCUMENT_PATH), { recursive: true });
writeFileSync(DOCUMENT_PATH, serializeDocument(openApiDocument(CATALOG)));
console.log(`Wrote ${DOCUMENT_PATH} from the catalog's ${CATALOG.commands.length} operations.`);

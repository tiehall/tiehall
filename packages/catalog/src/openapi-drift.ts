import { fileURLToPath } from "node:url";
import type { Catalog } from "./catalog.ts";
import { openApiDocument, serializeDocument } from "./openapi.ts";

// Every API change is reviewed as a document diff (public-api: Every API
// change is reviewed as a document diff; design.md, Technical decisions: T10).
// openapi/v1.json is committed, and CI regenerates it from the catalog on
// every pull request: a change to an operation that leaves the file as it was,
// or a hand edit of the file, fails, so the reviewed diff of the file shows
// every change to the API.

/** The committed document, at the repository's root. */
export const COMMITTED_DOCUMENT = fileURLToPath(new URL("../../../openapi/v1.json", import.meta.url));

/** What differs between the committed document and the one the catalog generates; undefined when nothing does. */
export function documentDrift(catalog: Catalog, committed: string): string | undefined {
  const generated = serializeDocument(openApiDocument(catalog));
  if (generated === committed) return undefined;
  const was = committed.split("\n");
  const is = generated.split("\n");
  const line = was.findIndex((text, index) => text !== is[index]);
  const at = line === -1 ? was.length : line;
  return [
    "openapi/v1.json differs from the document the catalog generates. Run `pnpm openapi:generate` and commit the file, so the change is reviewed as a diff.",
    `First difference, at line ${at + 1}:`,
    `  committed: ${was[at]?.trim() ?? "(end of file)"}`,
    `  generated: ${is[at]?.trim() ?? "(end of file)"}`,
  ].join("\n");
}

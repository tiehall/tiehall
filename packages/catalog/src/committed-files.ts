import { fileURLToPath } from "node:url";

// Where the files that CI regenerates and checks are committed in the
// repository (public-api: Every API change is reviewed as a document diff;
// public-api: MCP tools follow the same compatibility rules; handoff-packet:
// One definition for the schema and the API; public-api: The changelog page
// and the release notes). Only the CI scripts and the tests read them, so no
// runtime entry point of the catalog exports this module, and each path is
// resolved when it is asked for, never when a module loads: the bundle of a
// server component that runs execute() cannot resolve a file path from
// import.meta.url (apps/web/test/server-component-build.test.ts).

/** openapi/v1.json, the committed OpenAPI document of /api/v1, at the repository's root. */
export function committedDocumentPath(): string {
  return fileURLToPath(new URL("../../../openapi/v1.json", import.meta.url));
}

/** openapi/changelog.json, next to the document it describes. */
export function committedChangelogPath(): string {
  return fileURLToPath(new URL("../../../openapi/changelog.json", import.meta.url));
}

/** mcp/tools.json, the committed snapshot of the MCP tools, at the repository's root. */
export function committedToolSnapshotPath(): string {
  return fileURLToPath(new URL("../../../mcp/tools.json", import.meta.url));
}

/** packages/packet/schema/v1-beta.json, the committed packet schema, in the Apache-2.0 packet directory. */
export function committedPacketSchemaPath(): string {
  return fileURLToPath(new URL("../../packet/schema/v1-beta.json", import.meta.url));
}

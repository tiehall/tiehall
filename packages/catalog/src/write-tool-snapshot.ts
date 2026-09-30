import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CATALOG } from "./commands.ts";
import { committedToolSnapshotPath } from "./committed-files.ts";
import { serializeToolSnapshot, toolSnapshot } from "./tool-schemas.ts";

// Writes mcp/tools.json, the committed snapshot of the MCP tools' names,
// descriptions and lowered schemas, with their operations' stability levels
// and deprecations, from the catalog (public-api: MCP tools
// follow the same compatibility rules; agent-surfaces: Tool schemas that
// current clients accept): `pnpm mcp:generate`. Every change to a tool is then
// reviewed as a diff of this file.

const tools = toolSnapshot(CATALOG);
const path = committedToolSnapshotPath();
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, serializeToolSnapshot(tools));
console.log(`Wrote ${path} with the catalog's ${tools.length} tools.`);

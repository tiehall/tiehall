import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CATALOG } from "./commands.ts";
import { COMMITTED_TOOL_SNAPSHOT, serializeToolSnapshot, toolDescriptions } from "./tool-schemas.ts";

// Writes mcp/tools.json, the committed snapshot of the MCP tools' names,
// descriptions and lowered schemas, from the catalog (public-api: MCP tools
// follow the same compatibility rules; agent-surfaces: Tool schemas that
// current clients accept): `pnpm mcp:generate`. Every change to a tool is then
// reviewed as a diff of this file.

const tools = toolDescriptions(CATALOG);
mkdirSync(dirname(COMMITTED_TOOL_SNAPSHOT), { recursive: true });
writeFileSync(COMMITTED_TOOL_SNAPSHOT, serializeToolSnapshot(tools));
console.log(`Wrote ${COMMITTED_TOOL_SNAPSHOT} with the catalog's ${tools.length} tools.`);

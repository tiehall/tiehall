import { readFileSync } from "node:fs";
import { CATALOG } from "./commands.ts";
import { COMMITTED_TOOL_SNAPSHOT, toolSnapshotDrift, toolSnapshotProblems } from "./tool-schemas.ts";

// CI's check of mcp/tools.json (public-api: MCP tools follow the same
// compatibility rules; agent-surfaces: Tool schemas that current clients
// accept): `pnpm check:mcp-tools`. It lints the committed snapshot, failing on
// a $ref, $defs, or a root that is not an object or has composition, and
// fails when the snapshot differs from the tools the catalog generates, so a
// removed tool or a new required argument shows as a reviewed diff.

const committed = readFileSync(COMMITTED_TOOL_SNAPSHOT, "utf8");
let failed = false;
let tools: { name: string; inputSchema: unknown; outputSchema: unknown }[] = [];
try {
  tools = (JSON.parse(committed) as { tools: typeof tools }).tools;
} catch {
  console.error("mcp/tools.json is not JSON with a tools list.");
  failed = true;
}
for (const problem of toolSnapshotProblems(tools)) {
  console.error(`mcp/tools.json: ${problem}`);
  failed = true;
}
const drift = toolSnapshotDrift(CATALOG, committed);
if (drift !== undefined) {
  console.error(drift);
  failed = true;
}
if (failed) process.exit(1);
console.log(`mcp/tools.json is the catalog's ${tools.length} tools, with schemas current clients accept.`);

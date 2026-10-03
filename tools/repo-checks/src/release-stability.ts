import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The release check of stability levels (public-api: Each operation carries
// a stability level; design.md, Design rules: Public API). Alpha is only for
// work between releases: a published release offers no operation or MCP tool
// at alpha, so every operation a company can call on a released install is at
// least beta and held to the notice rules. The release job checks the
// release's committed documents, the OpenAPI document of every major version
// the release serves (openapi/v<N>.json) and the MCP tool list
// (mcp/tools.json), and stops when an operation or a tool is at alpha, or an
// operation carries no stability level at all.

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** The problems of the release at root, each as a sentence; none when it offers nothing at alpha. */
export function releaseStabilityProblems(root: string): string[] {
  const problems: string[] = [];
  const folder = join(root, "openapi");
  const documents = existsSync(folder) ? readdirSync(folder).filter((name) => /^v\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5))) : [];
  if (!documents.includes("v1.json")) problems.push("The release holds no openapi/v1.json.");
  for (const name of documents) {
    const document = JSON.parse(readFileSync(join(folder, name), "utf8")) as { paths?: Record<string, Record<string, { operationId?: string; "x-stability-level"?: unknown }>> };
    for (const [path, operations] of Object.entries(document.paths ?? {})) {
      for (const method of METHODS) {
        const operation = operations[method];
        if (operation === undefined) continue;
        const named = `${method.toUpperCase()} ${path} (${operation.operationId ?? "no operationId"})`;
        const level = operation["x-stability-level"];
        if (level === undefined) problems.push(`openapi/${name}: ${named} carries no stability level.`);
        else if (level === "alpha") problems.push(`openapi/${name}: ${named} is at alpha, and a release offers no operation at alpha.`);
      }
    }
  }
  const tools = join(root, "mcp", "tools.json");
  if (!existsSync(tools)) problems.push("The release holds no mcp/tools.json.");
  else {
    const listed = JSON.parse(readFileSync(tools, "utf8")) as { tools?: { name?: string; stability?: unknown }[] };
    for (const tool of listed.tools ?? []) {
      if (tool.stability === undefined) problems.push(`mcp/tools.json: the tool ${tool.name ?? "without a name"} carries no stability level.`);
      else if (tool.stability === "alpha") problems.push(`mcp/tools.json: the tool ${tool.name ?? "without a name"} is at alpha, and a release offers no tool at alpha.`);
    }
  }
  return problems;
}

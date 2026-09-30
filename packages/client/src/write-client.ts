import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateClient, type OpenApiDocument } from "./generate.ts";

// Writes @tiehall/client's generated files, its types and the CLI's command
// table, from openapi/v1.json (public-api: The client package
// `@tiehall/client`): `pnpm client:generate`. Run it after `pnpm
// openapi:generate`, and commit what it writes with the document.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const document = JSON.parse(readFileSync(join(root, "openapi/v1.json"), "utf8")) as OpenApiDocument;
const files = await generateClient(document);
for (const [path, text] of Object.entries(files)) {
  const file = join(root, "packages/client", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
console.log(`Wrote ${Object.keys(files).map((path) => `packages/client/${path}`).join(" and ")} from openapi/v1.json.`);

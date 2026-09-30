import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { clientDrift, GENERATED_FILES, generateClient, type OpenApiDocument } from "./generate.ts";

// CI's check that @tiehall/client, its types and the CLI's command table, is
// what openapi/v1.json generates (public-api: The client package
// `@tiehall/client`; design.md, Self-hosting decisions: S16): `pnpm
// check:client`. It fails on a hand edit of a generated file, and on an API
// change whose client was not regenerated.
// Usage: node packages/client/src/check-client.ts [root]

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../", import.meta.url)));
const document = JSON.parse(readFileSync(join(root, "openapi/v1.json"), "utf8")) as OpenApiDocument;
const committed: Record<string, string | undefined> = {};
for (const path of GENERATED_FILES) {
  const file = join(root, "packages/client", path);
  committed[path] = existsSync(file) ? readFileSync(file, "utf8") : undefined;
}
const drift = clientDrift(await generateClient(document), committed);
if (drift !== undefined) {
  console.error(drift);
  process.exit(1);
}
console.log("@tiehall/client is what openapi/v1.json generates: its types and the CLI's command table.");

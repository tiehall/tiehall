import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generatedTypes, TYPES_FILE } from "./types-generation.ts";

// Writes src/types.ts, the packet's TypeScript types, from the committed
// packet JSON Schema (handoff-packet: The npm package): the second step of
// `pnpm packet:generate`, after the schema.

const directory = fileURLToPath(new URL("../", import.meta.url));
writeFileSync(`${directory}${TYPES_FILE}`, await generatedTypes(readFileSync(`${directory}schema/v1-beta.json`, "utf8")));
console.log(`Wrote packages/packet/${TYPES_FILE} from packages/packet/schema/v1-beta.json.`);

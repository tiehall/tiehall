// Writes deploy/.env.example from the list of settings, so it names every
// setting `init` prints (self-host-install: `init` prints a complete `.env`).
// A test fails while the committed file differs from what this writes.
// Usage: node apps/server/src/write-env-example.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exampleEnv } from "./env-file.ts";

const target = fileURLToPath(new URL("../../../deploy/.env.example", import.meta.url));
writeFileSync(target, exampleEnv());
console.log(`Wrote ${target}.`);

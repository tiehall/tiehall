// The web role with the fixture server in place of the Next.js standalone server, run as its own process by
// web-role.test.ts, so the test can send it SIGTERM as Docker does and read everything the process prints. Its
// setup step, which prints the setup code, runs only with WITH_SETUP=on, against the database the settings name.
import { fileURLToPath } from "node:url";
import process from "node:process";
import { readAppSettings } from "@tiehall/commands";
import { runWebRole } from "../../src/web-role.ts";

await runWebRole(readAppSettings(process.env), {
  serverModule: fileURLToPath(new URL("./fixture-web-server.ts", import.meta.url)),
  ...(process.env["DRAIN_TIMEOUT_MS"] === undefined ? {} : { drainTimeoutMs: Number(process.env["DRAIN_TIMEOUT_MS"]) }),
  ...(process.env["WITH_SETUP"] === "on" ? {} : { setup: async () => {} }),
});

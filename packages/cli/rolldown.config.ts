import { defineConfig } from "rolldown";

// Bundles the CLI with @tiehall/client, openapi-fetch and the renderer of
// @tiehall/packet into one file, so the published `tiehall` package needs no
// dependency at run time (agent-surfaces: The CLI package). bin/tiehall.mjs
// checks the Node.js version before it loads the bundle.
export default defineConfig({
  input: "src/main.ts",
  platform: "node",
  output: {
    file: "dist/tiehall.mjs",
    format: "esm",
  },
});

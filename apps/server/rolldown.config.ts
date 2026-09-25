import { defineConfig } from "rolldown";

// Bundles the entrypoint with the workspace packages and npm dependencies it
// uses into one file, so the image needs no node_modules for the worker and
// migrate roles. The web role loads the Next.js standalone server instead.
export default defineConfig({
  input: "src/main.ts",
  platform: "node",
  // pg's optional native binding, which the image does not install.
  external: ["pg-native"],
  output: {
    file: "dist/main.mjs",
    format: "esm",
    sourcemap: true,
  },
});

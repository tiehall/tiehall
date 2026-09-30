import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // The operator tests under test/install run with vitest.install.config.ts, in CI jobs of their own.
    exclude: ["test/install/**", "node_modules/**"],
    // Provides the image under test: TIEHALL_IMAGE, or a fresh local build.
    globalSetup: [fileURLToPath(new URL("./src/global-setup.ts", import.meta.url))],
    // Containers take a while to start; the tests of one file share them.
    testTimeout: 120_000,
    hookTimeout: 900_000,
  },
});

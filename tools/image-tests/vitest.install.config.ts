import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

// The operator tests (self-host-install: Backups with the shipped scripts;
// self-host-install: Upgrades apply migrations before the app starts;
// self-host-install: Compose runs Tiehall and Postgres), the end-to-end
// "It works" test (agent-surfaces: Four agent surfaces) and the egress test
// (self-host-install: No telemetry and a documented list of outbound
// connections): each boots whole
// installs from the release files with Docker Compose, so they run apart from
// the image's container tests, one file at a time, each in a CI job of its
// own: `pnpm test:install <file>`, such as `pnpm test:install backup`.
export default defineProject({
  test: {
    include: ["test/install/**/*.test.ts"],
    // Provides the image under test, TIEHALL_IMAGE or a fresh local build, and the previous one, TIEHALL_PREVIOUS_IMAGE.
    globalSetup: [fileURLToPath(new URL("./src/global-setup.ts", import.meta.url))],
    // An install takes a minute or two to come up on a CI runner, and a test boots several.
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});

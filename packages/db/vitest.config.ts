import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // Starts one Postgres 17 container for this project's run.
    globalSetup: [fileURLToPath(import.meta.resolve("@tiehall/testing/global-setup"))],
    // Fails a test file that uses pg in a way pg 9 removes, such as two queries at once on one client.
    setupFiles: [fileURLToPath(import.meta.resolve("@tiehall/testing/pg-warnings"))],
    // The tests and their hooks create databases in that container and run the migrations, and some start
    // child processes. On a CI runner that can take longer than Vitest's defaults of 5 seconds for a test and
    // 10 for a hook. A test or hook that needs more gives its own timeout.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

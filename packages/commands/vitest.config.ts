import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // Starts one Postgres 17 container for this project's run, and names the run, by which the test files that
    // start the web app build it once between them (test/support/web-app.ts).
    globalSetup: [
      fileURLToPath(import.meta.resolve("@tiehall/testing/global-setup")),
      fileURLToPath(new URL("./test/support/web-app-run.ts", import.meta.url)),
    ],
    // Fails a test file that uses pg in a way pg 9 removes, such as two queries at once on one client.
    setupFiles: [fileURLToPath(import.meta.resolve("@tiehall/testing/pg-warnings"))],
    // The tests and their hooks create databases in that container and run the migrations, and some start
    // browsers or child processes, which takes longer on CI runners than on a laptop: a browser test's hook
    // timed out at Vitest's 10-second default there. A test or hook that needs more gives its own timeout.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

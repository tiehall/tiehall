import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // Starts one Postgres 17 container for this project's run, for the migrate role's tests.
    globalSetup: [fileURLToPath(import.meta.resolve("@tiehall/testing/global-setup"))],
    // Fails a test file that uses pg in a way pg 9 removes, such as two queries at once on one client.
    setupFiles: [fileURLToPath(import.meta.resolve("@tiehall/testing/pg-warnings"))],
    // These tests start the image's roles as child processes, and their hooks
    // create databases in that container, which takes longer on CI runners
    // than on a laptop; the 5-second default for tests timed out there, and
    // hooks get more than their 10-second default too.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

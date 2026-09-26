import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // Starts one Postgres 17 container for this project's run, for the migrate role's tests.
    globalSetup: [fileURLToPath(import.meta.resolve("@tiehall/testing/global-setup"))],
  },
});

import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // These tests run `next build` and a browser, which take longer on CI runners than on a laptop, past Vitest's
    // defaults of 5 seconds for a test and 10 for a hook. A test or hook that needs more gives its own timeout
    // (design.md, Technical decisions: T17).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

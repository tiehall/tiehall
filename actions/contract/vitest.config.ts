import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // The tests download the pinned oasdiff once, run it and git as child processes, which takes longer on CI
    // runners than on a laptop. A test or hook that needs more gives its own timeout (design.md, Technical
    // decisions: T17).
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

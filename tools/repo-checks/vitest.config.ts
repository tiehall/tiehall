import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // Most of these tests run a check's script, docker compose, git or npm as a child process, which takes longer
    // on CI runners than on a laptop: two `docker compose config` runs took 3.7 of Vitest's default 5 seconds
    // for a test there. A test or hook that needs more gives its own timeout (design.md, Technical decisions: T17).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

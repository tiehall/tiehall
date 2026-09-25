import { defineConfig } from "vitest/config";

// Every workspace package is its own Vitest project; a package adds a
// vitest.config.ts only when it needs more than the defaults (for example the
// shared Postgres 17 harness). .claude/, spikes/ and openspec/ are never
// projects, and no project root contains them.
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*", "actions/*", "tools/*"],
  },
});

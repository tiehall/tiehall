import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docker } from "../src/docker.ts";

// The image's build context (task 3.4; design.md, Decisions this change rests
// on: D38). The repository's .dockerignore keeps the git-ignored planning
// folder and local secrets out of every build, so a build on the maintainer's
// machine sends neither to the builder. Docker applies the file to a small
// context here, and the context is exported as it reached the build.

const dockerignore = fileURLToPath(new URL("../../../.dockerignore", import.meta.url));

/** Every file under a folder, as sorted paths relative to it. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .sort();
}

describe("the build context", () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "tiehall-build-context-"));
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("leaves out the private planning folder and local secrets, and keeps the sources", () => {
    const context = join(work, "context");
    const exported = join(work, "exported");
    const files = [
      "package.json",
      "packages/db/migrations/0000_init.sql",
      "private/docs/plan.md",
      "private/openspec/changes/earlier-plan/tasks.md",
      ".env",
      ".env.local",
      "deploy/secrets/app_database_password",
    ];
    for (const file of files) {
      mkdirSync(dirname(join(context, file)), { recursive: true });
      writeFileSync(join(context, file), "probe\n");
    }
    copyFileSync(dockerignore, join(context, ".dockerignore"));
    // The Dockerfile sits outside the context, so the context holds only the files above.
    writeFileSync(join(work, "Dockerfile"), "FROM scratch\nCOPY . /\n");

    const build = docker(["build", "--file", join(work, "Dockerfile"), "--output", `type=local,dest=${exported}`, context], 300);
    expect(build.stderr).not.toMatch(/ERROR/);
    expect(build.status).toBe(0);
    expect(filesUnder(exported)).toEqual([".dockerignore", "package.json", "packages/db/migrations/0000_init.sql"]);
  });
});

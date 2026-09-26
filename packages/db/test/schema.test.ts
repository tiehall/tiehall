import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The Drizzle schema and the committed migrations agree (design.md, Technical
// decisions: T4): the app queries through the schema, and the database is
// built from the migrations, so drizzle-kit must find nothing left to generate.

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("the Drizzle schema", () => {
  let out: string;

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "tiehall-migrations-"));
    cpSync(join(packageRoot, "migrations"), out, { recursive: true });
  });

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it("needs no migration beyond the committed ones", () => {
    const before = readdirSync(out, { recursive: true }).sort();
    const run = spawnSync(
      join(packageRoot, "node_modules", ".bin", "drizzle-kit"),
      ["generate", "--dialect", "postgresql", "--schema", "./src/schema.ts", "--out", out],
      { cwd: packageRoot, encoding: "utf8", timeout: 60_000 },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("No schema changes, nothing to migrate");
    expect(readdirSync(out, { recursive: true }).sort()).toEqual(before);
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, inject, it } from "vitest";

// The self-host boot test (tasks 2.11 and 5.3; self-host-install: Compose runs
// Tiehall and Postgres). It runs the same script as the CI job: boot
// deploy/compose.yaml from a .env printed by init, in the all-in-one role
// against stock Postgres 17, and wait for /healthz to report healthy.

const image = inject("image");
const script = fileURLToPath(new URL("../src/boot-test.ts", import.meta.url));
const cannotStart = fileURLToPath(new URL("../fixtures/app-cannot-start.yaml", import.meta.url));
const floorAboveImage = fileURLToPath(new URL("../fixtures/schema-floor-above-image.yaml", import.meta.url));

function boot(...overrides: string[]) {
  const run = spawnSync(process.execPath, [script, ...overrides], {
    encoding: "utf8",
    env: { ...process.env, TIEHALL_IMAGE: image },
    timeout: 600_000,
  });
  if (run.error) throw run.error;
  return { status: run.status, output: run.stdout + run.stderr };
}

describe("the self-host boot test", () => {
  it("goes green when the stack comes up from a .env printed by init and /healthz reports healthy", () => {
    const run = boot();
    expect(run.output).toContain("Wrote .env with the image's init role");
    expect(run.output).toMatch(
      /migrate exited 0; \/healthz answered 200 \{"status":"up"\}; on the host, 127\.0\.0\.1:\d+ answered 200 \{"status":"up"\}/,
    );
    expect(run.status).toBe(0);
  }, 600_000);

  it("goes red when the app cannot start", () => {
    const run = boot(cannotStart);
    expect(run.status).toBe(1);
    expect(run.output).toContain("TIEHALL_DATABASE_APP_PASSWORD_FILE names /run/secrets/missing_database_password, which cannot be read");
    expect(run.output).toContain("The self-host stack did not come up healthy.");
  }, 600_000);

  // self-host-install: Migrations expand, then contract.
  it("keeps the app from starting when the image is older than the database's schema", () => {
    const run = boot(floorAboveImage);
    expect(run.status).toBe(1);
    expect(run.output).toMatch(
      /tiehall migrate: failed: This image is release \S+, which is older than this database's schema: its contract step 9999_drop_what_98_replaced ran with release 99\.0\.0, so the schema needs release 99\.0\.0 or later\./,
    );
    expect(run.output).not.toMatch(/tiehall (all|web|worker): starting/);
    expect(run.output).toContain("The self-host stack did not come up healthy.");
  }, 600_000);
});

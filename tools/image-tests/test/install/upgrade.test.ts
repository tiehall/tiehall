import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { documented } from "../../src/docs.ts";
import { Install, readRequest, seed } from "../../src/install.ts";
import { buildFixtureImage, migrationsOf, Registry, removeImage } from "../../src/registry.ts";

// The upgrade test (self-host-install: Upgrades apply migrations before the
// app starts; self-host-install: Migrations expand, then contract; design.md,
// Self-hosting decisions: S12; design.md, Technical decisions: T17). An
// install of the previous release's image, or before the first release the
// image last built from main, runs with data; the operator sets the new
// TIEHALL_IMAGE in .env and runs `docker compose pull && docker compose up
// -d`, and the migrate step applies every pending migration before the app
// starts on the new image, which then serves the data. When a migration
// fails, the app does not start on the new image: Compose has replaced the
// app's container with one of the new image, which the failed migrate step
// keeps from starting, and the database stays on the old schema, since each
// migration commits whole or not at all; the migrate step's log says why, and
// setting the old TIEHALL_IMAGE back and running `docker compose up -d` brings
// the app back on the old image. Skipping a release works: its migrations and
// the next release's run in order. The test runs the commands as the install
// docs write them (docs.ts); the images come from a registry of the test's
// own, so the pull is real (registry.ts).

const image = inject("image");
const previousImage = inject("previousImage");

let registry: Registry;
/** The previous image and the one under test, pinned by version and digest in the test's registry. */
let previous: string;
let current: string;
const fixtures: string[] = [];
const installs: Install[] = [];

beforeAll(async () => {
  expect(previousImage, "Set TIEHALL_PREVIOUS_IMAGE to the previous release's image, or the image last built from main").not.toBe("");
  registry = await Registry.start();
  previous = registry.push(previousImage, "previous");
  current = registry.push(image, "current");
});

afterEach(() => {
  for (const install of installs.splice(0)) install.destroy();
});

afterAll(() => {
  registry?.stop();
  for (const fixture of fixtures) removeImage(fixture);
});

/** An install of this image, started as the docs start one, with the seed's data. */
async function installed(from: string, name: string) {
  const install = await Install.create({ image: from, name });
  installs.push(install);
  install.up();
  await install.healthy();
  return { install, seeded: await seed(install) };
}

/** The migrations applied to the install's database, in the order they ran. */
function applied(install: Install): string[] {
  return install.sql("SELECT id FROM tiehall_migrate.applied_migrations ORDER BY applied_at, id").split("\n").filter((id) => id !== "");
}

/** The image the app's container runs. */
function appImage(install: Install): string {
  return install.compose(["ps", "--format", "{{.Image}}", "app"]).stdout.trim();
}

/** The upgrade as the docs write it: a backup, the new TIEHALL_IMAGE in .env, then `docker compose pull && docker compose up -d`. */
function upgrade(install: Install, to: string) {
  const backup = install.shell(documented("upgrade-backup"));
  expect(backup.status, backup.stderr).toBe(0);
  install.setEnv("TIEHALL_IMAGE", to);
  return install.shell(documented("upgrade-pull-up"), { timeoutSeconds: 600 });
}

/** The docs' check after an upgrade: the services, /healthz on the app's port, and the migrate step's log. */
function check(install: Install) {
  return install.shell(documented("upgrade-check", { "127.0.0.1:3000": `127.0.0.1:${install.port}` }));
}

describe("an upgrade", () => {
  it("applies the pending migrations before the app starts on the new image, which serves the seeded data", async () => {
    const { install, seeded } = await installed(previous, "tiehall-upgrade");
    const before = applied(install);

    const run = upgrade(install, current);

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    await install.healthy();
    const checked = check(install);
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toContain('{"status":"up"}');
    expect(checked.stdout).toContain("migrate: done");
    expect(appImage(install)).toBe(current);
    // Every migration the new image carries has run, in order, the ones the old image had first.
    const after = applied(install);
    expect(after).toEqual(migrationsOf(image));
    expect(after.slice(0, before.length)).toEqual(before);
    expect(install.compose(["ps", "--all", "--format", "{{.ExitCode}}", "migrate"]).stdout.trim()).toBe("0");
    expect(await readRequest(install, seeded.token, seeded.requestKey)).toEqual({ status: 200, title: seeded.requestTitle });
  });

  it("keeps the app from starting on the new image when a migration fails, leaves the old schema, and says why in the migrate step's log", async () => {
    const failing = buildFixtureImage(image, {
      name: "failing",
      version: "9.0.0",
      migrations: [{ tag: "9000_fixture_fails", sql: 'CREATE TABLE "fixture_never_made" ("id" integer PRIMARY KEY);\n--> statement-breakpoint\nSELECT 1 / 0;\n' }],
    });
    fixtures.push(failing);
    const next = registry.push(failing, "failing");
    const { install, seeded } = await installed(current, "tiehall-upgrade-fails");
    const before = applied(install);

    const run = upgrade(install, next);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('service "migrate" didn\'t complete successfully');
    // The app never started on the new image, and the database is on the old schema.
    const app = install.compose(["ps", "--all", "--format", "{{.Service}} {{.State}} {{.Image}}", "app"]).stdout.trim();
    expect(app).toBe(`app created ${next}`);
    expect(applied(install)).toEqual(before);
    expect(install.sql("SELECT to_regclass('public.fixture_never_made') IS NULL")).toBe("t");
    // The migrate step's log says why.
    expect(install.logs("migrate")).toContain("Migration 9000_fixture_fails failed: division by zero");

    // Going back to the old image, as the docs write it, brings the app back on the old schema, with the data.
    install.setEnv("TIEHALL_IMAGE", current);
    const back = install.shell(documented("rollback-up"), { timeoutSeconds: 600 });
    expect(back.status, back.stderr).toBe(0);
    await install.healthy();
    expect(appImage(install)).toBe(current);
    expect(await readRequest(install, seeded.token, seeded.requestKey)).toEqual({ status: 200, title: seeded.requestTitle });
  });

  it("across two releases, running the skipped release's migrations and then the next one's in order", async () => {
    const later = buildFixtureImage(image, {
      name: "next-release",
      version: "9.1.0",
      migrations: [{ tag: "9001_fixture_next_release", sql: 'CREATE TABLE "fixture_next_release" ("id" integer PRIMARY KEY);\n' }],
    });
    fixtures.push(later);
    const next = registry.push(later, "next-release");
    const { install, seeded } = await installed(previous, "tiehall-upgrade-skip");

    // From the previous image straight to the one after the image under test, skipping it.
    const run = upgrade(install, next);

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    await install.healthy();
    expect(appImage(install)).toBe(next);
    expect(applied(install)).toEqual([...migrationsOf(image), "9001_fixture_next_release"]);
    expect(await readRequest(install, seeded.token, seeded.requestKey)).toEqual({ status: 200, title: seeded.requestTitle });
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { documented } from "../../src/docs.ts";
import { Install, readRequest, seed } from "../../src/install.ts";
import { buildFixtureImage, Registry, removeImage } from "../../src/registry.ts";

// The rollback test (self-host-install: Migrations expand, then contract;
// design.md, Self-hosting decisions: S12; design.md, Technical decisions:
// T4 and T17). A release's migrations only add to the schema until a later
// release's contract step, so after an upgrade with only expand steps, going
// back only takes setting the previous TIEHALL_IMAGE and running `docker
// compose up -d`: the previous image starts on the newer schema and serves the
// data. Once a contract step has run, the previous image's migrate step
// refuses to start, saying that the image is older than the database's
// schema, and the app does not start on it; the way back is then the backup
// taken before the upgrade, restored with the previous image. The test runs
// the commands as the install docs write them (docs.ts); the later releases
// are fixture images built on the image under test (registry.ts).

const image = inject("image");

let registry: Registry;
let current: string;
const fixtures: string[] = [];
const installs: Install[] = [];

beforeAll(async () => {
  registry = await Registry.start();
  current = registry.push(image, "current");
});

afterEach(() => {
  for (const install of installs.splice(0)) install.destroy();
});

afterAll(() => {
  registry?.stop();
  for (const fixture of fixtures) removeImage(fixture);
});

/** A later release: the image under test with these migrations after its own, pushed to the test's registry. */
function laterRelease(name: string, version: string, migrations: { tag: string; sql: string }[]): string {
  const fixture = buildFixtureImage(image, { name, version, migrations });
  fixtures.push(fixture);
  return registry.push(fixture, name);
}

async function installed(from: string, name: string) {
  const install = await Install.create({ image: from, name });
  installs.push(install);
  install.up();
  await install.healthy();
  return { install, seeded: await seed(install) };
}

/** Sets TIEHALL_IMAGE and runs the documented command: `docker compose pull && docker compose up -d` for an upgrade, `docker compose up -d` to go back. */
function switchTo(install: Install, to: string, command: string) {
  install.setEnv("TIEHALL_IMAGE", to);
  return install.shell(command, { timeoutSeconds: 600 });
}

/** The upgrade as the docs write it, with the backup taken before it; returns the backup's file. */
function upgrade(install: Install, to: string): string {
  const backup = install.shell(documented("upgrade-backup"));
  expect(backup.status, backup.stderr).toBe(0);
  const folder = join(install.dir, "backups");
  const [file] = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".dump")).sort().reverse() : [];
  expect(file).toBeDefined();
  const upgraded = switchTo(install, to, documented("upgrade-pull-up"));
  expect(upgraded.status, upgraded.stderr).toBe(0);
  return `backups/${file}`;
}

function appState(install: Install): string {
  return install.compose(["ps", "--all", "--format", "{{.State}} {{.Image}}", "app"]).stdout.trim();
}

describe("going back to the previous image", () => {
  it("after an upgrade with only expand steps, starts the previous image on the newer schema, which serves the data", async () => {
    const next = laterRelease("expand-only", "9.1.0", [
      { tag: "9001_fixture_add_table", sql: 'CREATE TABLE "fixture_added" ("id" integer PRIMARY KEY, "note" text);\n' },
      { tag: "9002_fixture_add_column", sql: 'ALTER TABLE "teams" ADD COLUMN "fixture_note" text;\n' },
    ]);
    const { install, seeded } = await installed(current, "tiehall-rollback");
    upgrade(install, next);
    await install.healthy();

    const back = switchTo(install, current, documented("rollback-up"));

    expect(back.status, `${back.stdout}\n${back.stderr}`).toBe(0);
    await install.healthy();
    expect(appState(install)).toBe(`running ${current}`);
    // The newer schema stays, and the previous image runs on it.
    expect(install.sql("SELECT to_regclass('public.fixture_added') IS NOT NULL")).toBe("t");
    expect(install.logs("migrate")).toContain("migrate: the schema is up to date; it also has 2 migrations from a later release, which this release runs on");
    expect(await readRequest(install, seeded.token, seeded.requestKey)).toEqual({ status: 200, title: seeded.requestTitle });
  });

  it("refuses to start the previous image once a contract step has run, as the migrate step's schema floor defines, and the backup taken before the upgrade brings it back", async () => {
    const next = laterRelease("contract", "9.2.0", [
      { tag: "9001_fixture_add_table", sql: 'CREATE TABLE "fixture_added" ("id" integer PRIMARY KEY, "note" text);\n' },
      { tag: "9003_fixture_contract", sql: '-- migrate: contract after 9.1.0\nALTER TABLE "fixture_added" DROP COLUMN "note";\n' },
    ]);
    const { install, seeded } = await installed(current, "tiehall-rollback-contract");
    const beforeUpgrade = upgrade(install, next);
    await install.healthy();

    const back = switchTo(install, current, documented("rollback-up"));

    expect(back.status).not.toBe(0);
    // The app does not start on the previous image, and the migrate step's log says why.
    expect(appState(install)).toBe(`created ${current}`);
    const log = install.logs("migrate");
    expect(log).toContain("older than this database's schema: its contract step 9003_fixture_contract ran with release 9.2.0");
    expect(log).toContain("To go back past a contract step, restore the backup taken before the upgrade.");

    // The way back, as the docs write it: the backup taken before the upgrade, restored with the previous image.
    const restore = install.shell(documented("rollback-restore", { "backups/tiehall-20261001T031500Z.dump": beforeUpgrade }), { timeoutSeconds: 600 });
    expect(restore.status, `${restore.stdout}\n${restore.stderr}`).toBe(0);
    await install.healthy();
    expect(appState(install)).toBe(`running ${current}`);
    expect(install.sql("SELECT to_regclass('public.fixture_added') IS NULL")).toBe("t");
    expect(await readRequest(install, seeded.token, seeded.requestKey)).toEqual({ status: 200, title: seeded.requestTitle });
  });
});

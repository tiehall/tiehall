import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { documented, documentedCronCommand } from "../../src/docs.ts";
import { Install, openRequest, quote, readRequest, seed } from "../../src/install.ts";

// The backup-and-restore round trip (self-host-install: Backups with the
// shipped scripts; design.md, Self-hosting decisions: S11; design.md,
// Technical decisions: T17). The release ships backup.sh and restore.sh next
// to compose.yaml, and they run on the host in the install's folder:
// backup.sh dumps the bundled Postgres in its custom format from inside the
// Postgres container, so the dump matches the server's major version, into a
// timestamped file only its owner can read in the backups folder, then records
// in the database when the backup finished; restore.sh checks that the file
// is a dump, stops the app, restores the dump into an empty database, which
// replaces the install's only once the whole dump is in, and starts the app
// again, whose migrate step brings a dump of an older release up to the
// running one; a file that is not a whole dump changes nothing. The test runs
// the commands as the install docs write them (docs.ts). CI runs this on
// every pull request and every build of main, and before each release.

const image = inject("image");
const previousImage = inject("previousImage");

const installs: Install[] = [];

/** The documented restore of this dump, which the docs show with an example file name. */
const restoreCommand = (dump: string) => documented("backup-restore", { "backups/tiehall-20261001T031500Z.dump": dump });

afterEach(() => {
  for (const install of installs.splice(0)) install.destroy();
});

async function started(from: string, name: string): Promise<Install> {
  const install = await Install.create({ image: from, name });
  installs.push(install);
  install.up();
  await install.healthy();
  return install;
}

/** The dumps in the install's backups folder. */
function dumps(install: Install): string[] {
  const folder = join(install.dir, "backups");
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".dump")).sort() : [];
}

describe("backup.sh and restore.sh", () => {
  it("back up an install, restore the dump into an empty database, and the app boots with the data", async () => {
    const install = await started(image, "tiehall-backup");
    const { token, requestKey, requestTitle } = await seed(install);

    const backup = install.shell(documented("backup-run"));

    expect(backup.status, backup.stderr).toBe(0);
    // A timestamped dump in Postgres's custom format, which only its owner can read, in a folder only its owner can open.
    const [file, ...more] = dumps(install);
    expect(more).toEqual([]);
    expect(file).toMatch(/^tiehall-\d{8}T\d{6}Z\.dump$/);
    const path = join(install.dir, "backups", file!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(install.dir, "backups")).mode & 0o777).toBe(0o700);
    expect(readFileSync(path).subarray(0, 5).toString("latin1")).toBe("PGDMP");
    expect(backup.stdout).toContain(`backups/${file}`);
    // The finished backup is recorded in the database, which the admin page reads.
    expect(install.sql("SELECT file || ' ' || (finished_at > now() - interval '5 minutes') FROM backups")).toBe(`${file} true`);

    // A request opened after the backup is not in the dump.
    const later = await openRequest(install, token, "Opened after the backup");

    // The database is lost, and restore.sh restores the dump into an empty one.
    const lost = install.compose(["down", "--volumes"], { timeoutSeconds: 120 });
    expect(lost.status, lost.stderr).toBe(0);
    const restore = install.shell(restoreCommand(`backups/${file}`), { timeoutSeconds: 600 });

    expect(restore.status, `${restore.stdout}\n${restore.stderr}`).toBe(0);
    await install.healthy();
    expect(install.compose(["ps", "--format", "{{.Service}} {{.State}}", "app"]).stdout.trim()).toBe("app running");
    // The app boots with the data: the request, the teams and the members from the dump, and the token still works.
    expect(await readRequest(install, token, requestKey)).toEqual({ status: 200, title: requestTitle });
    expect((await readRequest(install, token, later)).status).toBe(404);
    expect(install.sql("SELECT string_agg(key, ',' ORDER BY key) FROM teams")).toBe("BE,FE");
    expect(install.sql("SELECT u.github_login || ' ' || m.role FROM members m JOIN users u ON u.id = m.user_id")).toBe("dana admin");
  });

  it("stops the app while it restores, and starts it again once the dump is in", async () => {
    const install = await started(image, "tiehall-restore");
    await seed(install);
    expect(install.shell(documented("backup-run")).status).toBe(0);
    const [file] = dumps(install);

    const restore = install.shell(restoreCommand(`backups/${file}`), { timeoutSeconds: 600 });

    expect(restore.status, `${restore.stdout}\n${restore.stderr}`).toBe(0);
    const said = restore.stdout;
    expect(said.indexOf("Stopping the app")).toBeGreaterThan(-1);
    expect(said.indexOf("Restoring")).toBeGreaterThan(said.indexOf("Stopping the app"));
    expect(said.indexOf("Starting the app")).toBeGreaterThan(said.indexOf("Restoring"));
    await install.healthy();
  });

  it("refuses to restore a file it cannot read, and changes nothing", async () => {
    const install = await started(image, "tiehall-restore-missing");
    const { token, requestKey } = await seed(install);

    const restore = install.shell("./restore.sh backups/no-such.dump");

    expect(restore.status).toBe(1);
    expect(restore.stderr).toContain("restore.sh: cannot read backups/no-such.dump");
    expect((await readRequest(install, token, requestKey)).status).toBe(200);
  });

  // restore.sh replaces the database only with a whole dump: it checks the file before it stops the app, restores it
  // into a database of its own beside the install's, and replaces the install's only once the whole dump is in.
  it("restores nothing from a file that is not a whole dump, and keeps the install running on its data", async () => {
    const install = await started(image, "tiehall-restore-broken");
    const { token, requestKey, requestTitle } = await seed(install);
    expect(install.shell(documented("backup-run")).status).toBe(0);
    const [file] = dumps(install);
    const whole = readFileSync(join(install.dir, "backups", file!));
    // A copy cut short early, one cut short in its data, and a file that is no dump at all, such as the log of the docs' cron line.
    const broken: Record<string, Buffer> = {
      "backups/cut-early.dump": whole.subarray(0, 2000),
      "backups/cut-late.dump": whole.subarray(0, whole.length - 64),
      "backup.log": Buffer.from(`Backed up to backups/${file}\n`),
    };

    for (const [path, content] of Object.entries(broken)) {
      writeFileSync(join(install.dir, path), content, { mode: 0o600 });
      const restore = install.shell(restoreCommand(path), { timeoutSeconds: 600 });

      expect(restore.status, `${path}\n${restore.stdout}\n${restore.stderr}`).toBe(1);
      expect(restore.stderr, path).toContain(`restore.sh: ${path} `);
      await install.healthy();
      expect(install.compose(["ps", "--format", "{{.Service}} {{.State}}", "app"]).stdout.trim(), path).toBe("app running");
      expect(await readRequest(install, token, requestKey), path).toEqual({ status: 200, title: requestTitle });
    }
    // The database the dumps were restored into for the check is gone, and the install's own is the one it had.
    expect(install.sql("SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate")).toBe("postgres,tiehall");
    expect(install.sql("SELECT string_agg(key, ',' ORDER BY key) FROM teams")).toBe("BE,FE");
  });

  // A restore that fails leaves the install as it found it: an app that was not running, as after its database was
  // lost, stays stopped rather than starting on an empty database, and the whole dump then restores as usual.
  it("leaves an app that was not running stopped when the restore fails", async () => {
    const install = await started(image, "tiehall-restore-stopped");
    const { token, requestKey, requestTitle } = await seed(install);
    expect(install.shell(documented("backup-run")).status).toBe(0);
    const [file] = dumps(install);
    const whole = readFileSync(join(install.dir, "backups", file!));
    writeFileSync(join(install.dir, "backups/cut-late.dump"), whole.subarray(0, whole.length - 64), { mode: 0o600 });
    const lost = install.compose(["down", "--volumes"], { timeoutSeconds: 120 });
    expect(lost.status, lost.stderr).toBe(0);

    const failed = install.shell(restoreCommand("backups/cut-late.dump"), { timeoutSeconds: 600 });

    expect(failed.status, `${failed.stdout}\n${failed.stderr}`).toBe(1);
    expect(failed.stderr).toContain("restore.sh: backups/cut-late.dump could not be restored");
    expect(failed.stdout).not.toContain("Starting the app");
    expect(install.compose(["ps", "--all", "--format", "{{.Service}}"]).stdout.trim()).toBe("postgres");

    const restore = install.shell(restoreCommand(`backups/${file}`), { timeoutSeconds: 600 });

    expect(restore.status, `${restore.stdout}\n${restore.stderr}`).toBe(0);
    await install.healthy();
    expect(await readRequest(install, token, requestKey)).toEqual({ status: 200, title: requestTitle });
  });

  // The docs' cron example, as cron runs it, with sh, on an install whose first backup it is.
  it("backs up an install on which backup.sh has not run yet, with the docs' cron line", async () => {
    const install = await started(image, "tiehall-backup-cron");
    await seed(install);
    expect(existsSync(join(install.dir, "backups"))).toBe(false);

    const run = install.shell(`sh -c ${quote(documentedCronCommand(install.dir))}`);

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(dumps(install)).toHaveLength(1);
    expect(install.sql("SELECT count(*) FROM backups")).toBe("1");
  });

  // The previous image may hold every migration this one holds, as on a pull request that adds none: its dump then
  // needs no migration, so the test restores it and reports itself skipped, rather than pass without the upgrade
  // it is about.
  it("brings a dump from the previous release's image, or before the first release the image last built from main, up to date with migrate", async (context) => {
    expect(previousImage, "Set TIEHALL_PREVIOUS_IMAGE to the previous release's image, or the image last built from main").not.toBe("");
    const previous = await started(previousImage, "tiehall-backup-previous");
    const { token, requestKey, requestTitle } = await seed(previous);
    const backup = previous.shell(documented("backup-run"));
    expect(backup.status, backup.stderr).toBe(0);
    const [file] = dumps(previous);
    const dump = join(previous.dir, "backups", file!);
    const appliedBefore = Number(previous.sql("SELECT count(*) FROM tiehall_migrate.applied_migrations"));

    const install = await started(image, "tiehall-backup-current");
    const restore = install.shell(restoreCommand(dump), { timeoutSeconds: 600 });

    expect(restore.status, `${restore.stdout}\n${restore.stderr}`).toBe(0);
    await install.healthy();
    // The migrate step applied this release's newer migrations to the older dump before the app started.
    const journal = JSON.parse(readFileSync(new URL("../../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: unknown[] };
    expect(Number(install.sql("SELECT count(*) FROM tiehall_migrate.applied_migrations"))).toBe(journal.entries.length);
    expect(await readRequest(install, token, requestKey)).toEqual({ status: 200, title: requestTitle });
    if (appliedBefore === journal.entries.length) {
      context.skip(`the previous image holds every one of this image's ${appliedBefore} migrations, so its dump needed none`);
    }
    expect(appliedBefore).toBeLessThan(journal.entries.length);
  });
});

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Install, openRequest, readRequest, seed } from "../../src/install.ts";

// The backup-and-restore round trip (self-host-install: Backups with the
// shipped scripts; design.md, Self-hosting decisions: S11; design.md,
// Technical decisions: T17). The release ships backup.sh and restore.sh next
// to compose.yaml, and they run on the host in the install's folder:
// backup.sh dumps the bundled Postgres in its custom format from inside the
// Postgres container, so the dump matches the server's major version, into a
// timestamped file only its owner can read in the backups folder, then records
// in the database when the backup finished; restore.sh stops the app, restores
// a dump into an empty database and starts the app again, whose migrate step
// brings a dump of an older release up to the running one. CI runs this on
// every pull request and every build of main, and before each release.

const image = inject("image");
const previousImage = inject("previousImage");

const installs: Install[] = [];

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
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

describe("backup.sh and restore.sh", () => {
  it("back up an install, restore the dump into an empty database, and the app boots with the data", async () => {
    const install = await started(image, "tiehall-backup");
    const { token, requestKey, requestTitle } = await seed(install);

    const backup = install.shell("./backup.sh");

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
    const restore = install.shell(`./restore.sh backups/${file}`, { timeoutSeconds: 600 });

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
    expect(install.shell("./backup.sh").status).toBe(0);
    const [file] = dumps(install);

    const restore = install.shell(`./restore.sh backups/${file}`, { timeoutSeconds: 600 });

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

  it("brings a dump from the previous release's image, or before the first release the image last built from main, up to date with migrate", async () => {
    expect(previousImage, "Set TIEHALL_PREVIOUS_IMAGE to the previous release's image, or the image last built from main").not.toBe("");
    const previous = await started(previousImage, "tiehall-backup-previous");
    const { token, requestKey, requestTitle } = await seed(previous);
    const backup = previous.shell("./backup.sh");
    expect(backup.status, backup.stderr).toBe(0);
    const [file] = dumps(previous);
    const dump = join(previous.dir, "backups", file!);
    const appliedBefore = Number(previous.sql("SELECT count(*) FROM tiehall_migrate.applied_migrations"));

    const install = await started(image, "tiehall-backup-current");
    const restore = install.shell(`./restore.sh ${dump}`, { timeoutSeconds: 600 });

    expect(restore.status, `${restore.stdout}\n${restore.stderr}`).toBe(0);
    await install.healthy();
    // The migrate step applied this release's newer migrations to the older dump before the app started.
    const journal = JSON.parse(readFileSync(new URL("../../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: unknown[] };
    expect(Number(install.sql("SELECT count(*) FROM tiehall_migrate.applied_migrations"))).toBe(journal.entries.length);
    expect(journal.entries.length).toBeGreaterThanOrEqual(appliedBefore);
    expect(await readRequest(install, token, requestKey)).toEqual({ status: 200, title: requestTitle });
  });
});

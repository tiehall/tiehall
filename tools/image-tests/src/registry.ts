import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, dockerOk, uniqueName, waitFor } from "./docker.ts";
import { freePort } from "./install.ts";

// A registry of the test's own on 127.0.0.1, so the upgrade and rollback tests
// run the upgrade exactly as the docs write it, `docker compose pull && docker
// compose up -d`, which pulls TIEHALL_IMAGE from its registry, also for an
// image built on the runner that no public registry holds, such as the image of
// a pull request, and for the fixture images the tests build on top of it
// (self-host-install: Upgrades apply migrations before the app starts;
// self-host-install: Migrations expand, then contract). Docker pulls from a
// registry on 127.0.0.1 without TLS. The images it holds are pinned by digest,
// as the release notes pin a release.

/** The registry's own image, the distribution project's, pinned by digest. */
const REGISTRY_IMAGE = "registry:3@sha256:852b3e4d378c426dda6b318fe9d9bfe8e92a0eccb9926671ec3d3ea17a196696";

export class Registry {
  private readonly tags: string[] = [];
  private readonly container: string;
  /** The registry's address, localhost and its port. */
  readonly host: string;

  private constructor(container: string, host: string) {
    this.container = container;
    this.host = host;
  }

  static async start(): Promise<Registry> {
    const port = await freePort();
    const container = uniqueName("tiehall-test-registry");
    dockerOk(["run", "--detach", "--name", container, "--publish", `127.0.0.1:${port}:5000`, REGISTRY_IMAGE], 300);
    const registry = new Registry(container, `localhost:${port}`);
    await waitFor("the registry", async () => ((await fetch(`http://127.0.0.1:${port}/v2/`).catch(() => undefined))?.ok === true ? true : undefined), 60);
    return registry;
  }

  /**
   * Pushes a local image to the registry as tiehall:<tag> and returns its
   * reference pinned by version and digest, as the release notes give it, such
   * as localhost:5000/tiehall:1.3.0@sha256:….
   */
  push(image: string, tag: string): string {
    const named = `${this.host}/tiehall:${tag}`;
    dockerOk(["tag", image, named]);
    this.tags.push(named);
    dockerOk(["push", "--quiet", named], 600);
    const digests = JSON.parse(dockerOk(["image", "inspect", "--format", "{{json .RepoDigests}}", named])) as string[];
    const digest = digests.find((reference) => reference.startsWith(`${this.host}/tiehall@`))?.split("@")[1];
    if (digest === undefined) throw new Error(`the registry gave ${named} no digest: ${digests.join(", ")}`);
    return `${named}@${digest}`;
  }

  /** Stops the registry and removes the tags it gave local images. */
  stop(): void {
    for (const tag of this.tags) docker(["rmi", tag]);
    docker(["rm", "--force", "--volumes", this.container]);
  }
}

/** A migration a fixture image adds after the migrations of the image it is built on. */
export interface FixtureMigration {
  /** Its tag, the file's name without .sql, which sorts after every real migration, such as 9000_fixture_next_release. */
  tag: string;
  sql: string;
}

/**
 * Builds a fixture image: the given image, with these migrations added after
 * its own in its journal, and the release it says it is, as a later release of
 * Tiehall would be. Returns the local tag; remove it with removeImage().
 */
export function buildFixtureImage(base: string, options: { name: string; migrations: FixtureMigration[]; version: string }): string {
  const context = mkdtempSync(join(tmpdir(), "tiehall-fixture-image-"));
  try {
    const journal = JSON.parse(dockerOk(["run", "--rm", "--entrypoint", "cat", base, "/app/packages/db/migrations/meta/_journal.json"])) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    let idx = Math.max(...journal.entries.map((entry) => entry.idx));
    for (const migration of options.migrations) {
      idx += 1;
      journal.entries.push({ idx, version: "7", when: Date.now(), tag: migration.tag, breakpoints: true });
      writeFileSync(join(context, `${migration.tag}.sql`), migration.sql);
    }
    writeFileSync(join(context, "_journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
    writeFileSync(
      join(context, "Dockerfile"),
      [
        `FROM ${base}`,
        ...options.migrations.map(({ tag }) => `COPY ${tag}.sql /app/packages/db/migrations/${tag}.sql`),
        "COPY _journal.json /app/packages/db/migrations/meta/_journal.json",
        `ENV TIEHALL_VERSION=${options.version}`,
        "",
      ].join("\n"),
    );
    const tag = `${uniqueName("tiehall-test-fixture")}:${options.name}`;
    dockerOk(["build", "--quiet", "--tag", tag, context], 600);
    return tag;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/** Removes a local image a test built. */
export function removeImage(image: string): void {
  docker(["rmi", "--force", image]);
}

/** The migrations the image carries, by tag, in journal order. */
export function migrationsOf(image: string): string[] {
  const journal = JSON.parse(dockerOk(["run", "--rm", "--entrypoint", "cat", image, "/app/packages/db/migrations/meta/_journal.json"])) as {
    entries: { idx: number; tag: string }[];
  };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map(({ tag }) => tag);
}

/** The repository's own migrations, by tag, in journal order. */
export function repositoryMigrations(): string[] {
  const journal = JSON.parse(readFileSync(new URL("../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map(({ tag }) => tag);
}

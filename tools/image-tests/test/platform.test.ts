import { existsSync, readFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";
import { docker, dockerOk, IMAGE_PLATFORMS, uniqueName } from "../src/docker.ts";
import { Install } from "../src/install.ts";

// The image under test runs on its own platform without a word from docker
// (design.md, Technical decisions: T17). The image CI builds is linux/amd64;
// on an arm64 host docker runs it under emulation and prints a warning about
// the platform on standard error, which failed the tests that expect a role
// to write nothing there. The global setup finds the image's own platform
// when it is not the host's, and the tests' docker commands ask for it for
// the image under test alone: every other image, such as the Postgres and
// Caddy images an install runs, keeps the host's platform, whose variant is
// the one docker has.

const image = inject("image");

/** The Caddy image the release's compose.yaml pins, which the caddy profile runs. */
const CADDY = /^\s*image:\s*(caddy:\S+)\s*$/m.exec(readFileSync(new URL("../../../deploy/compose.yaml", import.meta.url), "utf8"))?.[1] ?? "";

describe("the image under test", () => {
  it("is created without docker's warning that its platform is not the host's", () => {
    const name = uniqueName("tiehall-platform");
    try {
      const created = docker(["create", "--name", name, image]);
      expect(created.status).toBe(0);
      expect(created.stderr).toBe("");
    } finally {
      docker(["rm", "--force", name]);
    }
  });
});

describe("another image", () => {
  it("runs on the host's own platform, such as the Caddy image an install runs", () => {
    expect(CADDY).toMatch(/^caddy:[^@]+@sha256:[0-9a-f]{64}$/);
    const host = dockerOk(["version", "--format", "{{.Server.Arch}}"]);
    const machine: Record<string, string> = { amd64: "x86_64", arm64: "aarch64" };
    const run = docker(["run", "--rm", "--network", "none", "--entrypoint", "uname", CADDY, "-m"], 300);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(machine[host] ?? host);
  });
});

describe("an install of an image whose platform is not the host's", () => {
  // Compose asks for the image's platform through a file of the tests' own, outside the install's folder: it goes with
  // the install, so a run on a host of another platform leaves nothing behind in the temporary directory.
  it("leaves no Compose file of the tests' own behind once destroyed", async () => {
    const before = process.env[IMAGE_PLATFORMS];
    const platforms = JSON.parse(before ?? "{}") as Record<string, string>;
    // On a host of the image's own platform, the tests ask for that platform as they would for another one.
    const platform = platforms[image] ?? dockerOk(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
    process.env[IMAGE_PLATFORMS] = JSON.stringify({ ...platforms, [image]: platform });
    let install: Install | undefined;
    try {
      install = await Install.create({ image, name: "tiehall-platform-file" });
      const dir = install.dir;
      const own = (install.environment()["COMPOSE_FILE"] ?? "").split(":").filter((file) => file !== "" && !file.startsWith(`${dir}/`));
      expect(own).toHaveLength(1);
      expect(readFileSync(own[0]!, "utf8")).toContain(`platform: ${platform}`);
      // Compose reads it from there, for Tiehall's own services alone.
      const config = install.compose(["config", "--format", "json"]);
      expect(config.status, config.stderr).toBe(0);
      const services = (JSON.parse(config.stdout) as { services: Record<string, { platform?: string }> }).services;
      expect([services["app"]?.platform, services["migrate"]?.platform, services["postgres"]?.platform]).toEqual([platform, platform, undefined]);

      install.destroy();
      install = undefined;

      expect(existsSync(dir)).toBe(false);
      expect(existsSync(own[0]!)).toBe(false);
    } finally {
      install?.destroy();
      if (before === undefined) delete process.env[IMAGE_PLATFORMS];
      else process.env[IMAGE_PLATFORMS] = before;
    }
  }, 300_000);
});

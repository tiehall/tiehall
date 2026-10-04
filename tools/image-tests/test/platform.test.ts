import { readFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";
import { docker, dockerOk, uniqueName } from "../src/docker.ts";

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

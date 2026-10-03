import { describe, expect, inject, it } from "vitest";
import { docker, uniqueName } from "../src/docker.ts";

// The image under test runs on its own platform without a word from docker
// (design.md, Technical decisions: T17). The image CI builds is linux/amd64;
// on an arm64 host docker runs it under emulation and prints a warning about
// the platform on standard error, which failed the tests that expect a role
// to write nothing there. The global setup sets DOCKER_DEFAULT_PLATFORM to the
// image's own platform when it is not the host's, so no test needs it set.

const image = inject("image");

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

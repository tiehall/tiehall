import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_REPOSITORY, runningVersion } from "../src/index.ts";

// The running version and the link to its source (self-host-install: The
// running version links to its source; design.md, Self-hosting decisions:
// S16). The image carries its release, the commit it was built from and the
// public repository it was built from; the link points to that release's
// source there, or, for a development build, to its commit. An operator who
// runs a modified server sets TIEHALL_SOURCE_URL, and the link points there.

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("the running version's source link", () => {
  it("points to the release's source in the public repository by default", () => {
    expect(runningVersion({ TIEHALL_VERSION: "1.3.0", TIEHALL_COMMIT_SHA: COMMIT, TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall" })).toEqual({
      version: "1.3.0",
      sourceUrl: "https://github.com/acme-oss/tiehall/tree/v1.3.0",
    });
  });

  it("points to the commit of a development build, which is no release", () => {
    expect(runningVersion({ TIEHALL_VERSION: "0.0.0-dev", TIEHALL_COMMIT_SHA: COMMIT, TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall" })).toEqual({
      version: "0.0.0-dev",
      sourceUrl: `https://github.com/acme-oss/tiehall/tree/${COMMIT}`,
    });
    // Without a commit, the repository itself.
    expect(runningVersion({ TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall" })).toEqual({
      version: "0.0.0-dev",
      sourceUrl: "https://github.com/acme-oss/tiehall",
    });
  });

  it("takes the public Tiehall repository when the build names none", () => {
    expect(DEFAULT_SOURCE_REPOSITORY).toBe("https://github.com/tiehall/tiehall");
    expect(runningVersion({ TIEHALL_VERSION: "1.3.0" }).sourceUrl).toBe(`${DEFAULT_SOURCE_REPOSITORY}/tree/v1.3.0`);
    expect(runningVersion({ TIEHALL_VERSION: "1.3.0", TIEHALL_SOURCE_REPOSITORY: "" }).sourceUrl).toBe(`${DEFAULT_SOURCE_REPOSITORY}/tree/v1.3.0`);
  });

  it("points to TIEHALL_SOURCE_URL when .env sets it, for a modified server", () => {
    expect(
      runningVersion({ TIEHALL_VERSION: "1.3.0", TIEHALL_COMMIT_SHA: COMMIT, TIEHALL_SOURCE_URL: "https://git.acme.example/tiehall-fork" }),
    ).toEqual({ version: "1.3.0", sourceUrl: "https://git.acme.example/tiehall-fork" });
  });
});

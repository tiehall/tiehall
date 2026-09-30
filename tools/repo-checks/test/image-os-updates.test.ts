import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { osUpdateProblems } from "../src/dockerfile.ts";

// The Dockerfile's part of self-host-install: Release pipeline integrity (D53): the runtime stage applies the
// operating system's security updates when the image is built, in one step that runs without asking, installs no
// recommended package, fails the build when a command fails and leaves no package index, before the package
// managers are removed and before the image switches to its non-root user. The check runs on committed fixtures,
// one for each problem, and on the repository's Dockerfile; `pnpm test` runs it in CI.

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");
const fixture = (name: string) => read(`tools/repo-checks/test/fixtures/dockerfile/${name}.Dockerfile`);
const rulesOf = (dockerfile: string) => osUpdateProblems(dockerfile).map(({ rule }) => rule);

/** A two-stage Dockerfile whose runtime stage is `runtime`, one instruction per line. */
function withRuntime(...runtime: string[]): string {
  return ["FROM node:24.21.0-trixie-slim AS base", "FROM base AS build", "RUN npm ci", "FROM base", ...runtime].join("\n");
}

describe("the check of the operating-system updates in a Dockerfile", () => {
  it("passes a runtime stage that applies them in one step, before the package managers are removed and before USER", () => {
    expect(osUpdateProblems(fixture("passes"))).toEqual([]);
  });

  it.each([
    ["missing", "missing"],
    ["build-stage-only", "missing"],
    ["interactive", "interactive"],
    ["recommends", "recommends"],
    ["not-chained", "not-chained"],
    ["index-left", "index-left"],
    ["after-package-managers-removed", "after-package-managers-removed"],
    ["after-user", "after-user"],
  ] as const)("fails the fixture %s with the problem %s, and no other", (name, rule) => {
    expect(rulesOf(fixture(name))).toEqual([rule]);
  });

  it("names the line where the step starts and what it lacks", () => {
    expect(osUpdateProblems(fixture("recommends"))).toEqual([
      { rule: "recommends", line: 10, detail: expect.stringContaining("--no-install-recommends") },
    ]);
    expect(osUpdateProblems(fixture("interactive"))).toEqual([
      { rule: "interactive", line: 10, detail: expect.stringMatching(/DEBIAN_FRONTEND=noninteractive.*--yes/) },
    ]);
    expect(osUpdateProblems(fixture("index-left"))).toEqual([
      { rule: "index-left", line: 10, detail: expect.stringMatching(/\/var\/lib\/apt\/lists.*apt's caches/) },
    ]);
    expect(osUpdateProblems(fixture("after-user"))).toEqual([{ rule: "after-user", line: 13, detail: expect.stringContaining("line 12") }]);
  });

  it("reads the other spellings of the same step", () => {
    for (const step of [
      "RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade -o APT::Install-Recommends=false && rm -rf /var/cache/apt/archives/*.deb /var/lib/apt/lists",
      "RUN export DEBIAN_FRONTEND=noninteractive && apt-get -q update && apt-get upgrade -qy --no-install-recommends -o Dpkg::Options::=--force-confold && apt-get clean && rm -fr /var/lib/apt/lists/*",
      "RUN export LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get --assume-yes --no-install-recommends upgrade && apt-get clean && rm --recursive --force /var/lib/apt/lists/*",
      'RUN export DEBIAN_FRONTEND=noninteractive && apt-get update > /dev/null 2>&1 && apt-get upgrade -y --no-install-recommends -o "Dpkg::Options::=--force-confold" && apt-get clean && rm -rf /var/lib/apt/lists/*',
    ]) {
      expect(osUpdateProblems(withRuntime(step, "USER 1000:1000")), step).toEqual([]);
    }
  });

  it("does not take a step that upgrades without updating the lists, or updates in another step, for the step", () => {
    expect(
      rulesOf(withRuntime("RUN export DEBIAN_FRONTEND=noninteractive && apt-get upgrade --yes --no-install-recommends && apt-get clean && rm -rf /var/lib/apt/lists/*")),
    ).toEqual(["missing"]);
    // The lists that the separate update fetched stay in its layer, whatever a later step removes.
    expect(
      rulesOf(
        withRuntime(
          "RUN apt-get update",
          "RUN export DEBIAN_FRONTEND=noninteractive && apt-get upgrade --yes --no-install-recommends && apt-get clean && rm -rf /var/lib/apt/lists/*",
        ),
      ),
    ).toEqual(["missing", "index-left"]);
  });

  it("fails any other step of the runtime stage that updates the package lists and leaves them in the image", () => {
    const step =
      "RUN export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get upgrade --yes --no-install-recommends && apt-get clean && rm -rf /var/lib/apt/lists/*";
    expect(osUpdateProblems(withRuntime(step, "RUN apt-get update && apt-get install --yes --no-install-recommends curl", "USER 1000:1000"))).toEqual([
      { rule: "index-left", line: 6, detail: expect.stringContaining("/var/lib/apt/lists") },
    ]);
  });

  it("does not count lists removed before the update, or a pipe, as a step that leaves no index and fails on errors", () => {
    expect(
      rulesOf(
        withRuntime(
          "RUN export DEBIAN_FRONTEND=noninteractive && rm -rf /var/lib/apt/lists/* && apt-get clean && apt-get update && apt-get upgrade --yes --no-install-recommends",
        ),
      ),
    ).toEqual(["index-left"]);
    expect(
      rulesOf(
        withRuntime(
          "RUN export DEBIAN_FRONTEND=noninteractive && apt-get update | tail -1 && apt-get upgrade --yes --no-install-recommends || true && apt-get clean && rm -rf /var/lib/apt/lists/*",
        ),
      ),
    ).toEqual(["not-chained"]);
  });

  it("ignores comment lines inside a continued instruction, as Docker does", () => {
    const dockerfile = withRuntime(
      "RUN export DEBIAN_FRONTEND=noninteractive \\",
      "    && apt-get update \\",
      "# The upgrade keeps the package set.",
      "    && apt-get upgrade --yes --no-install-recommends \\",
      "    && apt-get clean && rm -rf /var/lib/apt/lists/*",
      "USER 1000:1000",
    );
    expect(osUpdateProblems(dockerfile)).toEqual([]);
  });
});

describe("the repository's Dockerfile", () => {
  it("applies the operating system's security updates in its runtime stage", () => {
    expect(osUpdateProblems(read("Dockerfile"))).toEqual([]);
  });
});

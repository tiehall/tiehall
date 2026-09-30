import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { instructions, osUpdateProblems } from "../src/dockerfile.ts";

// The Dockerfile's part of self-host-install: Release pipeline integrity (D53): the runtime stage applies the
// operating system's security updates when the image is built, in one step that runs without asking, installs no
// recommended package, upgrades only the packages the base image carries, fails the build when a command fails or
// an archive cannot be fetched and leaves no package index, before the package
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
    ["update-warns", "not-chained"],
    ["changes-packages", "changes-packages"],
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
    expect(osUpdateProblems(fixture("update-warns"))).toEqual([
      { rule: "not-chained", line: 11, detail: expect.stringContaining("--error-on=any") },
    ]);
  });

  it("reads the other spellings of the same step", () => {
    for (const step of [
      "RUN DEBIAN_FRONTEND=noninteractive apt-get update --error-on=any && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade -o APT::Install-Recommends=false && rm -rf /var/cache/apt/archives/*.deb /var/lib/apt/lists",
      "RUN export DEBIAN_FRONTEND=noninteractive && apt-get -q update --error-on any && apt-get upgrade -qy --no-install-recommends -o Dpkg::Options::=--force-confold && apt-get clean && rm -fr /var/lib/apt/lists/*",
      "RUN export LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive && apt-get -o APT::Update::Error-Mode=any update && apt-get --assume-yes --no-install-recommends upgrade && apt-get clean && rm --recursive --force /var/lib/apt/lists/*",
      'RUN export DEBIAN_FRONTEND=noninteractive && apt-get update --error-on=any > /dev/null 2>&1 && apt-get upgrade -y --no-install-recommends -o "Dpkg::Options::=--force-confold" && apt-get clean && rm -rf /var/lib/apt/lists/*',
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
      "RUN export DEBIAN_FRONTEND=noninteractive && apt-get update --error-on=any && apt-get upgrade --yes --no-install-recommends && apt-get clean && rm -rf /var/lib/apt/lists/*";
    expect(osUpdateProblems(withRuntime(step, "RUN apt-get update && apt-get install --yes --no-install-recommends curl", "USER 1000:1000"))).toEqual([
      { rule: "index-left", line: 6, detail: expect.stringContaining("/var/lib/apt/lists") },
    ]);
  });

  it("does not count lists removed before the update, or a pipe, as a step that leaves no index and fails on errors", () => {
    expect(
      rulesOf(
        withRuntime(
          "RUN export DEBIAN_FRONTEND=noninteractive && rm -rf /var/lib/apt/lists/* && apt-get clean && apt-get update --error-on=any && apt-get upgrade --yes --no-install-recommends",
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

  it("fails a step whose apt-get update only warns when an archive cannot be fetched or verified", () => {
    // Without --error-on=any, apt-get update exits 0 when Debian's archives cannot be reached or their signatures
    // do not check out, and the upgrade then finds nothing to upgrade: the build would ship an unpatched image.
    const step = (update: string) =>
      `RUN export DEBIAN_FRONTEND=noninteractive && ${update} && apt-get upgrade --yes --no-install-recommends && apt-get clean && rm -rf /var/lib/apt/lists/*`;
    for (const update of ["apt-get update", "apt-get update --error-on=never", "apt-get -o APT::Update::Error-Mode=persistent update"]) {
      expect(osUpdateProblems(withRuntime(step(update), "USER 1000:1000")), update).toEqual([
        { rule: "not-chained", line: 5, detail: expect.stringContaining("--error-on=any") },
      ]);
    }
    // A second update in the step fetches too, so it needs the flag as well.
    expect(rulesOf(withRuntime(step("apt-get update --error-on=any && apt-get update"), "USER 1000:1000"))).toEqual(["not-chained"]);
    // A step joined with ";" that also only warns reports the one rule, naming both.
    expect(osUpdateProblems(withRuntime(step("apt-get update").replace("&& apt-get clean", "; apt-get clean"), "USER 1000:1000"))).toEqual([
      { rule: "not-chained", line: 5, detail: expect.stringMatching(/";".*--error-on=any/) },
    ]);
  });

  it("fails a step that can install or remove packages, which only apt-get upgrade may change", () => {
    const step = (...more: string[]) =>
      [
        "RUN export DEBIAN_FRONTEND=noninteractive && apt-get update --error-on=any && apt-get upgrade --yes --no-install-recommends",
        ...more,
        "apt-get clean && rm -rf /var/lib/apt/lists/*",
      ].join(" && ");
    for (const [change, named] of [
      ["apt-get install --yes --no-install-recommends curl", "apt-get install"],
      ["apt-get --yes install curl", "apt-get --yes install"],
      ["apt-get dist-upgrade --yes --no-install-recommends", "apt-get dist-upgrade"],
      ["apt-get full-upgrade --yes", "apt-get full-upgrade"],
      ["apt-get remove --yes perl-base", "apt-get remove"],
      ["apt-get purge --yes perl-base", "apt-get purge"],
      ["apt-get autoremove --yes", "apt-get autoremove"],
      ["apt-get upgrade --yes --no-install-recommends curl", "names packages"],
      ["apt-get upgrade --yes --no-install-recommends --with-new-pkgs", "new packages"],
      ["apt-get upgrade --yes --no-install-recommends -o APT::Get::Upgrade-Allow-New=true", "new packages"],
      ["apt install --yes curl", "apt install"],
      ["apt upgrade --yes", "apt upgrade"],
      ["aptitude safe-upgrade --assume-yes", "aptitude safe-upgrade"],
      ["dpkg -i /tmp/curl.deb", "dpkg -i"],
      ["dpkg --purge perl-base", "dpkg --purge"],
    ] as const) {
      expect(osUpdateProblems(withRuntime(step(change), "USER 1000:1000")), change).toEqual([
        { rule: "changes-packages", line: 5, detail: expect.stringContaining(named) },
      ]);
    }
    // The upgrade itself, even with options, a redirection or new packages turned off, and commands that change no
    // package, pass.
    for (const kept of [
      "apt-get upgrade --yes --no-install-recommends -o APT::Get::Upgrade-Allow-New=false > /dev/null",
      "apt-get autoclean",
      "dpkg --audit",
      "apt-get check",
    ]) {
      expect(osUpdateProblems(withRuntime(step(kept), "USER 1000:1000")), kept).toEqual([]);
    }
    // Another step of the stage may install packages: the rule is on the step that applies the patches.
    expect(osUpdateProblems(withRuntime(step(), "RUN dpkg -i /tmp/tool.deb", "USER 1000:1000"))).toEqual([]);
  });

  it("ignores comment lines inside a continued instruction, as Docker does", () => {
    const dockerfile = withRuntime(
      "RUN export DEBIAN_FRONTEND=noninteractive \\",
      "    && apt-get update --error-on=any \\",
      "# The upgrade keeps the package set.",
      "    && apt-get upgrade --yes --no-install-recommends \\",
      "    && apt-get clean && rm -rf /var/lib/apt/lists/*",
      "USER 1000:1000",
    );
    expect(osUpdateProblems(dockerfile)).toEqual([]);
  });

  it("skips blank lines inside a continued instruction, as Docker does", () => {
    // Docker skips an empty continuation line, with a warning, and goes on reading the instruction.
    const dockerfile = withRuntime(
      "RUN export DEBIAN_FRONTEND=noninteractive \\",
      "    && apt-get update --error-on=any \\",
      "",
      "    && apt-get upgrade --yes --no-install-recommends \\",
      "   ",
      "    && apt-get clean && rm -rf /var/lib/apt/lists/*",
      "USER 1000:1000",
    );
    expect(osUpdateProblems(dockerfile)).toEqual([]);
    expect(instructions(dockerfile).slice(-2)).toEqual([
      {
        keyword: "RUN",
        args: "export DEBIAN_FRONTEND=noninteractive && apt-get update --error-on=any && apt-get upgrade --yes --no-install-recommends && apt-get clean && rm -rf /var/lib/apt/lists/*",
        line: 5,
      },
      { keyword: "USER", args: "1000:1000", line: 11 },
    ]);
  });
});

describe("the repository's Dockerfile", () => {
  it("applies the operating system's security updates in its runtime stage", () => {
    expect(osUpdateProblems(read("Dockerfile"))).toEqual([]);
  });
});

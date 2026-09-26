import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Framework telemetry is off at build and at run time (self-host-install: No
// telemetry and a documented list of outbound connections). Next.js reads
// NEXT_TELEMETRY_DISABLED; the image sets it in its build stage and in the
// image itself, and every script that runs Next.js sets it, so a build on a
// maintainer's machine sends nothing either. The image tests check the
// environment of the built image; the egress test comes in task 26.8.

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");

describe("framework telemetry", () => {
  it("is off in the image's build stage and in the image it runs", () => {
    const dockerfile = read("Dockerfile");
    const stages = dockerfile.split(/^FROM /m).slice(1);
    const build = stages.find((stage) => / AS build\b/.test(stage.split("\n")[0] ?? ""));
    const final = stages.at(-1);
    for (const [name, stage] of [
      ["build", build],
      ["final", final],
    ] as const) {
      expect(stage, name).toMatch(/^ENV [^\n]*(?:\\\n[^\n]*)*\bNEXT_TELEMETRY_DISABLED=1\b/m);
    }
  });

  it("is off in every script of the web app that runs Next.js", () => {
    const { scripts } = JSON.parse(read("apps/web/package.json")) as { scripts: Record<string, string> };
    const nextScripts = Object.entries(scripts).filter(([, command]) => /\bnext\b/.test(command));
    expect(nextScripts.map(([name]) => name).sort()).toEqual(["build", "dev", "typecheck"]);
    for (const [name, command] of nextScripts) {
      for (const run of command.split("&&").filter((part) => /\bnext\b/.test(part))) {
        expect(run.trim(), name).toMatch(/^NEXT_TELEMETRY_DISABLED=1 next /);
      }
    }
  });

  it("is off in the CI job that builds and typechecks the web app", () => {
    expect(read(".github/workflows/ci.yml")).toMatch(/env:\n\s+NEXT_TELEMETRY_DISABLED: "1"/);
  });
});

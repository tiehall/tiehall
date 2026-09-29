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

  // The sign-in library reads BETTER_AUTH_TELEMETRY, and the auth options switch its telemetry off as well. The name
  // holds AUTH, so BuildKit's check for secrets in ARG and ENV (SecretsUsedInArgOrEnv) warns on every build when an ENV
  // sets it: it is set on the build step that runs the builds instead, and by the image's entrypoint for every role.
  it("keeps the sign-in library's telemetry off without an ENV that BuildKit takes for a secret", () => {
    const dockerfile = read("Dockerfile");
    const instructions = dockerfile.replace(/\\\n/g, " ").split("\n");
    const declared = instructions.filter((line) => /^(ENV|ARG) /.test(line));
    expect(declared.filter((line) => /BETTER_AUTH_TELEMETRY/.test(line))).toEqual([]);
    const names = declared.flatMap((line) => [...line.slice(4).matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)(?==|\s|$)/g)].map((match) => match[1] ?? ""));
    expect(names.filter((name) => /apikey|auth|credential|key|pass|pwd|secret|token/i.test(name))).toEqual([]);

    const build = instructions.find((line) => /^RUN .*pnpm --filter @tiehall\/web build/.test(line));
    expect(build).toMatch(/^RUN export BETTER_AUTH_TELEMETRY=0 && /);
    const entrypoint = instructions.filter((line) => line.startsWith("ENTRYPOINT ")).at(-1) ?? "";
    expect(JSON.parse(entrypoint.slice("ENTRYPOINT ".length)).slice(0, 3)).toEqual(["/usr/bin/env", "BETTER_AUTH_TELEMETRY=0", "/usr/local/bin/node"]);
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

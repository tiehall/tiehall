import { spawnSync } from "node:child_process";
import { deniedPackages, loadDenylist, loadTelemetryDenylist } from "@tiehall/repo-checks/model-sdks";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { docker, platformFlags, uniqueName } from "../src/docker.ts";
import { imagePackages, type ImagePackage } from "../src/packages.ts";

// The model SDK check, run on the built image (self-host-install: No model
// calls; self-host-install: No telemetry and a documented list of outbound
// connections). tools/repo-checks checks every package.json and the lockfile
// against the denylists of model-vendor SDKs and of analytics, error-reporting
// and update-check SDKs; this runs the same denylists over every package the
// image holds, installed or bundled (packages.ts). A fixture image, built on
// the image under test, adds one model SDK installed in pnpm's store and
// another as a bundler leaves it in a chunk, and the check finds both.

const image = inject("image");
const fixture = uniqueName("tiehall-fixture-model-sdk").toLowerCase();

/** The fixture image: the image under test, with a model SDK installed and another bundled. */
const FIXTURE_DOCKERFILE = [
  `FROM ${image}`,
  "USER root",
  "RUN mkdir -p /app/node_modules/.pnpm/openai@5.10.0/node_modules/openai" +
    " && printf '%s' '{\"name\":\"openai\",\"version\":\"5.10.0\"}' > /app/node_modules/.pnpm/openai@5.10.0/node_modules/openai/package.json" +
    " && printf '%s' 'export * from \"[project]/node_modules/.pnpm/@anthropic-ai+sdk@0.60.0/node_modules/@anthropic-ai/sdk/index.mjs\";' > /app/apps/server/dist/chunk-fixture.mjs",
  "USER 1000:1000",
  "",
].join("\n");

let packages: ImagePackage[];

beforeAll(() => {
  packages = imagePackages(image);
  // Built for the platform of the image under test, when that is not the host's.
  const build = spawnSync("docker", ["build", "--quiet", ...platformFlags(image), "--tag", fixture, "-"], { input: FIXTURE_DOCKERFILE, encoding: "utf8", timeout: 300_000 });
  if (build.status !== 0) throw new Error(`building the fixture image failed: ${build.stderr}`);
});

afterAll(() => {
  docker(["image", "rm", "--force", fixture]);
});

describe("the model SDK check on the built image", () => {
  it("finds the packages the image holds, installed and bundled", () => {
    const names = new Set(packages.map(({ name }) => name));
    // Installed for the web app, bundled into the server's bundle, and left in the web app's chunks.
    for (const name of ["next", "react", "pg", "@better-auth/core", "@modelcontextprotocol/server", "nodemailer", "drizzle-orm", "zod"]) expect(names).toContain(name);
  });

  it("finds no model-vendor SDK and no analytics, error-reporting or update-check SDK in the image", () => {
    expect(deniedPackages(packages, loadDenylist())).toEqual([]);
    expect(deniedPackages(packages, loadTelemetryDenylist())).toEqual([]);
  });

  it("finds a model SDK installed in a fixture image, and one bundled into a chunk", () => {
    const found = deniedPackages(imagePackages(fixture), loadDenylist()).map(({ file, name, version, listedAs }) => ({ file, name, version, listedAs }));
    expect(found).toEqual(
      expect.arrayContaining([
        { file: "/app/apps/server/dist/chunk-fixture.mjs", name: "@anthropic-ai/sdk", version: "0.60.0", listedAs: "@anthropic-ai" },
        { file: "/app/node_modules/.pnpm/openai@5.10.0/node_modules/openai/package.json", name: "openai", version: "5.10.0", listedAs: "openai" },
      ]),
    );
  });
});

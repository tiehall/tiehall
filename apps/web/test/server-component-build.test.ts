import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Server components run operations through execute() in process (public-api:
// One definition per operation, the same on every surface; design.md,
// Technical decisions: T3; tasks 6.15 and 18.8). A server component's bundle
// cannot resolve a file path from import.meta.url when it loads, so nothing a
// runtime entry point imports may: the committed files the CI checks read are
// named only by functions of a module no runtime entry point exports. The
// fixture is a Next.js app whose one page is a server component that reads
// through @tiehall/commands/web; `next build` must succeed on it.

const fixture = fileURLToPath(new URL("./fixtures/server-component/", import.meta.url));
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");

describe("a server component that runs an operation through execute()", () => {
  it("builds with next build", { timeout: 240_000 }, () => {
    const run = spawnSync(process.execPath, [nextBin, "build", fixture], {
      cwd: fixture,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 230_000,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  });
});

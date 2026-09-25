import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { docker, dockerOk } from "./docker.ts";

/** The tag of a local build, used when TIEHALL_IMAGE is not set. */
export const LOCAL_IMAGE = "tiehall:image-tests";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Provides the image under test. CI sets TIEHALL_IMAGE (a local build on pull
 * requests, the pushed digest on main); without it, this builds the repository.
 */
export default function setup(project: TestProject): void {
  let image = process.env["TIEHALL_IMAGE"];
  if (image === undefined || image === "") {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const build = docker(["build", "--build-arg", `TIEHALL_COMMIT_SHA=${commit}`, "--tag", LOCAL_IMAGE, repoRoot], 900);
    if (build.status !== 0) throw new Error(`docker build failed:\n${build.stderr}`);
    image = LOCAL_IMAGE;
  } else if (docker(["image", "inspect", image]).status !== 0) {
    dockerOk(["pull", "--quiet", image], 600);
  }
  project.provide("image", image);
}

declare module "vitest" {
  export interface ProvidedContext {
    image: string;
  }
}

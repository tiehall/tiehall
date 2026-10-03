import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { docker, dockerOk, foreignPlatformOf } from "./docker.ts";

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
  // An image built for another platform than the host's, such as CI's linux/amd64 image on an arm64 laptop, runs
  // under emulation, and docker warns about it on standard error at every run, which the tests that expect a role
  // to write nothing there would read as the role's. Every docker and Compose command the tests run asks for the
  // image's platform instead, unless DOCKER_DEFAULT_PLATFORM already names one.
  const platform = foreignPlatformOf(image);
  if (platform !== undefined && (process.env["DOCKER_DEFAULT_PLATFORM"] ?? "") === "") process.env["DOCKER_DEFAULT_PLATFORM"] = platform;
  project.provide("image", image);
  // The image of the release before this one, or before the first release the image last built from main, for the
  // backup, upgrade and rollback tests: TIEHALL_PREVIOUS_IMAGE, which CI resolves with get-previous-image.sh.
  const previous = process.env["TIEHALL_PREVIOUS_IMAGE"] ?? "";
  if (previous !== "" && docker(["image", "inspect", previous]).status !== 0) dockerOk(["pull", "--quiet", previous], 600);
  project.provide("previousImage", previous);
}

declare module "vitest" {
  export interface ProvidedContext {
    image: string;
    /** The previous release's image, or the image last built from main; empty when TIEHALL_PREVIOUS_IMAGE is not set. */
    previousImage: string;
  }
}

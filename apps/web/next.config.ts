import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The commit SHA, so browsers still on an older release reload instead of mixing
// versions during a rolling release (design.md decision 23). The Dockerfile sets it.
const commitSha = process.env["TIEHALL_COMMIT_SHA"];

const nextConfig: NextConfig = {
  // The image runs the self-contained server that `next build` writes to .next/standalone.
  output: "standalone",
  // Trace files from the whole monorepo, so workspace packages land in the standalone output.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  ...(commitSha ? { deploymentId: commitSha } : {}),
};

export default nextConfig;

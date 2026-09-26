import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The commit SHA, so browsers still on an older release reload instead of mixing
// versions after an upgrade. The Dockerfile sets it.
const commitSha = process.env["TIEHALL_COMMIT_SHA"];

const nextConfig: NextConfig = {
  // The image runs the self-contained server that `next build` writes to .next/standalone.
  output: "standalone",
  // The workspace packages the app imports are TypeScript sources, which Next.js compiles with the app.
  transpilePackages: ["@tiehall/catalog", "@tiehall/commands", "@tiehall/core", "@tiehall/db"],
  // No X-Powered-By header: a response names nothing about the server it runs on
  // (self-host-install: `/healthz` answers only up or down).
  poweredByHeader: false,
  // Trace files from the whole monorepo, so workspace packages land in the standalone output.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  ...(commitSha ? { deploymentId: commitSha } : {}),
};

export default nextConfig;

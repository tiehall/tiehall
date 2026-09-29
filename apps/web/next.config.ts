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
  // A server action's body may be 2 MiB, the limit the web role's request guard applies to the web UI's forms,
  // so the framework's own cap, 1 MB by default and refused with an error of its own shape, never answers before
  // the guard's 413 (public-api: Request bodies have a size limit). The limit is BODY_LIMIT in @tiehall/commands,
  // which a test holds this to.
  // The proxy (proxy.ts) runs on every route and copies each request body, cut at its own cap, 10 MiB by default.
  // A GitHub webhook delivery may be up to 25 MB, and the guard lets up to 25 MiB through on /webhooks/github, so
  // the cap is the same 25 MiB, the largest limit the guard applies: the proxy never cuts a delivery GitHub may send,
  // whose signature would then fail. The limit is GITHUB_WEBHOOK_BODY_LIMIT in @tiehall/commands, which a test holds
  // this to.
  experimental: {
    serverActions: { bodySizeLimit: 2 * 1024 * 1024 },
    proxyClientMaxBodySize: 25 * 1024 * 1024,
  },
};

export default nextConfig;

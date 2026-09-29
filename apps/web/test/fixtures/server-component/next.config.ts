import type { NextConfig } from "next";

// A Next.js app that holds only a server component that runs an operation
// through execute() in process, as the web UI's pages will
// (server-component-build.test.ts). It compiles the workspace packages the way
// the web app does.
const nextConfig: NextConfig = {
  transpilePackages: ["@tiehall/catalog", "@tiehall/commands", "@tiehall/core", "@tiehall/db"],
  poweredByHeader: false,
};

export default nextConfig;

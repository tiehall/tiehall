import type { NextConfig } from "next";

// A Next.js app whose one page fails while it renders, with the web app's own
// layout, its page for a failed render (app/global-error.tsx) and its proxy,
// which gives the page the policy of the pages Next.js renders
// (packages/commands/test/page-policies-browser.test.ts; web-ui: The content
// security policy of each kind of page). It compiles the workspace packages
// the way the web app does.
const nextConfig: NextConfig = {
  transpilePackages: ["@tiehall/catalog", "@tiehall/commands", "@tiehall/core", "@tiehall/db"],
  poweredByHeader: false,
};

export default nextConfig;

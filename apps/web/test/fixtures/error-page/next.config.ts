import type { NextConfig } from "next";

// A Next.js app whose one page fails while it renders, with the web app's own
// layout, its page for a failed render (app/global-error.tsx) and its proxy,
// which gives the page the policy of the pages Next.js renders
// (packages/commands/test/page-policies-browser.test.ts; web-ui: The content
// security policy of each kind of page). It compiles the workspace packages
// the way the web app does, and serves the install's assets, with /favicon.ico
// rewritten to the icon, as the web app does (app/assets/[...path]/route.ts).
const nextConfig: NextConfig = {
  transpilePackages: ["@tiehall/catalog", "@tiehall/commands", "@tiehall/core", "@tiehall/db"],
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/assets/favicon.ico" }];
  },
};

export default nextConfig;

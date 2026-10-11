import { ASSET_DIGESTS } from "./asset-digests.ts";

// The URLs by which pages name the install's assets (web-ui: The install
// serves its own assets; design.md, Design: The install's assets; D57 (14)):
// each asset's path with the digest of its current content, from the
// committed table. It imports nothing but the table, so every bundle that
// renders a page may use it, the browser's own included, as the web app's
// page for a failed render is (app/global-error.tsx); the asset route itself
// is assets.ts.

/** Where the assets are served: every path under it, and /favicon.ico, which Next.js rewrites to /assets/favicon.ico. */
export const ASSETS_PATH = "/assets";
/** The favicon's own path, which browsers ask for by themselves. */
export const FAVICON_PATH = "/favicon.ico";
/** The stylesheet every page of the web UI links (web-ui: One stylesheet with named design tokens). */
export const STYLESHEET_PATH = `${ASSETS_PATH}/tiehall.css`;

/** The URL a page names an asset by: its path with the digest of its current content, from the committed table. */
export function assetUrl(path: string): string {
  const digest = ASSET_DIGESTS[path] ?? ASSET_DIGESTS[`${ASSETS_PATH}${path}`];
  if (digest === undefined) throw new Error(`${path} is no asset of the install.`);
  return `${path}?v=${digest}`;
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { httpProblem, Refusal } from "@tiehall/core";
import { ASSETS_PATH } from "./asset-urls.ts";

export { ASSETS_PATH, assetUrl, FAVICON_PATH, STYLESHEET_PATH } from "./asset-urls.ts";

// The install's own assets (web-ui: The install serves its own assets;
// design.md, Design: The install's assets; D57 (14)). The web role serves every
// file the web UI's pages load itself, from packages/commands/assets/: the
// stylesheet, the live hall's script, the icons and the manifest; no font, as
// the web UI sets its text in the system's own fonts (web-ui: Text in the
// system's fonts; design.md, Design: Type; D61 (1)). They hold nothing of the
// install, so they are served to anyone, before setup too: an answer reads no
// session and sets no cookie, so it never renews one either. Each answer
// carries the exact media type, nosniff, Cross-Origin-Resource-Policy
// same-origin, a policy under which an SVG opened as a page is inert, and a
// strong ETag of its content, with 304 for an If-None-Match that names it.
//
// Pages name each asset with ?v=<digest of its content>, which the committed
// table in asset-digests.ts gives, since no bundle that renders a page can
// find the files at run time; `pnpm assets:digests` writes it, and a test
// recomputes it. An answer to the current digest's URL is kept for a year;
// any other URL of the asset gets the current file, to be revalidated, so a
// page from before an upgrade still gets a stylesheet and nothing stale is
// kept. The stylesheet names no other asset, so every asset is served as its
// file is. Importing this module reads no file: only the asset route does,
// each file on the first answer that needs it, from the folder it is given.

/** The assets, by the path the install serves each at, to its file in the assets folder. */
export const ASSET_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "tiehall.css",
    "hall.js",
    "icon.svg",
    "icon-180.png",
    "icon-192.png",
    "icon-512.png",
    "favicon.ico",
    "manifest.webmanifest",
  ].map((file) => [`${ASSETS_PATH}/${file}`, file]),
);

/** The media type of each kind of asset, by its file's extension. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
};

/** The exact media type an asset is served with, by its file's extension. */
export function mediaTypeOf(file: string): string {
  const type = MEDIA_TYPES[file.slice(file.lastIndexOf(".") + 1)];
  if (type === undefined) throw new Error(`No media type is known for the asset ${file}.`);
  return type;
}

/** The headers of every answer of the asset route: no sniffing, no use by another site, and inert should someone open an SVG as a page. */
const ASSET_HEADERS = {
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
} as const;

/** How long a browser keeps the current version of an asset: a year, since its URL names its content. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** The digest of an asset's content, which its ETag and the v of its URL carry. */
export function assetDigest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("base64url").slice(0, 22);
}

/** The digests of the assets, from their files in this folder, as `pnpm assets:digests` writes them to asset-digests.ts. */
export async function computeAssetDigests(folder: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const path of Object.keys(ASSET_FILES).sort()) digests[path] = assetDigest(new Uint8Array(await readFile(join(folder, ASSET_FILES[path] ?? ""))));
  return digests;
}

export interface AssetRouteOptions {
  /** The assets folder, packages/commands/assets/, where the process finds it. */
  folder: string;
  /** Reads a file; node's readFile by default. */
  read?: (path: string) => Promise<Uint8Array>;
}

/** Answers a call to an asset: the call, and the path it names, which is the call's own path unless a rewrite gave another. */
export type AssetRoute = (request: Request, path?: string) => Promise<Response>;

export function createAssetRoute(options: AssetRouteOptions): AssetRoute {
  const read = options.read ?? readFile;
  /** Each asset, with its digest, read once per process on the first answer that needs it. */
  const cache = new Map<string, Promise<{ body: Uint8Array<ArrayBuffer>; digest: string }>>();

  function load(file: string) {
    let loaded = cache.get(file);
    if (loaded === undefined) {
      loaded = read(join(options.folder, file)).then((bytes) => {
        const body = new Uint8Array(bytes);
        return { body, digest: assetDigest(body) };
      });
      // A failed read is tried again on the next answer that needs the file.
      loaded.catch(() => cache.delete(file));
      cache.set(file, loaded);
    }
    return loaded;
  }

  return async (request, path) => {
    const url = new URL(request.url);
    const file = Object.hasOwn(ASSET_FILES, path ?? url.pathname) ? ASSET_FILES[path ?? url.pathname] : undefined;
    if (file === undefined || (request.method !== "GET" && request.method !== "HEAD")) return notFound();
    const { body, digest } = await load(file);
    const etag = `"${digest}"`;
    const headers = {
      ...ASSET_HEADERS,
      "content-type": mediaTypeOf(file),
      etag,
      "cache-control": url.searchParams.get("v") === digest ? IMMUTABLE : "no-cache",
    };
    if (matches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : body, { headers: { ...headers, "content-length": String(body.byteLength) } });
  };
}

/** Whether an If-None-Match header names this ETag, or any. */
function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  return ifNoneMatch.split(",").some((tag) => {
    const trimmed = tag.trim();
    return trimmed === "*" || trimmed === etag || trimmed === `W/${etag}`;
  });
}

/** A path under /assets that names no asset, or a method other than GET and HEAD: the error model's 404 (public-api: One error model for Tiehall's own refusals). */
function notFound(): Response {
  const { status, headers, body } = httpProblem(new Refusal("route-not-found", "The install serves no such asset."));
  return new Response(JSON.stringify(body), { status, headers: { ...headers, ...ASSET_HEADERS } });
}

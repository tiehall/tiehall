import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { httpProblem, Refusal } from "@tiehall/core";
import { ASSET_DIGESTS } from "./asset-digests.ts";

// The install's own assets (web-ui: The install serves its own assets; web-ui:
// Fonts served by the install; design.md, Design: The install's assets; D57
// (14)). The web role serves every file the web UI's pages load itself, from
// packages/commands/assets/: the stylesheet, the live hall's script, the
// icons, the manifest, IBM's Plex fonts and their license. They hold nothing
// of the install, so they are served to anyone, before setup too: an answer
// reads no session and sets no cookie, so it never renews one either. Each
// answer carries the exact media type, nosniff, Cross-Origin-Resource-Policy
// same-origin, a policy under which an SVG opened as a page is inert, and a
// strong ETag of its content, with 304 for an If-None-Match that names it.
//
// Pages name each asset with ?v=<digest of its content>, which the committed
// table in asset-digests.ts gives, since no bundle that renders a page can
// find the files at run time; `pnpm assets:digests` writes it, and a test
// recomputes it. An answer to the current digest's URL is kept for a year;
// any other URL of the asset gets the current file, to be revalidated, so a
// page from before an upgrade still gets a stylesheet and nothing stale is
// kept. The stylesheet names its fonts the same way: its url()s are rewritten
// with their digests when it is served, and its own digest is the rewritten
// file's. Importing this module reads no file: only the asset route does,
// each file on the first answer that needs it, from the folder it is given.

/** The weights of IBM Plex Sans and IBM Plex Mono the web UI sets text in (design.md, Design: Type and the self-hosted fonts). */
const SANS_WEIGHTS = ["Regular", "Medium", "SemiBold", "Bold"] as const;
const MONO_WEIGHTS = ["Regular", "Medium"] as const;
/** IBM's subsets of each face; IBM ships no Greek subset of Plex Mono. */
const SANS_SUBSETS = ["Cyrillic", "Greek", "Latin1", "Latin2", "Latin3", "Pi"] as const;
const MONO_SUBSETS = ["Cyrillic", "Latin1", "Latin2", "Latin3", "Pi"] as const;

/** IBM's font files the install serves, by their names in IBM's packages: 24 of Plex Sans and 10 of Plex Mono. */
export const FONT_FILES: readonly string[] = [
  ...SANS_WEIGHTS.flatMap((weight) => SANS_SUBSETS.map((subset) => `IBMPlexSans-${weight}-${subset}.woff2`)),
  ...MONO_WEIGHTS.flatMap((weight) => MONO_SUBSETS.map((subset) => `IBMPlexMono-${weight}-${subset}.woff2`)),
];

/** Where the assets are served: every path under it, and /favicon.ico, which Next.js rewrites to /assets/favicon.ico. */
export const ASSETS_PATH = "/assets";
/** The favicon's own path, which browsers ask for by themselves. */
export const FAVICON_PATH = "/favicon.ico";

/** The assets, by the path the install serves each at, to its file in the assets folder. */
export const ASSET_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  [...FONT_FILES.map((file) => `fonts/${file}`), "fonts/OFL.txt"].map((file) => [`${ASSETS_PATH}/${file}`, file]),
);

/** The media type of each kind of asset, by its file's extension. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
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

/** The URL a page names an asset by: its path with the digest of its current content, from the committed table. */
export function assetUrl(path: string): string {
  const digest = ASSET_DIGESTS[path] ?? ASSET_DIGESTS[`${ASSETS_PATH}${path}`];
  if (digest === undefined) throw new Error(`${path} is no asset of the install.`);
  return `${path}?v=${digest}`;
}

/**
 * The stylesheet as it is served: each url() that names another asset by its
 * path in the assets folder, such as url("fonts/IBMPlexSans-Regular-Latin1.woff2"),
 * names it by its served URL with its digest.
 */
export function stylesheetWithVersions(css: string, digests: Readonly<Record<string, string>> = ASSET_DIGESTS): string {
  return css.replace(/url\("([^"/][^"]*)"\)/g, (whole, file: string) => {
    const path = `${ASSETS_PATH}/${file}`;
    const digest = digests[path];
    return digest === undefined ? whole : `url("${path}?v=${digest}")`;
  });
}

/** An asset's content as it is served, from its file's bytes. */
function served(file: string, bytes: Uint8Array, digests?: Readonly<Record<string, string>>): Uint8Array {
  if (!file.endsWith(".css")) return bytes;
  return new TextEncoder().encode(stylesheetWithVersions(new TextDecoder().decode(bytes), digests));
}

/**
 * The digests of the assets as they are served, from the files in this
 * folder: the fonts' and the icons' first, then the stylesheet's, whose
 * url()s name them. `pnpm assets:digests` writes them to asset-digests.ts.
 */
export async function computeAssetDigests(folder: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  const paths = Object.keys(ASSET_FILES).sort((a, b) => Number(a.endsWith(".css")) - Number(b.endsWith(".css")) || a.localeCompare(b));
  for (const path of paths) {
    const file = ASSET_FILES[path] ?? "";
    digests[path] = assetDigest(served(file, new Uint8Array(await readFile(join(folder, file))), digests));
  }
  return Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b)));
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
  /** Each asset as it is served, with its digest, read once per process on the first answer that needs it. */
  const cache = new Map<string, Promise<{ body: Uint8Array<ArrayBuffer>; digest: string }>>();

  function load(file: string) {
    let loaded = cache.get(file);
    if (loaded === undefined) {
      loaded = read(join(options.folder, file)).then((bytes) => {
        const body = new Uint8Array(served(file, new Uint8Array(bytes)));
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

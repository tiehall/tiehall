import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

// The API reference page at /docs/api (public-api: The API reference page at
// `/docs/api`; design.md, Technical decisions: T10; design.md, Self-hosting
// decisions: S13). It renders the install's own /api/v1/openapi.json with
// Scalar's prebuilt browser bundle, which the install serves itself from
// /docs/api/scalar.js, so the page loads nothing from any other host:
// - Scalar is set up without its web fonts, without telemetry, without the
//   test-request button and the API client it opens, without its developer
//   tools, its agent chat and its MCP panel, and without keeping anything in
//   the browser's storage;
// - the page answers with a strict Content-Security-Policy: nothing by
//   default; scripts only with this answer's nonce, so no inline script, no
//   eval and no script from anywhere else runs; connections to the install
//   only; images from the install or data URLs; no fonts, no <base>, no form
//   submission and no framing. Styles may be inline, because Scalar and the
//   code editor, toaster and theme in its bundle add style elements and
//   attributes at run time without a nonce; a style cannot run code, and no
//   style sheet loads from anywhere;
// - zod, inside the bundle, would try Function() to see whether it may
//   compile its validators; the page tells it beforehand that it may not, so
//   the policy is never tested by the probe.
// - anyone can read it, without signing in: it shows the document, which
//   holds nothing of the install.

export const REFERENCE_PATH = "/docs/api";
export const BUNDLE_PATH = "/docs/api/scalar.js";
export const SCRIPT_PATH = "/docs/api/reference.js";
const DOCUMENT_PATH = "/api/v1/openapi.json";

/** Scalar's standalone browser bundle, as its package ships it; the build carries the file. */
const BUNDLE = new URL("../node_modules/@scalar/api-reference/dist/browser/standalone.js", import.meta.url);

/** Scalar's settings: the install's document, and nothing that reaches another host, sends a request or takes a token. */
const CONFIGURATION = {
  url: DOCUMENT_PATH,
  withDefaultFonts: false,
  telemetry: false,
  hideTestRequestButton: true,
  hideClientButton: true,
  showDeveloperTools: "never",
  agent: { disabled: true },
  mcp: { disabled: true },
  persistAuth: false,
  documentDownloadType: "json",
  theme: "default",
};

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const SCRIPT_HEADERS = {
  "content-type": "text/javascript; charset=utf-8",
  "x-content-type-options": "nosniff",
};

/** The page, with a nonce of its own in its policy and on its scripts. */
export function referencePage(): Response {
  const nonce = randomBytes(18).toString("base64");
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tiehall API reference</title>
  </head>
  <body>
    <noscript>The API reference needs JavaScript. The OpenAPI document is at <a href="${DOCUMENT_PATH}">${DOCUMENT_PATH}</a>.</noscript>
    <div id="reference"></div>
    <script nonce="${nonce}" src="${SCRIPT_PATH}"></script>
    <script nonce="${nonce}" src="${BUNDLE_PATH}"></script>
  </body>
</html>
`;
  return new Response(html, { headers: { ...HTML_HEADERS, "content-security-policy": policy } });
}

/**
 * The page's own script, which runs before the bundle: it sets zod's global
 * configuration to jitless, and starts Scalar with its settings once the
 * bundle has loaded.
 */
export function referenceScript(): Response {
  const script = [
    "globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true });",
    `document.addEventListener("DOMContentLoaded", () => Scalar.createApiReference("#reference", ${JSON.stringify(CONFIGURATION)}));`,
    "",
  ].join("\n");
  return new Response(script, { headers: { ...SCRIPT_HEADERS, "cache-control": "no-cache" } });
}

let bundle: Promise<{ body: Uint8Array<ArrayBuffer>; etag: string }> | undefined;

/** Scalar's bundle, read once per process; a browser revalidates it by its ETag, so an upgrade reaches it at once. */
export async function scalarBundle(request: Request): Promise<Response> {
  bundle ??= readFile(BUNDLE).then((bytes) => ({
    body: new Uint8Array(bytes),
    etag: `"${createHash("sha256").update(bytes).digest("base64url")}"`,
  }));
  const { body, etag } = await bundle;
  const headers = { ...SCRIPT_HEADERS, "cache-control": "no-cache", etag };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

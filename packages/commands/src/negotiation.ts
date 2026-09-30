import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// Content negotiation of request URLs and team intake pages (agent-surfaces:
// Negotiated request URLs; agent-surfaces: Team intake pages; agent-surfaces:
// A browser without a session is sent to sign-in;
// agent-surfaces: Request URL response headers; design.md, Design rules: Agent
// surfaces; design.md, Self-hosting decisions: S15; design.md, Readings to
// confirm with the founder: R17). A request's URL is the install's URL, a
// slash and the request's key, such as /FE-142; since a key is upper case and
// every app path lower case, no key takes an app path's place. It serves
// three representations: markdown for the .md suffix, JSON for the .json
// suffix, and otherwise the one its Accept header asks for, as RFC 9110 has
// it: the representation with the highest quality among those the header
// names, where the most specific range that names each gives its quality; a
// tie goes to the one a more specific range names, then to HTML, markdown and
// JSON in that order. So HTML is what a call negotiates that asks for
// text/html, sends no Accept header, or sends one that names nothing more
// specific that Tiehall serves, such as */*; and a header that names none of
// the three, such as image/png, gets HTML too, the default.
//
// A team's intake page, /<TEAM>, such as /FE, is negotiated the same way.
//
// A path whose letters, digits, hyphens or dots are written percent-encoded,
// such as /%46E-142, is the same URL as the one written plainly (RFC 3986,
// section 6.2.2.2), and Next.js decodes it to the same page; so it names the
// same request or team, and is negotiated as that URL. Any other
// percent-encoding is left as it is, so a path that decodes to another path,
// such as /FE%2F142, names none.
//
// Every answer of a request URL or an intake page, whatever its method, varies
// with its Accept and Authorization headers, may be kept by no cache but the
// caller's own, and has an ETag (agent-surfaces: Request URL response
// headers). A route that answers itself sends Vary: Accept, Authorization,
// Cache-Control: private, no-store and an ETag; the web UI's page, which the
// Next.js app renders after the proxy ran, gets Next.js's own Vary as it
// renders, and the answer to its server action Next.js's own Cache-Control. So
// the web role sets those headers on every answer of a request URL as its head
// goes out, whatever set them (negotiatedUrlHeaders): an answer to a path that
// is one, and an answer the proxy marks as a page it negotiated, which covers
// a path Next.js rewrote before the proxy ran, such as /FE-142.rsc, Next.js's
// own path for the page's RSC payload. The mark is the header by which the
// proxy tells the page the key it negotiated the call as
// (NEGOTIATED_KEY_HEADER), which the web role takes off the answer.

/** The representations a request URL serves. */
export type Representation = "html" | "markdown" | "json";

/** The media type of each representation. */
export const MEDIA_TYPES: Readonly<Record<Representation, string>> = {
  html: "text/html",
  markdown: "text/markdown",
  json: "application/json",
};

/** In the order a tie between them goes. */
const SERVED: readonly Representation[] = ["html", "markdown", "json"];

/** A request URL's path: a key, such as FE-142, and the .md or .json suffix. */
const REQUEST_URL_PATH = /^\/([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9})(\.md|\.json)?$/;

/** A team intake page's path: a team key, such as FE, and the .md or .json suffix. */
const TEAM_URL_PATH = /^\/([A-Z][A-Z0-9]{1,9})(\.md|\.json)?$/;

/** What a request URL's path names: the key, and the representation its suffix asks for, if it has one. */
export interface RequestUrlPath {
  key: string;
  /** The representation the .md or .json suffix names; undefined without one. */
  suffix: Exclude<Representation, "html"> | undefined;
}

/**
 * The header by which the proxy tells the web UI's page of a request URL or
 * an intake page that it negotiated the call, naming the key it read, such as
 * FE-142 or FE: on the call it lets go on to the page, which renders only for
 * that key, and on the page's answer, which the web role takes it off
 * (negotiatedUrlHeaders). The proxy takes it from every other call.
 */
export const NEGOTIATED_KEY_HEADER = "x-tiehall-negotiated-key";

/** A character a URL may carry percent-encoded as well as plain, with the same meaning (RFC 3986, section 2.3). */
const UNRESERVED = /^[A-Za-z0-9._~-]$/;

/** The path with each percent-encoded unreserved character written plainly, such as /%46E-142 as /FE-142; any other percent-encoding is left as it is. */
function withUnreservedDecoded(pathname: string): string {
  return pathname.replace(/%([0-9A-Fa-f]{2})/g, (encoded, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(character) ? character : encoded;
  });
}

/** What a path matched by one of the patterns names: the key, and the suffix's representation. */
function pathOf(match: RegExpExecArray | null): RequestUrlPath | undefined {
  if (match === null) return undefined;
  const suffix = match[2] === ".md" ? "markdown" : match[2] === ".json" ? "json" : undefined;
  return { key: match[1] ?? "", suffix };
}

/** The request URL a path is, or undefined for any other path. */
export function requestUrlOf(pathname: string): RequestUrlPath | undefined {
  return pathOf(REQUEST_URL_PATH.exec(withUnreservedDecoded(pathname)));
}

/**
 * The team intake page a path is, /<TEAM> with or without .md or .json, or
 * undefined for any other path (agent-surfaces: Team intake pages). A team
 * key is upper case, and every app path lower case, so no intake page takes
 * an app path's place: /API is the intake page of a team keyed API, and /api
 * stays the app's.
 */
export function teamUrlOf(pathname: string): RequestUrlPath | undefined {
  return pathOf(TEAM_URL_PATH.exec(withUnreservedDecoded(pathname)));
}

/** The path of a request URL or an intake page as it is written plainly, such as /FE-142.md for /%46E-142%2Emd. */
export function plainPathOf(path: RequestUrlPath): string {
  return `/${path.key}${path.suffix === "markdown" ? ".md" : path.suffix === "json" ? ".json" : ""}`;
}

/** A path that is negotiated: a request URL or a team intake page, with what it names; undefined for any other path. */
export function negotiatedUrlOf(pathname: string): (RequestUrlPath & { kind: "request" | "team" }) | undefined {
  const request = requestUrlOf(pathname);
  if (request !== undefined) return { kind: "request", ...request };
  const team = teamUrlOf(pathname);
  return team === undefined ? undefined : { kind: "team", ...team };
}

/** One media range of an Accept header: its type, its subtype and its quality. */
interface MediaRange {
  type: string;
  subtype: string;
  q: number;
}

/** The media ranges of an Accept header, in lower case; a range that is not type/subtype, or whose quality is not one, is left out. */
function mediaRanges(accept: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const part of accept.split(",")) {
    const [range = "", ...parameters] = part.split(";");
    const [type, subtype, ...rest] = range.trim().toLowerCase().split("/");
    if (type === undefined || subtype === undefined || type === "" || subtype === "" || rest.length > 0) continue;
    let q = 1;
    let valid = true;
    for (const parameter of parameters) {
      const [name = "", value = ""] = parameter.split("=").map((piece) => piece.trim());
      if (name.toLowerCase() !== "q") continue;
      q = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(value) ? Number(value) : Number.NaN;
      valid = !Number.isNaN(q);
    }
    if (valid) ranges.push({ type, subtype, q });
  }
  return ranges;
}

/**
 * The representation a request URL serves a call: the one its suffix names,
 * or the one its Accept header asks for, HTML when it asks for none of them.
 */
export function negotiate(accept: string | null | undefined, suffix?: Exclude<Representation, "html">): Representation {
  if (suffix !== undefined) return suffix;
  if (accept === null || accept === undefined || accept.trim() === "") return "html";
  const ranges = mediaRanges(accept);
  let best: { representation: Representation; q: number; specificity: number } | undefined;
  for (const representation of SERVED) {
    const [type, subtype] = MEDIA_TYPES[representation].split("/");
    // The most specific range that names the representation gives its quality.
    let match: { q: number; specificity: number } | undefined;
    for (const range of ranges) {
      const specificity = range.type === type && range.subtype === subtype ? 2 : range.type === type && range.subtype === "*" ? 1 : range.type === "*" && range.subtype === "*" ? 0 : -1;
      if (specificity < 0 || (match !== undefined && match.specificity >= specificity)) continue;
      match = { q: range.q, specificity };
    }
    if (match === undefined || match.q === 0) continue;
    if (best === undefined || match.q > best.q || (match.q === best.q && match.specificity > best.specificity)) {
      best = { representation, ...match };
    }
  }
  return best?.representation ?? "html";
}

/** Whether a call to this path and query negotiates HTML, given its Accept header; undefined when it is no request URL or intake page. */
export function requestUrlNegotiatesHtml(target: string, accept: string | null | undefined): boolean | undefined {
  let pathname: string;
  try {
    pathname = new URL(target, "http://localhost").pathname;
  } catch {
    return undefined;
  }
  const path = negotiatedUrlOf(pathname);
  return path === undefined ? undefined : negotiate(accept, path.suffix) === "html";
}

/** The headers every answer of a request URL varies with. */
export const NEGOTIATED_VARY = ["Accept", "Authorization"] as const;

/** A Vary value with Accept and Authorization added to the names it lists, each once. */
export function withNegotiatedVary(vary: string | readonly string[] | number | undefined): string {
  const listed = (typeof vary === "number" ? String(vary) : Array.isArray(vary) ? vary.join(",") : ((vary as string | undefined) ?? ""))
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (listed.includes("*")) return "*";
  const names = [...listed];
  for (const name of NEGOTIATED_VARY) if (!names.some((listedName) => listedName.toLowerCase() === name.toLowerCase())) names.push(name);
  return names.join(", ");
}

/** The caching every answer of a request URL or an intake page allows: none but the caller's own, and nothing stored. */
export const NEGOTIATED_CACHE_CONTROL = "private, no-store";

/**
 * Makes the answer to a call to a request URL or an intake page, whatever its
 * method, carry the headers every answer of one carries, whatever sets its
 * headers before the head goes out, such as Next.js rendering the web UI's
 * page or answering its server action: Vary with Accept and Authorization
 * among its names, Cache-Control: private, no-store, and an ETag, one of its
 * own when nothing gave it one. So does an answer the proxy marks as a page it
 * negotiated, at whatever path, and the mark goes to nobody. Any other answer
 * is left as it is. The web role runs it on every call it serves.
 */
export function negotiatedUrlHeaders(request: IncomingMessage, response: ServerResponse): void {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    pathname = "";
  }
  const negotiatedPath = negotiatedUrlOf(pathname) !== undefined;
  const writeHead = response.writeHead;
  response.writeHead = function (this: ServerResponse, statusCode: number, ...rest: unknown[]) {
    // writeHead(status, [statusMessage], [headers]): headers given here win over those set before, so their Vary is merged first.
    const headersAt = rest.findIndex((argument) => typeof argument === "object" && argument !== null);
    const given = headersAt === -1 ? undefined : rest[headersAt];
    // Raw headers are [name, value, name, value, ...] or [[name, value], ...].
    const flat = Array.isArray(given) ? ((given.length > 0 && Array.isArray(given[0]) ? (given as unknown[][]).flat() : given) as unknown[]) : undefined;
    const givenNames = flat !== undefined ? flat.filter((_, index) => index % 2 === 0).map(String) : given === undefined ? [] : Object.keys(given as object);
    const marked = this.getHeader(NEGOTIATED_KEY_HEADER) !== undefined || givenNames.some((name) => name.toLowerCase() === NEGOTIATED_KEY_HEADER);
    if ((negotiatedPath || marked) && !this.headersSent) {
      const set = this.getHeader("vary");
      const listed: string[] = set === undefined ? [] : Array.isArray(set) ? [...set] : [String(set)];
      let etag = this.getHeader("etag");
      // Vary, Cache-Control and the mark are set below; an ETag given here is kept.
      const replaced = (name: string): boolean => name === "vary" || name === "cache-control" || name === NEGOTIATED_KEY_HEADER;
      if (flat !== undefined) {
        const kept: unknown[] = [];
        for (let index = 0; index + 1 < flat.length; index += 2) {
          const name = String(flat[index]).toLowerCase();
          if (name === "vary") listed.push(String(flat[index + 1]));
          if (name === "etag") etag = String(flat[index + 1]);
          if (!replaced(name)) kept.push(flat[index], flat[index + 1]);
        }
        rest[headersAt] = kept;
      } else if (given !== undefined) {
        const copy: Record<string, unknown> = { ...(given as Record<string, unknown>) };
        for (const name of Object.keys(copy)) {
          const lower = name.toLowerCase();
          if (lower === "vary") listed.push(String(copy[name]));
          if (lower === "etag") etag = String(copy[name]);
          if (replaced(lower)) delete copy[name];
        }
        rest[headersAt] = copy;
      }
      this.removeHeader(NEGOTIATED_KEY_HEADER);
      this.setHeader("vary", withNegotiatedVary(listed));
      this.setHeader("cache-control", NEGOTIATED_CACHE_CONTROL);
      // An answer that no one gave an ETag is its own representation, which no other answer shares.
      if (etag === undefined) this.setHeader("etag", `W/"${randomBytes(18).toString("base64url")}"`);
    }
    return (writeHead as (...args: unknown[]) => ServerResponse).call(this, statusCode, ...rest);
  } as typeof response.writeHead;
}

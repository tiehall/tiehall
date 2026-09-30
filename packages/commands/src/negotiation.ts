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
// Every answer of a request URL or an intake page varies with its Accept and
// Authorization headers. A route that answers itself sends Vary: Accept, Authorization; the
// web UI's page, which the Next.js app renders, gets Next.js's own Vary, which
// it sets as the page renders, after the proxy ran. So the web role adds
// Accept and Authorization to the Vary of every answer of a request URL as its
// head goes out, whatever set it (varyOnNegotiatedUrls).

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

/** What a path matched by one of the patterns names: the key, and the suffix's representation. */
function pathOf(match: RegExpExecArray | null): RequestUrlPath | undefined {
  if (match === null) return undefined;
  const suffix = match[2] === ".md" ? "markdown" : match[2] === ".json" ? "json" : undefined;
  return { key: match[1] ?? "", suffix };
}

/** The request URL a path is, or undefined for any other path. */
export function requestUrlOf(pathname: string): RequestUrlPath | undefined {
  return pathOf(REQUEST_URL_PATH.exec(pathname));
}

/**
 * The team intake page a path is, /<TEAM> with or without .md or .json, or
 * undefined for any other path (agent-surfaces: Team intake pages). A team
 * key is upper case, and every app path lower case, so no intake page takes
 * an app path's place: /API is the intake page of a team keyed API, and /api
 * stays the app's.
 */
export function teamUrlOf(pathname: string): RequestUrlPath | undefined {
  return pathOf(TEAM_URL_PATH.exec(pathname));
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

/**
 * Makes the answer to a call to a request URL send Vary with Accept and
 * Authorization among its names, whatever sets its headers before the head
 * goes out, such as Next.js rendering the web UI's page; any other call is
 * left as it is. The web role runs it on every call it serves.
 */
export function varyOnNegotiatedUrls(request: IncomingMessage, response: ServerResponse): void {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return;
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return;
  }
  if (negotiatedUrlOf(pathname) === undefined) return;
  const writeHead = response.writeHead;
  response.writeHead = function (this: ServerResponse, statusCode: number, ...rest: unknown[]) {
    // writeHead(status, [statusMessage], [headers]): headers given here win over those set before, so their Vary is merged first.
    const headersAt = rest.findIndex((argument) => typeof argument === "object" && argument !== null);
    const set = this.getHeader("vary");
    const listed: string[] = set === undefined ? [] : Array.isArray(set) ? [...set] : [String(set)];
    if (headersAt !== -1) {
      const headers = rest[headersAt];
      if (Array.isArray(headers)) {
        // Raw headers: [name, value, name, value, ...] or [[name, value], ...].
        const flat = (headers.length > 0 && Array.isArray(headers[0]) ? (headers as unknown[][]).flat() : headers) as unknown[];
        const kept: unknown[] = [];
        for (let index = 0; index + 1 < flat.length; index += 2) {
          if (String(flat[index]).toLowerCase() === "vary") listed.push(String(flat[index + 1]));
          else kept.push(flat[index], flat[index + 1]);
        }
        rest[headersAt] = kept;
      } else {
        const copy: Record<string, unknown> = { ...(headers as Record<string, unknown>) };
        for (const name of Object.keys(copy)) {
          if (name.toLowerCase() !== "vary") continue;
          listed.push(String(copy[name]));
          delete copy[name];
        }
        rest[headersAt] = copy;
      }
    }
    if (!this.headersSent) this.setHeader("vary", withNegotiatedVary(listed));
    return (writeHead as (...args: unknown[]) => ServerResponse).call(this, statusCode, ...rest);
  } as typeof response.writeHead;
}

import { CATALOG, type Catalog } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { WEBHOOKS_GITHUB_PATH } from "./setup-gate.ts";

// Request bodies have a size limit (public-api: Request bodies have a size
// limit; public-api: One error model for Tiehall's own refusals;
// contract-changes: One report operation that never takes a whole spec;
// request-body-limit's design.md, Decisions this change rests on: D43, and
// Technical decisions: T1). This module holds the two limits and everything
// that applies them, so the web role's request guard, the REST route and,
// once it is built, the /mcp route refuse with the same numbers and the same
// problem:
// - every request body may be 2 MiB, and the one that carries a
//   contract.report 16 MiB, read from the method and path of the catalog's
//   contract.report definition; until that operation is defined, every path
//   gets 2 MiB. A MiB is 1,048,576 bytes, and a body of exactly the limit is
//   not refused for its size;
// - the webhook deliveries get no limit here, which is an open question
//   (design.md, Readings to confirm: R1; Open Questions): today that is
//   /webhooks/github;
// - a body over the limit is refused with the error model's
//   payload-too-large, 413, whose detail names the limit in MiB;
// - the bounded reader refuses a declared length above the limit before it
//   reads a byte of the body, and otherwise counts the bytes it reads, not a
//   declared length, and at the first byte past the limit cancels the stream
//   and refuses, so a body over the limit is never held whole.

/** 1,048,576 bytes. */
export const MIB = 1024 * 1024;

/** The limit on every request body, except the one that carries a contract.report. */
export const BODY_LIMIT = 2 * MIB;

/** The limit on a contract.report body, which carries classified OpenAPI diffs that can be large. */
export const CONTRACT_REPORT_BODY_LIMIT = 16 * MIB;

/** The operation whose body gets the larger limit. */
export const CONTRACT_REPORT_ID = "contract.report";

/** The paths whose bodies get no limit here: the webhook deliveries, whose limit is an open question. */
export const UNLIMITED_BODY_PATHS: readonly string[] = [WEBHOOKS_GITHUB_PATH];

interface ReportRoute {
  method: string;
  pattern: RegExp;
}

const reportRoutes = new WeakMap<Catalog, ReportRoute | null>();

/** The method and path of the catalog's contract.report, as a pattern whose parameters match one path segment. */
function reportRouteOf(catalog: Catalog): ReportRoute | undefined {
  let route = reportRoutes.get(catalog);
  if (route === undefined) {
    const definition = catalog.get(CONTRACT_REPORT_ID);
    route =
      definition?.method === undefined || definition.path === undefined
        ? null
        : {
            method: definition.method,
            pattern: new RegExp(
              `^${definition.path
                .split("/")
                .map((segment) => (/^\{[^}]*\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
                .join("/")}$`,
            ),
          };
    reportRoutes.set(catalog, route);
  }
  return route ?? undefined;
}

/**
 * The most bytes a request with this method and path may carry in its body,
 * or undefined for a path whose body gets no limit here.
 */
export function bodyLimitFor(method: string, pathname: string, catalog: Catalog = CATALOG): number | undefined {
  if (UNLIMITED_BODY_PATHS.includes(pathname)) return undefined;
  const report = reportRouteOf(catalog);
  if (report !== undefined && method.toUpperCase() === report.method && report.pattern.test(pathname)) return CONTRACT_REPORT_BODY_LIMIT;
  return BODY_LIMIT;
}

/** The refusal of a body over this limit, whose detail names the limit in MiB. */
export function payloadTooLarge(limit: number): Refusal {
  return new Refusal(
    "payload-too-large",
    `The request body is larger than ${limit / MIB} MiB, the most Tiehall takes here, so it was not read and nothing ran.`,
  );
}

/** The length a Content-Length header declares, or undefined when it declares none. */
export function declaredLength(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined || !/^\s*\d+\s*$/.test(header)) return undefined;
  return Number(header);
}

/**
 * The request's body, read up to the limit: a declared length above it is
 * refused before any byte is read, and otherwise the bytes are counted as
 * they arrive and the stream is cancelled at the first byte past it. With no
 * limit, the body is read whole.
 */
export async function readBoundedBody(request: Request, limit: number | undefined): Promise<Uint8Array> {
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  if (limit === undefined) return new Uint8Array(await request.arrayBuffer());
  const declared = declaredLength(request.headers.get("content-length"));
  if (declared !== undefined && declared > limit) {
    void body.cancel().catch(() => {});
    throw payloadTooLarge(limit);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      void reader.cancel().catch(() => {});
      throw payloadTooLarge(limit);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

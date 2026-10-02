import { BODY_LIMIT, CATALOG, CONTRACT_REPORT_BODY_LIMIT, CONTRACT_REPORT_ID, MIB, restShapesOf, type Catalog } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { WEBHOOKS_GITHUB_PATH } from "./setup-gate.ts";

// Request bodies have a size limit (public-api: Request bodies have a size
// limit; public-api: One error model for Tiehall's own refusals;
// contract-changes: One report operation that never takes a whole spec;
// request-body-limit's design.md, Decisions this change rests on: D43, and
// Technical decisions: T1). This module holds the limits and everything
// that applies them, so the web role's request guard, the REST route and,
// once it is built, the /mcp route refuse with the same numbers and the same
// problem:
// - every request body may be 2 MiB, and the one that carries a
//   contract.report 16 MiB, read from the method and path of the catalog's
//   contract.report definition; until that operation is defined, every path
//   gets 2 MiB. A MiB is 1,048,576 bytes, and a body of exactly the limit is
//   not refused for its size. The two numbers are defined in the catalog
//   package, whose OpenAPI document states them, and are re-exported here;
// - a GitHub webhook delivery at /webhooks/github may be 25 MiB, which covers
//   GitHub's own documented maximum of 25 MB under either reading of MB, so
//   no delivery GitHub can send is refused, and no body of any size is read
//   before its signature is checked (the change github-layer-hardening
//   settles request-body-limit's open question on webhook deliveries so);
// - a body over the limit is refused with the error model's
//   payload-too-large, 413, whose detail names the limit in MiB;
// - the bounded reader refuses a declared length above the limit before it
//   reads a byte of the body, and otherwise counts the bytes it reads, not a
//   declared length, and at the first byte past the limit cancels the stream
//   and refuses, so a body over the limit is never held whole.

export { BODY_LIMIT, CONTRACT_REPORT_BODY_LIMIT, MIB };

/** The most bytes a GitHub webhook delivery may carry: 25 MiB, 26,214,400 bytes, at least GitHub's own 25 MB. */
export const GITHUB_WEBHOOK_BODY_LIMIT = 25 * MIB;

/** The webhook paths and the limit of each, which is not the 2 MiB of every other path. */
export const WEBHOOK_BODY_LIMITS: Readonly<Record<string, number>> = { [WEBHOOKS_GITHUB_PATH]: GITHUB_WEBHOOK_BODY_LIMIT };

interface ReportRoute {
  method: string;
  pattern: RegExp;
}

const reportRoutes = new WeakMap<Catalog, readonly ReportRoute[]>();

/**
 * The methods and paths of the catalog's contract.report, in each major
 * version of the API that serves it, as patterns whose parameters match one
 * path segment.
 */
function reportRoutesOf(catalog: Catalog): readonly ReportRoute[] {
  let routes = reportRoutes.get(catalog);
  if (routes === undefined) {
    routes = restShapesOf(catalog)
      .filter(({ definition }) => definition.id === CONTRACT_REPORT_ID)
      .map(({ method, path }) => ({
        method,
        pattern: new RegExp(
          `^${path
            .split("/")
            .map((segment) => (/^\{[^}]*\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
            .join("/")}$`,
        ),
      }));
    reportRoutes.set(catalog, routes);
  }
  return routes;
}

/** The most bytes a request with this method and path may carry in its body. */
export function bodyLimitFor(method: string, pathname: string, catalog: Catalog = CATALOG): number {
  const webhook = Object.hasOwn(WEBHOOK_BODY_LIMITS, pathname) ? WEBHOOK_BODY_LIMITS[pathname] : undefined;
  if (webhook !== undefined) return webhook;
  if (reportRoutesOf(catalog).some((report) => method.toUpperCase() === report.method && report.pattern.test(pathname))) return CONTRACT_REPORT_BODY_LIMIT;
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

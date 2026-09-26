import type { CommandDefinition } from "./command.ts";

// The headers of a deprecated operation (public-api: Deprecated operations
// send Deprecation and Sunset headers; design.md, Technical decisions: T10).
// Every response from a deprecated operation carries Deprecation (RFC 9745),
// the day its deprecation was released as a structured-field date, and, once
// it has a sunset date, Sunset (RFC 8594), the start of that day as an
// HTTP-date. Both come from the definition's `deprecated` metadata, the same
// that gives the OpenAPI document its `deprecated: true` and `x-sunset`.

/** The Deprecation and Sunset headers of an operation, by lower-case name; none when it is not deprecated. */
export function deprecationHeaders(definition: Pick<CommandDefinition, "deprecated">): Record<string, string> {
  const { deprecated } = definition;
  if (deprecated === undefined) return {};
  const since = startOfDay(deprecated.since);
  return {
    // An sf-date: "@" and the seconds since the epoch (RFC 9651).
    deprecation: `@${Math.floor(since.getTime() / 1000)}`,
    // An IMF-fixdate, such as Tue, 15 Dec 2026 00:00:00 GMT (RFC 9110).
    ...(deprecated.sunset === undefined ? {} : { sunset: startOfDay(deprecated.sunset).toUTCString() }),
  };
}

/** Midnight UTC at the start of a calendar day written as YYYY-MM-DD, which the catalog checks. */
function startOfDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

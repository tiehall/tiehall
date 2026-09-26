import { PACKET_SCHEMA_JSON } from "@tiehall/catalog";

// The beta packet schema on every install (handoff-packet: The beta label;
// design.md, Technical decisions: T11; design.md, Self-hosting decisions: S13;
// design.md, Readings to confirm with the founder: R22). The install serves
// the packet JSON Schema at /schemas/packet/v1-beta.json to anyone, without
// signing in, because it holds no data of the install; before setup is
// complete the setup gate answers there instead, as for every call under
// /schemas. The schema's $id, https://tiehall.com/schemas/packet/v1-beta.json,
// names it and is never fetched: the install serves and validates packets
// with what its build carries.

/** Where every install serves the beta packet schema. */
export const PACKET_SCHEMA_PATH = "/schemas/packet/v1-beta.json";

const HEADERS = {
  "content-type": "application/schema+json",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
} as const;

/** The answer to a GET or HEAD of /schemas/packet/v1-beta.json: the schema, the same for every reader. */
export function packetSchemaRoute(request: Request): Response {
  return new Response(request.method === "HEAD" ? null : PACKET_SCHEMA_JSON, { status: 200, headers: HEADERS });
}

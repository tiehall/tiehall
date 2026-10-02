import document from "../../../openapi/v1.json" with { type: "json" };

// The OpenAPI document an install serves at /api/v1/openapi.json (public-api:
// Every install serves the OpenAPI 3.1 document without authentication;
// design.md, Technical decisions: T10). It is the committed openapi/v1.json,
// carried in the build rather than generated at run time, so the server never
// loads the generator and every install of a release serves the same bytes.
// The committed file is written with sorted keys and two-space indents, which
// JSON.stringify keeps, so this text is the file itself; the drift check in
// CI keeps the file equal to what the catalog generates.

export const OPENAPI_JSON = `${JSON.stringify(document, null, 2)}\n`;

/**
 * The document of each major version of the API the install serves, by major
 * version, as /api/vN/openapi.json serves it (design.md, Where the specs leave
 * room: Two API versions): only /api/v1 while no operation has moved to a
 * later one. A release whose catalog serves /api/v2 commits openapi/v2.json
 * and adds it here, and a test fails until it does.
 */
export const OPENAPI_DOCUMENTS: Readonly<Record<number, string>> = { 1: OPENAPI_JSON };

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

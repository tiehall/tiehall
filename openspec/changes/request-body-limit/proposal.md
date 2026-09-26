# Proposal: Request body limit

## Why

Nothing in add-tiehall-oss-v1 bounds the size of a request body: no design rule sets a limit and the error model has no 413 row, so nothing was built. The REST route reads a whole body into memory before it parses it, and `/mcp` and the web UI's forms will do the same. On a self-hosted install that is an easy way to exhaust memory for anyone who can reach the host: the bundled `Caddyfile` sets no limit, and an install behind an operator's own proxy gets whatever that proxy does. D43, accepted on 2026-09-27, sets the limit; [design.md](design.md#decisions-this-change-rests-on) restates it with the alternatives that lost.

## What Changes

- Every request body under `/api/v1` and `/mcp`, except a `contract.report` body, and every form post of the web UI, is limited to 2 MiB. A `contract.report` body is limited to 16 MiB, because it carries classified OpenAPI diffs that can be large.
- A body over the limit is refused with 413 and the problem type `payload-too-large` before it is parsed, and so before any other refusal, including a missing token and the setup gate. The limit counts the bytes received, not a declared length, so a chunked body is limited too, and the rest of the body is never read. On `/mcp` the refusal is an HTTP status, not a tool error.
- The 413 row joins the error model's table, and the OpenAPI document lists 413 on every operation that takes a body, so `@tiehall/client` carries it and the CLI shows it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `public-api`: adds the requirement "Request bodies have a size limit", and adds the 413 row to the error model's table.
- `contract-changes`: the report operation names its 16 MiB limit.

## Impact

- **Code:** the error model module, the REST route, the web role's request guard, the web app's setting for form bodies, the OpenAPI generator and the committed document `openapi/v1.json`. The `/mcp` route and `contract.report`, when the main change builds them, read their bodies through the same module.
- **Public contracts:** `/api/v1` and `/mcp` gain a 413 answer. The OpenAPI document gains a response on every operation with a body, which is additive and passes the compatibility check.
- **External systems:** the contract Action already fails open on any error from the install, so a 413 costs no PR check.
- **Order:** this change is archived after add-tiehall-oss-v1, because its MODIFIED requirements apply to specs that change creates.

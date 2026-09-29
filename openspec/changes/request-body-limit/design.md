# Design: Request body limit

## Context

[proposal.md](proposal.md) says why request bodies get a size limit. This document restates the decision the specs rest on, says how the limit is built, and records what stays open. It cites nothing outside this repository.

**How the specs cite this document.** Every `Source:` line in `specs/*/spec.md` cites the sections of this document that the rule comes from, as add-tiehall-oss-v1's design.md describes: decisions first, sections after, separated by semicolons. The sections are:
- **Decisions this change rests on** (`design.md, Decisions this change rests on`): D43, as a public rule, with the alternatives that lost, and a note of the decisions carried from add-tiehall-oss-v1.
- **Design rules: Request body limit** (`design.md, Design rules: Request body limit`): the rules the added and changed requirements state.
- **Rules carried from add-tiehall-oss-v1** (`design.md, Rules carried from add-tiehall-oss-v1`): the parts of the MODIFIED requirements that this change keeps unchanged, whose sources stay in that change's design.md.
- **Technical decisions T1–T3** (`design.md, Technical decisions: T1`): where the limit lives and how it is enforced.

**Current state.** The REST catch-all route (`packages/commands/src/rest.ts`) reads a whole body into memory with one call before it parses it. The web role's request guard (`apps/server/src/request-guard.ts`) sees every request before the web framework does, and already answers one refusal of the error model itself, the 503 during shutdown, with an RFC 9457 problem. The web UI's forms post to server actions, whose bodies the framework reads before any Tiehall code runs, under the framework's own default cap of 1 MB and with an error of the framework's own shape, not a problem. `/mcp` (add-tiehall-oss-v1, group 16) and `contract.report` (group 22) are not built yet. The bundled `Caddyfile` sets no body limit. The error model module (`packages/core/src/error-model.ts`) is one table of refusal reasons, each with its status, title and problem type; the OpenAPI generator (`packages/catalog/src/openapi.ts`) adds the same error responses to every operation from small tables keyed by method.

**Constraints.**
- The limit must hold on an install that runs without any proxy, so it is Tiehall's own, at its own HTTP layer.
- A body over the limit must never be buffered: the answer goes out at the byte that passes the limit, and the rest is not read.
- The answer is one of Tiehall's own refusals, so it follows the error model on every endpoint (D28 #1 in add-tiehall-oss-v1).
- The API is beta and its document is checked for breaking changes in CI; the change to the document must be additive.

## Goals / Non-Goals

**Goals:**
- No request body under `/api/v1`, `/mcp` or the web UI's forms is held in memory without a bound, on any install, with or without a proxy in front; the webhook paths are an open question.
- One answer for a body over the limit, on every surface: 413 with the problem type `payload-too-large`, in the error model, in the OpenAPI document, shown by the CLI.
- `contract.report` keeps room for classified diffs that are larger than any packet.

**Non-Goals:**
- Limits on single fields. The packet's field caps and the 16 KB cap on `extensions` stay as the handoff-packet capability defines.
- Limits on responses, on the number of calls (the agent-safety capability's write limits), or on webhook deliveries (Open Questions).
- A setting. The limits are fixed and the same on every install.

## Decisions

### Decisions this change rests on

- **D43. Request bodies have a size limit.** Request bodies have a size limit: 2 MiB for `/api/v1` and `/mcp` bodies, 16 MiB for `contract.report`. Over the limit the answer is 413 with the problem type `payload-too-large`, which is added to the error table and to the OpenAPI document. Accepted by the maintainer on 2026-09-27.
  - **Why.** No spec or design rule set a body size limit or a 413 row, so nothing was built. An unbounded body is a memory and abuse risk for a self-hosted install, which may run without a proxy that limits bodies.
  - **Alternatives that lost.**
    - *No limit.* Anyone who can reach the host can make the app buffer bodies until it runs out of memory; the packet's field caps do not help, because they apply only after the body is parsed.
    - *Relying on the operator's reverse proxy.* The bundled `Caddyfile` sets no limit, many installs run behind a proxy of their own, and a proxy's refusal is not an RFC 9457 problem of Tiehall's, so clients would see a different answer on each install.
    - *One limit for everything.* `contract.report` carries classified OpenAPI diffs that can be large, so one limit would either cut reports or give every agent write the headroom only reports need.

Carried, restated in add-tiehall-oss-v1's design.md and not repeated here: D14, D28 #1, D29 (7) and D30 (Rules carried from add-tiehall-oss-v1).

### Design rules: Request body limit

These are the rules the specs state. "MiB" means 1,048,576 bytes.

- **Which requests.** 2 MiB for every request under `/api/v1` and `/mcp`, except the `contract.report` operation, and for the web UI's own forms; 16 MiB for the request that carries a `contract.report` body. The limits are inclusive: a body of exactly the limit is not refused for its size. (Which other routes of the install get the 2 MiB limit is a reading, R1.)
- **Counting.** The limit counts the bytes received, not the length the request declares, so a body sent in chunks without a declared length is limited too. A request that declares a length above the limit is refused before any byte of its body is read. Otherwise the bytes are counted as they arrive, and the check happens before the body is parsed: nothing runs, nothing changes, no event is appended and no `Idempotency-Key` is kept for a body over the limit, whatever it holds. The check comes before authentication, before the setup gate and before any route, so 413 wins over every other row of the error model: a body over the limit is answered 413 even without a token and even before setup is complete.
- **Stopping.** At the byte that passes the limit, Tiehall sends the answer and reads no more of the body. The answer carries `Connection: close`, and the connection is closed once the answer has been sent, so the client stops sending (R3).
- **The answer.** 413, as an RFC 9457 problem with the media type `application/problem+json`, the problem type `https://tiehall.com/problems/payload-too-large` (T10 in add-tiehall-oss-v1: the name the spec gives ends the URI), the same title on every occurrence, and a detail in server text that names the limit that applied, in MiB. It carries no `Retry-After`. It is a row of the error model, so the MCP tools' rule for tool errors does not apply to it (next point), and the CLI shows it as it shows every problem.
- **On `/mcp`.** A body over the limit is refused with the HTTP status 413, not with a tool error, like a refused request state and the OAuth refusals: the body is refused before it is parsed, so there is no JSON-RPC request to answer inside an HTTP 200.
- **The web UI's forms.** A form post over 2 MiB gets the same 413 problem. The web framework's own cap on form bodies is set to the same 2 MiB, so no form under the limit is refused by the framework and no form over it gets the framework's own error instead of Tiehall's (T2).
- **The document.** The OpenAPI document lists 413 on every operation that takes a body, as an RFC 9457 problem, described with the limit that applies to that operation: 2 MiB, and 16 MiB on `contract.report`. Operations without a body list no 413. The `Problem` component is unchanged. Adding a response is additive, so the compatibility check passes and no changelog entry of kind breaking is needed; the changelog of the release that carries it lists the added responses like any other additive change.
- **The CLI and the client.** `@tiehall/client` is generated from the document and so carries the 413 answer of every body operation. The CLI shows the problem it gets, whose detail names the limit; `tiehall contract report` gets the same problem for a report over 16 MiB, and the contract Action fails open on it as on any error from the install (the contract-changes capability).

### Rules carried from add-tiehall-oss-v1

The two MODIFIED requirements keep every row, sentence and scenario they had, and add the 413 row and its sentences. The unchanged parts rest on the sources their original `Source:` lines cite, which stay restated in add-tiehall-oss-v1's design.md and are not repeated here: for the error model, D28 #1, D29 (7) and D30 under "Decisions this change rests on", T7 and T9 under "Technical decisions", and S3, S5, S6, S7 and S12 under "Self-hosting decisions"; for the report operation, D14 under "Decisions this change rests on" and the design rules for contract changes and the handoff packet.

### Technical decisions

#### T1. One module for the limits and the bounded read

- **Choice.** One module in `packages/commands` holds the two limits and everything that applies them: `bodyLimitFor(method, path)`, which gives 16 MiB to the method and path of the catalog's `contract.report` definition and 2 MiB to every other path (except the paths R1 leaves out); a bounded reader for a `Request` that reads the body stream, counts bytes, throws the `payload-too-large` refusal at the first byte past the limit and cancels the stream; and the `Content-Length` shortcut. The refusal reason `payload-too-large` is a row of the error model module in `packages/core`, with the status 413 and no `Retry-After`. Until the main change's task 22.5 defines `contract.report`, the catalog holds no such definition and every path gets 2 MiB; the 16 MiB branch and its tests turn on with 22.5.
- **Why.** The request guard, the REST route and the `/mcp` route get the same numbers and the same problem from one place, and the path of `contract.report` is read from the catalog rather than written twice.
- **Alternatives.** A limit written into each route, which drifts. A limit in the catalog definition of each operation, which would put transport details into the operation's public definition and its document for one exception.

#### T2. Enforced first at the HTTP layer, in the request guard

- **Choice.** The web role's request guard enforces the limit for every request the web role serves, before the framework sees the body: it refuses a declared length above the path's limit at once, and passes on a body that declares a length within it, which cannot carry more than it declares. A body sent in chunks, with no declared length, it holds, counting its bytes, until the body is complete or passes the limit: a complete body within the limit is passed on whole, so the framework never sees part of a body over the limit; at the byte past the limit it drops what it held, answers 413 with the problem and `Connection: close`, stops reading, ends the connection once the answer is sent, and closes it after a short grace period in which it is still not read, so that the client reads the 413 before the reset its unread body causes. This is the same pattern as its 503 during shutdown. A call counts as in flight from the moment its head arrives, a held body included, so a shutdown waits for a body still arriving in chunks as for any call in flight: a call whose head arrived before the shutdown started goes on to the app once its body is complete, and one whose head arrived after it gets its 503, or its 413. The REST route and, when group 16 of add-tiehall-oss-v1 builds it, the `/mcp` route read their bodies through the module's bounded reader too, so the rule holds where the guard is not installed: unit tests that call the route directly, and the development server. The framework's cap on server-action bodies is set to 2 MiB in the web app's configuration (Next.js `serverActions.bodySizeLimit`; its default is 1 MB and its refusal is not an RFC 9457 problem), so the guard's answer always comes first.
- **Why.** The guard is the only place that sees every body of every route, that can answer before any byte is buffered by the framework, and that can close the connection. The bounded reader in the routes keeps the tests of each route self-contained.
- **Alternatives.** The framework's cap alone: 1 MB by default, an answer of its own shape, and no control over `/mcp` route handlers, which read a stream. Route handlers alone: they do not cover the web UI's forms, or a route that has no handler of its own. A proxy: not every install has one (D43).

#### T3. The document, the compatibility check and the tests

- **Choice.** The OpenAPI generator adds 413 to the error responses of every operation whose method takes a body, with a description that names 2 MiB, or 16 MiB for `contract.report`, and the `Problem` component. `openapi/v1.json` is regenerated and committed; `pnpm check:openapi` fails until it is, and `pnpm check:api-compat` passes, because an added response is not a breaking change. The 413 row gets its REST test in the error model's test file, which the main change's coverage check of the error model (task 26.7 there) will look for; the row needs no MCP tool-error test, because on `/mcp` it is an HTTP status. The tests that need the real HTTP layer (a declared length, a chunked body, `Connection: close`, `/mcp`, a web form) run against the web role's server, as its shutdown test does.
- **Alternatives.** A 413 on every operation, GET included, which documents an answer no documented call can get. A 413 only on `contract.report` and the packet operations, which leaves other bodies undocumented.

### Where the specs leave room

- The module's name and the exact server text of the problem's detail, as long as it names the limit in MiB.
- Whether the guard destroys the socket at once or only after the answer has been flushed, as long as the rest of the body is never read and the client gets the 413.
- How the `/mcp` route, once built, passes the bounded body to the MCP library's handler.

## Risks / Trade-offs

- [A valid body could be larger than 2 MiB] → The packet's caps are in characters, and the limit counts bytes: a request packet at every cap stays under 1 MiB in ASCII, but a contract-change packet at every cap is about 1.9 MB in ASCII and passes 2 MiB with multi-byte text, so a valid packet revision that carries a large contract section can be refused for its size. Open Questions records it; a change to the limit or to the caps is a new change.
- [16 MiB is more than the packet's contract section, which a report's classified changes become, can hold today: 1,000 classified changes of at most 1,200 characters each] → The limit is transport headroom for the classified diffs D43 names, and the schema's own caps still apply after it; raising the caps later needs no change here.
- [An install behind a proxy with a lower limit answers with the proxy's error, not Tiehall's] → The install docs say so, and the bundled `Caddyfile` keeps no limit of its own, so the Caddy profile gives Tiehall's answer.
- [Closing the connection after a 413 costs a client one reconnect] → It is the usual practice for a body refused while it is still being sent, and clients reconnect.
- [The framework's cap on form bodies could drift from the guard's] → A test posts a form body just under and just over 2 MiB through the web role's server.

Three notes for later, the first two for tasks of add-tiehall-oss-v1 that are not built yet:

- [Next.js's proxy (`apps/web/proxy.ts`), which runs before every route, copies every request body and cuts it at 10 MiB, 10,485,760 bytes (`experimental.proxyClientMaxBodySize`), below the 16 MiB of `contract.report`] → When the main change's task 22.5 builds `contract.report`, it raises that setting to 16 MiB in the web app's configuration or narrows the proxy's matcher so that the proxy does not run on the report's path, and the two expected failures in `packages/commands/test/body-limit.test.ts` become plain tests.
- [The Jira webhook, which the main change's group 25 builds, would get the 2 MiB limit, unlike `/webhooks/github`] → Its path joins `WEBHOOK_BODY_LIMITS` in `packages/commands/src/body-limit.ts` when group 25 builds it, with the limit that the Open Question on the Jira webhook settles. Its path carries a random secret segment (the main change's task 25.8), so the exact match `bodyLimitFor` makes today must then match the path's fixed part.
- [A request with `Expect: 100-continue` gets "100 Continue" from Node before the guard runs, so a client that waits for it starts sending even a body the guard refuses, such as one that declares a length over the limit] → The guard still refuses the body as it refuses any other and reads no more of it. A `checkContinue` handler on the guarded servers would let the guard answer 413 in place of "100 Continue", so that the client does not send such a body at all.

## Migration Plan

Additive to the API: every existing call that was under the limit answers as before. No data, no setting and no operator step changes. This change is archived after add-tiehall-oss-v1, because its MODIFIED requirements apply to the public-api and contract-changes specs that change creates. The `/mcp` and `contract.report` cases in tasks.md turn on when the main change's groups 16 and 22 build those endpoints.

## Open Questions

- **The Jira webhook.** `github-layer-hardening`'s D50 (19) settled `/webhooks/github`: 25 MiB, GitHub's own maximum, refused before the signature is checked. The Jira webhook that add-tiehall-oss-v1 adds later still needs its limit; D43 names `/api/v1`, `/mcp` and `contract.report`, not webhooks.
- **Packet operations that carry a contract section.** The packet's text caps are in characters and the limit counts bytes, so a contract-change packet at every cap passes 2 MiB with multi-byte text (Risks). Whether packet operations that carry a contract section get 16 MiB, or the packet's text caps are counted in bytes, is open; D43 gives them 2 MiB.
- **The contract Action on a 413.** The Action fails open on any error, so a report over 16 MiB costs no PR check, but the PR author learns nothing. Whether the Action should annotate a 413 as it annotates `upgrade-required` is open; nothing here changes the Action.
- **A setting.** D43 fixes the limits. Whether an operator may raise or lower them in `.env` is open, and no `.env` key is added.

## Readings to confirm with the founder

No decision settles the points below. The specs apply the narrowest reading of each, and each can change in review without changing the approach.

- **R1. Which other routes get the 2 MiB limit** (D43). Reading: D43 names `/api/v1` and `/mcp`, and the maintainer's request for this change adds the web UI's own forms. One HTTP layer serves the whole install, so the guard applies 2 MiB to every request except the `contract.report` path (16 MiB) and the webhook paths: 25 MiB for `/webhooks/github` (`github-layer-hardening`, D50 (19)), and the Jira webhook's limit, which is open (Open Questions). So the forms of `/setup`, the review pages under `/confirm/…`, the consent and device approval pages, and the sign-in service's own routes get 2 MiB as well; none of them takes a body near it. Specs: public-api.
- **R2. The limit is inclusive and a MiB is 1,048,576 bytes** (D43). Reading: a body of exactly 2,097,152 bytes, or 16,777,216 for `contract.report`, is not refused for its size; one byte more is. Specs: public-api.
- **R3. Never reading the rest of the body** (D43). Reading: the answer carries `Connection: close` and the connection is closed once it has been sent; a request that declares a length above the limit is refused before any byte of its body is read. Specs: public-api.
- **R4. "A 10 MiB `contract.report` succeeds"** (D43). Reading: a 10 MiB report is not refused for its size and reaches the operation's input validation; whether it then succeeds depends on its content, because the caps of the packet's contract section keep a valid report below 2 MiB in ASCII, and the 16 MiB limit leaves room for multi-byte text. Specs: public-api, contract-changes.

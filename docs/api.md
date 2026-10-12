# The API

Every install serves a REST API under `/api/v1`, for the tools and services a company builds on Tiehall. It runs the same operations, with the same rules, as the MCP tools and the `tiehall` CLI, because all three come from one definition of each operation. Every install describes it in an OpenAPI 3.1 document at `/api/v1/openapi.json`, which anyone may read without signing in and which holds nothing of the install's data, and renders that document at `/docs/api`, a reference page that needs no sign-in and loads nothing from other hosts. This repository holds the document as [`openapi/v1.json`](../openapi/v1.json). The API is beta: this page says what that promises, how changes are announced, and how the API refuses a call.

## Calling the API

- **Credentials.** Send a token in the `Authorization` header, as `Authorization: Bearer <token>`: an OAuth access token that an agent client or the CLI got by signing in, or a personal access token, which starts with `th_pat_`, as [Agents and Tiehall](agents.md) describes. A token anywhere else, such as the query string, is ignored. Each operation lists, under `security`, the scopes its token needs: `requests:read`, `requests:write` or `contracts:report`. The one exception is `contract.report`, which only a CI run calls, with a GitHub Actions OIDC token whose audience is the install's URL.
- **The major version is in the path.** Every operation lives under `/api/v1/`, and each operation's `operationId`, such as `requests.create`, is its id everywhere.
- **Commitments answer 202.** An operation that is a commitment, such as setting a due date or declining a request, applies nothing: it answers `202 Accepted` with the proposal it made, which states the confirmations it needs and has and when it expires. People confirm it in the web UI; the answer never holds the URL where they do.
- **Packet revisions use `ETag` and `If-Match`.** Reading a request's packet gives the current revision's `ETag`. Adding a revision needs `If-Match` with that value: without it the answer is 428, and with a value that is no longer current, 412, and nothing is added.
- **Bodies have a size limit:** 2 MiB, or 16 MiB for `contract.report`. A larger body is refused with 413 before it is read. Each of the install's web processes also receives at most 64 MiB of bodies at once, counting the bytes of each body as they arrive: a body whose bytes do not fit is refused with 503 `busy` and `Retry-After` and read no further, nothing runs, and the same call succeeds once you retry after that time.
- **The CLI states its version** in the `Tiehall-CLI-Version` header, and an install refuses a CLI older than the oldest it supports with `upgrade-required`, which says how to upgrade. `contract.report` keeps a floor of its own, because companies' CI runs a pinned CLI, and that floor rises only with at least 180 days' notice in the changelog.

## Stability levels

Each operation carries one stability level in the document, as `x-stability-level`, and each MCP tool states its operation's level in its `_meta`, under `com.tiehall/stability`:

- `alpha` is only for work between releases. A published release offers no operation or tool at `alpha`, and the release check refuses a release that does. An `alpha` operation is held to no notice rule.
- `beta` operations change only with the notice the next section describes.
- `stable` operations only gain fields and options; a breaking change to one goes to a new major version.

`contract.report`, and the GitHub Actions OIDC path it takes, are `stable` from the first release, because pinned Actions in companies' repositories call them. Every other operation, and every MCP tool, is `beta`. An operation becomes `stable` on its own, once no breaking change to it was needed for four weeks and the maintainers have decided to graduate it, a decision the changelog records. Installs send no usage data, so no usage count plays a part.

## The notice rules

- Responses can gain fields at any time: no response schema sets `additionalProperties: false`, so adding an optional field to a response breaks no client, and clients should ignore fields they do not know.
- A `beta` operation changes in three steps: the new shape is added; the old one is marked `deprecated: true` with an `x-sunset` date at least 14 days later; and the old one is removed on or after that date.
- A `stable` operation gets at least 180 days between its deprecation and its removal. A breaking change to it is made under `/api/v2`, and `/api/v1` keeps serving it next to the new one for at least six months.
- While the API is beta, the document's `info.version` has the form `0.N.0`, and every release with a breaking change raises it.
- MCP tools follow the rules of their operation: a `beta` tool is removed, or gains a required argument, only after the same notice, and a breaking change to a `stable` tool ships under a new tool name, while the old tool keeps working for at least six months; the name of a `stable` tool is never given to a tool that breaks it.
- CI holds every pull request to these rules: it compares the document and the tool list with those at the pull request's merge base, and fails on a breaking change that skips a step or a sunset closer than the notice period.
- The one exception is an urgent security fix that cannot wait for its notice. Its pull request carries the `api-breaking` label, adds a changelog entry for the break and raises `info.version`, so the break is announced where every other change is.

## Deprecation headers

Every answer of a deprecated operation carries the `Deprecation` header (RFC 9745), with the day its deprecation was released, as `@` and the seconds since the epoch, and, once it has a sunset date, the `Sunset` header (RFC 8594), with the start of that day as an HTTP date, such as `Sunset: Tue, 15 Dec 2026 00:00:00 GMT`. Both come from the same record as the document's `deprecated: true` and `x-sunset`, so a client that watches for either header learns of a deprecation without reading the changelog.

## The changelog

Each install serves the API's changelog at `/docs/api/changelog`, which needs no sign-in. It lists the changes of every release up to the one it runs, from the pinned diff engine's changelog of the document between releases, and the maintainers' entries, such as a deprecation, a graduation or an urgent break. Each release's notes carry the same entries. A release candidate gets no entries of its own: its changes are listed under the release it leads to, and an install that runs a candidate lists the entries waiting for that release as not released yet. This is the notice: Tiehall sends no email about API changes to anyone who holds a token. Read the changelog before you upgrade a client, and the release notes before you upgrade an install. This repository keeps it as [`openapi/changelog.json`](../openapi/changelog.json).

## Idempotency

Every POST operation takes an optional `Idempotency-Key` header, as the IETF draft draft-ietf-httpapi-idempotency-key-header describes, so that a client can retry a call after a timeout without doing it twice. Tiehall keeps each key for 24 hours, per caller, with the first call's answer:

- A repeat with the same key and the same body gets the first call's status and body, and nothing runs again.
- A repeat with the same key and a different body is refused with 422, and does not run.
- The same key from two different callers is two keys.
- A call that was refused keeps no key, so it can be sent again once fixed.

The CLI's commands that post take `--idempotency-key`.

## The error model

When Tiehall refuses a call for one of its own reasons, it answers with an RFC 9457 problem details object, as `application/problem+json`, on every HTTP endpoint it serves: the REST API, `/mcp`, request URLs, the web UI's routes and the sign-in service's. The problem holds:

- `type`, a URI under `https://tiehall.com/problems/` that ends in the reason's name, such as `https://tiehall.com/problems/needs-human`. It names the kind of refusal and is the same on every install; no install fetches it, and it need not resolve.
- `title`, the same for every refusal of the kind, `status`, and `detail`, which says why in Tiehall's own words.
- `errors`, for input that fails the schema: each place it fails, by its path and what is wrong, never the value itself, at most 100 of them.
- `retryAfter`, with the `Retry-After` header, when waiting helps.

The MCP tools refuse in the same cases, with a tool error: a tool result with `isError` set, whose content is the same problem. Five refusals on `/mcp` are HTTP statuses instead: a refused request state of a retried call, a missing, invalid or insufficient token, a body over the size limit, a body refused as `busy`, and a request whose `Origin` header names another origin than the install's, which gets 403 `forbidden` before its token is checked. A browser that calls a page of the web UI gets a page that says the same. When more than one reason applies, a body over the limit is refused first, then a body refused as `busy`, a path that serves no operation answers 404 whoever calls it, and a removed member gets 403 before any record is looked up, so they never learn whether one exists.

| Problem type | Status | When |
| --- | --- | --- |
| `route-not-found` | 404 | No such route, or an operation this surface does not offer, such as an internal operation's path under `/api/v1`. |
| `record-not-found` | 404 | The request, team, proposal or GitHub account the path or the input names does not exist. |
| `setup-required` | 503 | The install's setup is not complete. |
| `shutting-down` | 503 | The app is shutting down, for example for an upgrade; it carries `Retry-After: 0`. |
| `busy` | 503 | The web process is already receiving as many request bodies as it holds at once, 64 MiB, and this body's bytes would not fit as they arrived; it was read no further and nothing ran, and it carries `Retry-After: 5`. |
| `invalid-input` | 400 | The input fails the operation's input schema. |
| `outside-settings` | 400 | A value is outside what the install's settings allow, such as a token lifetime above the admin's maximum. |
| `upgrade-required` | 400 | The CLI is older than the oldest version the install supports. |
| `forbidden` | 403 | The caller's role, or their part in the request, does not allow the action. |
| `sign-in-refused` | 403 | A GitHub account may not sign in under the install's sign-in rules. |
| `personal-access-tokens-off` | 403 | An admin has switched personal access tokens off. |
| `confirmation-required` | 403 | An action that needs the confirmation step came without a valid confirmation. |
| `removed-member` | 403 | The caller has been removed from the install. |
| `request-state-refused` | 403 | A retried MCP call carries a request state that is not its own, was changed or has expired. |
| `invalid-token` | 401 | The bearer token is not valid, such as an expired token or a CI token used twice; it carries a `WWW-Authenticate` challenge. |
| `ci-caller-refused` | 403 | A CI run calls anything but `contract.report`, or reports for an API that is not registered to its repository or workflow. |
| `needs-human` | 409 | An agent writes to a request flagged `needs_human`, which waits for a person. |
| `conflict` | 409 | The state does not allow the action, such as claiming a claimed request or confirming a proposal that has ended. |
| `payload-too-large` | 413 | The body is larger than the size limit, which the detail names. |
| `if-match-required` | 428 | A packet revision came without `If-Match`. |
| `rate-limited` | 429 | A write limit, a budget or a request cap is exceeded; it carries `Retry-After`. |
| `integration-unavailable` | 502 | GitHub or the Jira site failed a call the action needs, or did not answer within 10 seconds; nothing changed. |
| `unauthenticated` | 401 | The call needs a token and has none; the `WWW-Authenticate` challenge points to the install's metadata. |
| `insufficient-scope` | 403 | The token lacks a scope the operation needs. |
| `precondition-failed` | 412 | The `If-Match` value is not the current revision's `ETag`. |
| `idempotency-key-reused` | 422 | An `Idempotency-Key` came again with a different body. |

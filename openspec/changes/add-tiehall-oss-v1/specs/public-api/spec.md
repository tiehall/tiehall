# Spec Delta: public-api

## Purpose

The public API lets companies and their tools build on their Tiehall install. It is a documented REST API under `/api/v1`, described by an OpenAPI 3.1 document generated from the same operation definitions as the MCP tools and the CLI, and served by every install. It carries one error model, per-operation stability levels, enforced notice before breaking changes and a changelog, and its client pieces are Apache-2.0 and published from public source.

## ADDED Requirements

### Requirement: One definition per operation, the same on every surface

Each Tiehall domain operation SHALL have one id (for example `requests.create`), one input schema, one output schema and one set of required scopes, drawn from the three OAuth scopes that the agent-access capability defines (`requests:read`, `requests:write` and `contracts:report`), and SHALL behave the same on every surface that offers it: REST under `/api/v1`, the MCP tools and the CLI. It SHALL accept the same inputs, apply the same authorization and return the same output on each of them, and the OpenAPI document SHALL describe it from the same definition. The web UI SHALL apply the same authorization as every other surface. The CLI SHALL call the REST API. The `.json` variant of a request URL, which the agent-surfaces capability defines, SHALL return exactly the body of the matching `/api/v1` read. The sign-in service's own routes are not domain operations and are outside this rule; the agent-safety capability guards them.

Source: D19; D28 #48; design.md, Decisions this change rests on; design.md, Design rules: Public API

#### Scenario: REST and MCP apply the same rules

- **WHEN** the same invalid input is sent to an operation through `/api/v1` and through its MCP tool
- **THEN** both surfaces refuse it by the same validation rules
- **AND** the `/api/v1` call answers 400 with an RFC 9457 problem
- **AND** neither surface changes anything

#### Scenario: The web UI has no extra rights

- **WHEN** a member's web session runs an operation that the member's part in the request does not allow, such as declining a request addressed to another team
- **THEN** it is refused exactly as the same operation over `/api/v1` is refused for that member
- **AND** the `/api/v1` call answers 403 with an RFC 9457 problem

#### Scenario: The negotiated JSON matches the API

- **WHEN** a client reads `https://tiehall.example.com/FE-142.json` and the matching `/api/v1` read of FE-142 with the same credentials
- **THEN** both bodies are identical

### Requirement: Operations not offered on REST answer 404

An operation that is not offered on the REST surface SHALL answer 404 at its `/api/v1` path, as the error model's row for an operation a surface does not offer defines, and SHALL NOT run. Which callers can run operations that no agent surface offers is defined by the agent-access capability, and the actions that run only in the web UI by the agent-safety capability.

Source: D28 #48; design.md, Decisions this change rests on; design.md, Design rules: Public API

#### Scenario: A command without REST exposure is not found

- **WHEN** a client with a valid token calls the `/api/v1` path of a command that is not offered on REST
- **THEN** the API answers 404
- **AND** the command does not run

### Requirement: Input and output follow the published schemas

Every call SHALL be validated against the operation's input schema before anything runs, and invalid input SHALL be refused with no change. Every successful response body SHALL conform to the operation's documented output schema.

Source: design.md, Design rules: Public API

#### Scenario: Invalid input changes nothing

- **WHEN** a client calls `requests.create` with a body that fails the input schema
- **THEN** the call is refused with 400 and an RFC 9457 problem
- **AND** no request is created and no event is appended

#### Scenario: Responses match the document

- **WHEN** the contract tests call each REST operation with valid input
- **THEN** every successful response body validates against that operation's response schema in the OpenAPI document

### Requirement: Commitments over the API answer 202 with a proposal

When a user caller calls an `/api/v1` operation that is a commitment under D23, the API SHALL NOT apply it. It SHALL create a proposal instead and answer 202 with a body that carries the proposal. The proposal, in the 202 body and wherever the API returns it, SHALL state the confirmations it needs and the ones it has received: the accountable human's, and, for a commitment that needs a confirmation from each side, the other side's, as the requests capability defines for cross-team commitments. It SHALL also state when it expires and, once it has ended without taking effect, how it ended, as the requests capability defines. The 202 body MUST NOT contain the proposal's confirm URL, or any other `/confirm/` URL, because agents that call the API with a personal access token read it. The commitment SHALL take effect only when the people the requests capability names have confirmed the proposal in the web UI, with the confirmation step that the agent-safety capability defines. The OpenAPI document SHALL describe the 202 answer for every commitment operation.

Source: D23; D28 #16, #36; D30; design.md, Decisions this change rests on; design.md, Design rules: Public API; design.md, Self-hosting decisions: S7

#### Scenario: A due date becomes a proposal

- **WHEN** a personal access token caller acting for Alice, the requester of FE-142, asks to set a due date on FE-142
- **THEN** the API answers 202 with a body that carries the new proposal
- **AND** the proposal states that it needs Alice's confirmation and then a confirmation from a member of FE-142's target team, and has neither yet
- **AND** it states when it expires, 7 days after it was created
- **AND** FE-142's due date is unchanged until both have confirmed the proposal

#### Scenario: A decline needs one confirmation

- **WHEN** a personal access token caller acting for Bob, a member of FE-142's target team, asks to decline FE-142
- **THEN** the API answers 202 with a body that carries the new proposal
- **AND** the proposal states that it needs only Bob's confirmation

#### Scenario: The 202 body holds no confirm URL

- **WHEN** an agent with a personal access token asks to set a due date on FE-142 and gets the 202 answer
- **THEN** no part of the response body holds a `/confirm/` URL

### Requirement: Every install serves the OpenAPI 3.1 document without authentication

Every install SHALL serve an OpenAPI 3.1 description of `/api/v1` at `/api/v1/openapi.json` without authentication. The document SHALL hold no data of the install, such as the company's name, its teams, users or requests, and SHALL be the same for every reader. It SHALL list every operation offered on REST.

Source: D19; design.md, Decisions this change rests on; design.md, Design rules: Public API

#### Scenario: Anyone can read the document

- **WHEN** a client without credentials requests `https://tiehall.example.com/api/v1/openapi.json`
- **THEN** the response is 200 with a JSON document whose `openapi` field is `3.1.0`
- **AND** the document contains no company name, team, user or request data of the install

### Requirement: What the document states for each operation

For each operation, the OpenAPI document SHALL state: an `operationId` equal to the command id; the scopes it needs, under `security`, each one of the three OAuth scopes that the agent-access capability defines; its stability level in `x-stability-level`; its errors as RFC 9457 problem details; the optional `Idempotency-Key` header on POST operations; `ETag` and `If-Match` on operations that read or add packet revisions, with `If-Match` marked required on operations that add a revision; and, for a commitment, its 202 answer carrying the proposal. A schema used in both requests and responses, such as the packet, SHALL keep one component id for both.

Source: D28 #20, #21, #48; design.md, Decisions this change rests on; design.md, Design rules: Public API; design.md, Design rules: Handoff packet

#### Scenario: An operation carries its id, scopes and level

- **WHEN** a reader looks up the operation for creating a request in the document
- **THEN** its `operationId` is `requests.create`
- **AND** it lists its scopes under `security` and carries an `x-stability-level`
- **AND** every scope it lists is one of `requests:read`, `requests:write` and `contracts:report`

#### Scenario: The document names no admin scope

- **WHEN** a reader lists every scope named anywhere in the document
- **THEN** each is one of `requests:read`, `requests:write` and `contracts:report`

#### Scenario: The document shows which headers are required

- **WHEN** a reader looks up the operation that adds a packet revision in the document
- **THEN** it lists `If-Match` as a required header
- **AND** it lists `Idempotency-Key` as an optional header

#### Scenario: The packet is one component

- **WHEN** the packet appears in a request body and in a response body
- **THEN** both refer to the same component id

### Requirement: Responses can gain fields without breaking clients

Response schemas in the OpenAPI document SHALL NOT set `additionalProperties: false`, so that adding a field to a response never breaks a strictly generated client. Adding an optional field to a response SHALL NOT count as a breaking change.

Source: design.md, Design rules: Public API

#### Scenario: A new response field is not breaking

- **WHEN** a pull request adds an optional field to a response of a `beta` operation
- **THEN** the compatibility check in CI passes
- **AND** a client generated from the previous document still accepts the new response

### Requirement: The API reference page at `/docs/api`

Every install SHALL render its OpenAPI document as a reference page at `/docs/api`, on the install's own origin. Anyone SHALL be able to read the page without signing in. The page SHALL load nothing from other hosts: its code SHALL come from the install itself, it SHALL load no third-party scripts or web fonts, and it SHALL send a strict Content-Security-Policy. The page SHALL NOT offer a panel for sending test requests.

Source: D28 #29; design.md, Decisions this change rests on; design.md, Design rules: Public API; design.md, Technical decisions: T10; design.md, Self-hosting decisions: S13

#### Scenario: Anyone can read the reference page

- **WHEN** a browser without a Tiehall session opens `https://tiehall.example.com/docs/api`
- **THEN** the reference page is shown with a 200 response
- **AND** the browser is not sent to sign in

#### Scenario: The reference page makes no requests to other hosts

- **WHEN** a browser opens `https://tiehall.example.com/docs/api`
- **THEN** the page loads no script, stylesheet, font or image from any host other than `tiehall.example.com`
- **AND** the response carries a Content-Security-Policy header

#### Scenario: No test-request panel

- **WHEN** a browser opens `/docs/api`
- **THEN** the page offers no control for sending a request or entering a token

### Requirement: Errors are RFC 9457 problem details

Every error response from an `/api/v1` operation SHALL be an RFC 9457 problem details object with the media type `application/problem+json`.

Source: D28 #1; design.md, Decisions this change rests on; design.md, Design rules: Public API

#### Scenario: A validation error is a problem

- **WHEN** a client sends a body that fails an operation's input schema
- **THEN** the response status is 400
- **AND** the response has the content type `application/problem+json`
- **AND** its body is a problem details object as RFC 9457 defines

### Requirement: One error model for Tiehall's own refusals

When Tiehall refuses a call for one of its own reasons, on an `/api/v1` operation or on any other HTTP endpoint it serves (`/mcp`, request URLs and intake pages, the web UI's routes, the sign-in service's routes, the consent and device approval pages, the review pages and confirmations of the confirmation step under `/confirm/…`, and `/setup`), it SHALL answer with the HTTP status that the table below gives for that reason, as an RFC 9457 problem details object, and with the problem type the table names where it names one. This table is the error model that the other capabilities refer to for the status of their refusals. The MCP tools SHALL refuse in the same cases and report each refusal as a tool error: a tool result with `isError` set to true, whose content names the problem type of the matching row. Wherever another capability speaks of a tool error, a validation error or a conflict error on the MCP tools, it means such a result. Two kinds of refusal on `/mcp` SHALL instead be HTTP statuses, not tool errors: a refused request state, as the row below and the agent-surfaces capability define, and the OAuth refusals of a missing, invalid or insufficient token. The CLI, which calls the REST API, SHALL show the problem it gets.

| Reason for the refusal | Status |
| --- | --- |
| No such route, or an operation that this surface does not offer, such as an operation not offered on REST, a closed route of the sign-in service, or `/setup` once setup is complete | 404 |
| The record that the path or the input names does not exist, such as a request key, a team key, a proposal id or a GitHub username that names no account | 404 |
| Setup is not complete, as the self-host-install capability defines (pages redirect to `/setup` instead) | 503, with the problem type `setup-required` |
| The app is shutting down, for example for an upgrade | 503, with `Retry-After: 0` |
| The input fails the operation's input schema | 400 |
| A value is outside what the install's settings allow, such as a personal access token lifetime above the admin's maximum | 400 |
| The CLI is older than its minimum supported version | 400, with the problem type `upgrade-required` |
| The caller may not take the action: their role in the install, or their part in the request or record (such as the requester side, the target team, the claimant, the accountable human, the other side of a cross-team commitment or the proposer), does not allow it | 403 |
| A GitHub account may not sign in under the install's sign-in rules, as the sign-in capability defines, including a sign-in whose only way in is an invite that has expired or been revoked | 403 |
| The admin has switched personal access tokens off | 403 |
| A confirmation that the action needs, as the agent-safety capability defines, is missing or invalid: no nonce, or one that is used, expired, or bound to another user, session or input, or a failed CSRF, `Origin` or `Sec-Fetch-Site` check | 403 |
| The caller has been removed from the install | 403 |
| A retried MCP call carries a request state that was bound to another user, client or proposal, was changed, or has expired | 403 |
| A CI caller presents a GitHub Actions OIDC token whose `jti` Tiehall has already seen (a replayed CI token) | 401, with the error `invalid_token`, as for any other invalid bearer token |
| A CI caller calls an operation other than `contract.report`, or reports for an API that is not registered to its repository or, for an API bound to a workflow, not from that workflow | 403 |
| An agent write to a request flagged `needs_human`, as the agent-safety capability defines | 409, with the problem type `needs-human` |
| Any other state conflict, including a confirmation or rejection of a proposal that has ended, the other side's confirmation or rejection of a cross-team commitment before the accountable human has confirmed it, an expired device code on the device approval page, and a role change or removal that would leave the install without an admin | 409 |
| A packet revision is sent without `If-Match` | 428 |
| A write limit, a budget or a request cap is exceeded | 429, with a `Retry-After` header |

Refusals whose status a protocol sets keep that status: the OAuth errors that the agent-access capability defines, such as 401 with `invalid_token`, 403 with `insufficient_scope`, and `unauthorized_client`; 412 for an `If-Match` that does not match the current revision; and 422 for an `Idempotency-Key` reused with a different body. An install holds one org, so no refusal hides another org's data behind a 404: a caller who has been removed from the install gets 403 on every surface, as the teams-and-roles capability defines for a removed member. When more than one row applies, a path that serves no operation on the surface SHALL answer 404 whoever calls it, and a removed member's call SHALL get 403 before any record is looked up, so it never learns whether a record exists.

Source: D28 #1; D29 (7); D30; design.md, Decisions this change rests on; design.md, Technical decisions: T7; design.md, Technical decisions: T9; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S6; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S12

#### Scenario: A refusal over MCP names its problem type

- **WHEN** an agent calls `post_message` over MCP with kind answer and no question id
- **THEN** the tool result has `isError` set to true
- **AND** its content names the problem type for input that fails the schema

#### Scenario: A part in the request that does not allow the operation

- **WHEN** Alice, who is not a member of FE-142's target team, asks through `/api/v1` to claim FE-142
- **THEN** the API answers 403 with an RFC 9457 problem
- **AND** FE-142 stays unclaimed

#### Scenario: Before setup is complete

- **WHEN** the setup screen has not been completed and a client calls an operation under `/api/v1`
- **THEN** the API answers 503 with an RFC 9457 problem whose problem type is `setup-required`

#### Scenario: A GitHub account that may not sign in

- **WHEN** a GitHub account that is not a member of a GitHub organization with a connected installation, holds no valid invite and is not a member of the install finishes GitHub's authorization
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** no session is created

#### Scenario: A missing confirmation

- **WHEN** Pia, an admin, sends the web UI's request that changes Lee's role with their session and CSRF token but without a confirmation nonce
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** Lee's role is unchanged

#### Scenario: The same refusal outside /api/v1

- **WHEN** Dana, whose role is `member`, submits the web UI's form that changes the sign-in policy
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** the sign-in policy is unchanged

#### Scenario: A record that does not exist

- **WHEN** a member's agent reads the request `FE-9999` through `/api/v1`, and team FE has no request with that number
- **THEN** the API answers 404 with an RFC 9457 problem

#### Scenario: A removed member does not learn whether a record exists

- **WHEN** Dana has been removed from the install and their agent reads `FE-9999`, which does not exist, through `/api/v1` with a token that has not expired
- **THEN** the API answers 403 with an RFC 9457 problem

#### Scenario: A CI caller on a path that serves no operation

- **WHEN** a caller authenticated with a GitHub Actions OIDC token calls the `/api/v1` path of an internal command, which is not offered on REST
- **THEN** the API answers 404

#### Scenario: A refused request state is an HTTP status on /mcp

- **WHEN** an MCP client retries a tool call with a `requestState` whose content was changed after Tiehall signed it
- **THEN** the HTTP answer's status is 403
- **AND** it is not a tool result with `isError` inside an HTTP 200 answer

#### Scenario: A CI caller outside `contract.report`

- **WHEN** a caller authenticated with a GitHub Actions OIDC token calls `requests.create` through `/api/v1`
- **THEN** the API answers 403 with an RFC 9457 problem

#### Scenario: A replayed CI token

- **WHEN** the contract Action calls `contract.report` with a GitHub Actions OIDC token whose `jti` Tiehall already saw on an earlier accepted report
- **THEN** the API answers 401 with the error `invalid_token`
- **AND** the report is not taken

#### Scenario: The last admin cannot step down

- **WHEN** Pia is the install's only admin and Pia confirms their own change of role to `member`
- **THEN** Tiehall answers 409 with an RFC 9457 problem
- **AND** Pia stays an admin

#### Scenario: A write to a request that needs a human

- **WHEN** FE-142 is flagged `needs_human` and an agent posts a message on it through `/api/v1`
- **THEN** the API answers 409 with an RFC 9457 problem whose problem type is `needs-human`
- **AND** the message is not added

#### Scenario: Other conflicts do not name needs-human

- **WHEN** FE-142 is `claimed` and not flagged, and an agent acting for a member of its target team asks through `/api/v1` to claim it
- **THEN** the API answers 409 with an RFC 9457 problem
- **AND** its problem type is not `needs-human`

#### Scenario: A limit is exceeded

- **WHEN** an agent's write through `/api/v1` exceeds a write limit
- **THEN** the API answers 429 with an RFC 9457 problem
- **AND** the response carries a `Retry-After` header

#### Scenario: A call while the app shuts down

- **WHEN** an upgrade is stopping the app and a client calls `requests.create` through `/api/v1`
- **THEN** the API answers 503 with `Retry-After: 0`
- **AND** no request is created

### Requirement: POST operations take an Idempotency-Key

Every POST operation under `/api/v1`, including those that open requests and add messages, packet revisions, links and proposals, SHALL accept an `Idempotency-Key` header, following the IETF draft draft-ietf-httpapi-idempotency-key-header. The header SHALL be optional. Tiehall SHALL keep each key for 24 hours, per caller. A POST repeated with the same key and body within that time SHALL NOT perform the operation a second time and SHALL get the first call's response. A POST that reuses a kept key with a different body SHALL be answered 422 and SHALL NOT run.

Source: D28 #20; design.md, Decisions this change rests on; design.md, Design rules: Public API

#### Scenario: A retried create makes one request

- **WHEN** a client sends the same `requests.create` call twice with the same `Idempotency-Key`, for example after a network timeout
- **THEN** exactly one request exists afterwards
- **AND** the second call gets the same status and body as the first

#### Scenario: A retried message is posted once

- **WHEN** a client posts a message on FE-142 twice with the same `Idempotency-Key`
- **THEN** the thread of FE-142 holds that message once

#### Scenario: A POST without the header runs

- **WHEN** a client posts a message on FE-142 without an `Idempotency-Key` header
- **THEN** the message is added

#### Scenario: A reused key with a different body

- **WHEN** a client sends `requests.create` with an `Idempotency-Key` and, an hour later, sends `requests.create` with the same key and a different body
- **THEN** the second call is answered 422 with an RFC 9457 problem
- **AND** no second request is created

#### Scenario: Keys are kept per caller

- **WHEN** two different callers each send `requests.create` with the same `Idempotency-Key` value
- **THEN** both calls run and two requests exist afterwards

#### Scenario: A key is kept for 24 hours

- **WHEN** a client repeats a `requests.create` call with the same `Idempotency-Key` and body 23 hours after the first
- **THEN** no second request is created

### Requirement: Packet revisions use ETag and If-Match

Reading a packet SHALL return an `ETag` for its current revision. An operation that adds a packet revision SHALL require `If-Match`: a call without it SHALL be answered `428 Precondition Required` and SHALL NOT add a revision. When the `If-Match` value does not match the current revision's `ETag`, the API SHALL answer `412 Precondition Failed` and SHALL NOT add a revision. The handoff-packet capability defines the revisions themselves.

Source: D28 #21; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet; design.md, Design rules: Public API

#### Scenario: A stale revision is refused

- **WHEN** two agents read FE-142's packet at revision 3, the first adds revision 4, and the second then sends a new revision with `If-Match` set to revision 3's `ETag`
- **THEN** the API answers 412
- **AND** the packet stays at revision 4

#### Scenario: A revision without If-Match is refused

- **WHEN** an agent sends a new revision of FE-142's packet, which is at revision 3, without an `If-Match` header
- **THEN** the API answers 428 with an RFC 9457 problem
- **AND** the packet stays at revision 3

### Requirement: The major version is in the path

The API's major version SHALL be part of the path. The first API SHALL live under `/api/v1`.

Source: design.md, Design rules: Public API

#### Scenario: Operations live under /api/v1

- **WHEN** a client calls any operation described in the OpenAPI document
- **THEN** the operation's URL path starts with `/api/v1/`

### Requirement: Each operation carries a stability level

Every operation SHALL carry one stability level in `x-stability-level`: `alpha`, `beta` or `stable`. `contract.report` and the CI OIDC path SHALL be `stable` from their first release, because pinned Actions in companies' repositories call them. Every other operation SHALL NOT be `stable` until it passes the graduation test that this capability defines. `alpha` SHALL be used only for work between releases: a published release SHALL offer no operation or MCP tool at `alpha`, so that every operation a company can call on a released install is at least `beta` and is held to the notice rules. An `alpha` operation SHALL NOT be held to the notice rules. MCP tools SHALL follow the stability level of their operation, and each tool SHALL state that level in its `_meta`, as the agent-surfaces capability defines.

Source: D19; D28 #65; design.md, Decisions this change rests on; design.md, Design rules: Public API; design.md, Technical decisions: T13

#### Scenario: Levels in the first release

- **WHEN** a reader reads the OpenAPI document served by an install on the first release
- **THEN** every operation has an `x-stability-level`
- **AND** `contract.report` is `stable`
- **AND** `requests.create` is not `stable`

#### Scenario: A release offers nothing at alpha

- **WHEN** a reader reads the OpenAPI document and the MCP tool list of any published release
- **THEN** no operation and no tool is marked `alpha`

#### Scenario: A release with an alpha operation is not published

- **WHEN** the release job runs on a version tag whose OpenAPI document marks an operation `alpha`
- **THEN** the release job fails and nothing is published

#### Scenario: Alpha operations are not held to notice

- **WHEN** a pull request makes a breaking change to an `alpha` operation
- **THEN** the compatibility check in CI does not fail because of it

### Requirement: Notice before a breaking change is enforced in CI

A `beta` operation SHALL change in three steps: add the new shape; mark the old one `deprecated: true` with an `x-sunset` date at least 14 days after the change; then remove it on or after that date. A `stable` operation SHALL get at least 180 days between deprecation and removal. On every pull request, CI SHALL compare the OpenAPI document at the pull request's merge base with the pull request's version and SHALL fail on an error-level breaking change to a `beta` or `stable` operation, including a sunset date closer than that operation's notice period and a removal before the sunset date.

Source: design.md, Design rules: Public API

#### Scenario: A short sunset fails CI

- **WHEN** a pull request marks a `beta` operation `deprecated: true` with an `x-sunset` date 10 days after the change
- **THEN** CI fails

#### Scenario: An early removal fails CI

- **WHEN** a pull request removes a deprecated `beta` operation before its `x-sunset` date
- **THEN** CI fails

#### Scenario: A stable operation needs 180 days

- **WHEN** a pull request deprecates a `stable` operation with an `x-sunset` date 30 days after the change
- **THEN** CI fails

#### Scenario: A removal after the sunset passes

- **WHEN** a pull request removes a deprecated `beta` operation after its `x-sunset` date has passed
- **THEN** the compatibility check does not fail because of the removal

### Requirement: The `api-breaking` label for urgent security fixes

A breaking change to a `beta` or `stable` operation before its notice has run SHALL be allowed only for a security fix that cannot wait. Such a pull request SHALL carry the `api-breaking` label and SHALL add a changelog entry. Before the packet schema is published, breaking packet changes also use the label, as the handoff-packet capability defines.

Source: design.md, Design rules: Public API; design.md, Design rules: Handoff packet

#### Scenario: An urgent security fix is announced

- **WHEN** a security fix must remove a field from a `beta` operation's input at once
- **THEN** the pull request carries the `api-breaking` label and adds a changelog entry
- **AND** the change is listed on the changelog page of an install running the release that carries it

### Requirement: The API version number while the API is beta

While the API is beta, the document's `info.version` SHALL have the form `0.N.0`, so that the compatibility check can require a version bump. CI SHALL fail a pull request that carries a breaking change while leaving `info.version` unchanged.

Source: D28 #27; design.md, Decisions this change rests on

#### Scenario: The beta version has the form 0.N.0

- **WHEN** a reader reads `info.version` in the OpenAPI document while the API is beta
- **THEN** it has the form `0.N.0`, for example `0.4.0`

#### Scenario: A breaking change without a version bump fails

- **WHEN** a pull request carrying the `api-breaking` label makes a breaking change and leaves `info.version` unchanged
- **THEN** CI fails

### Requirement: Deprecated operations send Deprecation and Sunset headers

Every response from a deprecated operation SHALL carry the `Deprecation` header (RFC 9745) and, where the operation has a sunset date, the `Sunset` header (RFC 8594). Both SHALL come from the same deprecation metadata as the OpenAPI document.

Source: design.md, Design rules: Public API

#### Scenario: A deprecated operation announces its sunset

- **WHEN** a client calls a `beta` operation that is marked deprecated with an `x-sunset` date of 2026-12-15
- **THEN** the response carries a `Deprecation` header
- **AND** it carries a `Sunset` header for 2026-12-15

### Requirement: The changelog page and the release notes

Every install SHALL serve an API changelog page at `/docs/api/changelog`, generated from the compatibility checker's changelog output and listing the API changes of every release up to the one it runs. Each release's notes SHALL carry the same entries. Tiehall SHALL NOT email token holders about API changes.

Source: D28 #28; design.md, Decisions this change rests on; design.md, Design rules: Public API

#### Scenario: A deprecation reaches the changelog and the release notes

- **WHEN** a release deprecates a `beta` operation with an `x-sunset` date
- **THEN** the changelog page at `/docs/api/changelog` of an install running that release lists the deprecation and its sunset date
- **AND** the release's notes carry the same entry
- **AND** no holder of a personal access token or an OAuth grant receives an email about it

#### Scenario: An additive change is listed too

- **WHEN** a release adds an optional field to a response of a `beta` operation
- **THEN** the changelog page at `/docs/api/changelog` of an install running that release lists the change

### Requirement: Each operation graduates on its own

An operation SHALL NOT carry `x-stability-level: stable` unless it has passed the graduation test: no breaking change to it was needed for four weeks, and the maintainers have decided to graduate it and recorded that decision in the changelog. There SHALL be no usage count in the test, because installs send no usage data. `contract.report` and the CI OIDC path, which are `stable` from the start, are the exception.

Source: design.md, Design rules: Public API; design.md, Self-hosting decisions: S13

#### Scenario: Four quiet weeks alone do not graduate an operation

- **WHEN** a `beta` operation has had no breaking change for four weeks and the maintainers have recorded no decision about it
- **THEN** the OpenAPI document still marks it `beta`

#### Scenario: A recent breaking change keeps an operation in beta

- **WHEN** the maintainers want to graduate a `beta` operation, but a breaking change to it was released two weeks ago
- **THEN** the OpenAPI document does not mark it `stable`

#### Scenario: A graduation is recorded

- **WHEN** a `beta` operation has had no breaking change for four weeks and a release marks it `stable`
- **THEN** that release's changelog records the maintainers' decision to graduate it

### Requirement: After graduation, breaking changes go to a new major version

Once an operation is `stable`, it SHALL only gain fields and options. A breaking change to it SHALL be made under `/api/v2`, and `/api/v1` SHALL keep serving the old operation next to it for at least six months.

Source: design.md, Design rules: Public API

#### Scenario: v1 keeps working after v2 arrives

- **WHEN** a breaking change to a `stable` operation is released under `/api/v2`
- **THEN** the same operation under `/api/v1` keeps answering as before in every release for at least six months after that release

### Requirement: MCP tools follow the same compatibility rules

MCP tools SHALL follow the stability level and notice rules of their operation: while the operation is `beta`, removing a tool or adding a required argument SHALL follow the same notice as the operation. Once the operation is `stable`, its tool SHALL only gain things; a breaking change SHALL get a new tool name, and the old tool SHALL stay for at least six months. A snapshot of the tool names, descriptions, input schemas and output schemas SHALL be compared on every pull request.

Source: design.md, Design rules: Public API

#### Scenario: The snapshot shows a removed tool

- **WHEN** a pull request removes an MCP tool or adds a required argument to one
- **THEN** the snapshot comparison reports the change in that pull request

#### Scenario: A breaking change to a stable tool gets a new name

- **WHEN** a tool whose operation is `stable` needs a breaking change to its arguments
- **THEN** the new behavior ships under a new tool name
- **AND** the old tool keeps working for at least six months

### Requirement: The CLI sends its version and the server keeps a minimum

The CLI SHALL send its version with every call. The server SHALL keep a minimum supported CLI version and SHALL answer a call from an older CLI with 400 and an RFC 9457 problem of the type `upgrade-required` that says how to upgrade, without running the operation.

Source: D28 #1; design.md, Decisions this change rests on; design.md, Design rules: Public API

#### Scenario: An old CLI is told to upgrade

- **WHEN** a CLI older than the minimum supported version runs `tiehall inbox`
- **THEN** the server answers 400 with a problem of the type `upgrade-required` that says how to upgrade
- **AND** the operation does not run

### Requirement: `contract.report` has its own version floor

`contract.report` SHALL have its own minimum CLI version, separate from the general minimum, because companies' CI runs a pinned CLI. That floor SHALL be raised only with at least 180 days' notice in the changelog. A CLI older than that floor SHALL get the same `upgrade-required` answer as any other old CLI. How the contract Action handles an `upgrade-required` answer is defined by the contract-changes capability.

Source: design.md, Design rules: Public API

#### Scenario: A pinned CI CLI keeps reporting

- **WHEN** a CLI that is older than the general minimum but not older than the `contract.report` floor calls `contract.report` from a company's CI
- **THEN** the report is accepted

#### Scenario: A CI CLI below the floor is told to upgrade

- **WHEN** a CLI older than the `contract.report` floor calls `contract.report` from a company's CI
- **THEN** the server answers 400 with a problem of the type `upgrade-required`
- **AND** the report is not recorded

### Requirement: Every API change is reviewed as a document diff

On every pull request, CI SHALL regenerate the OpenAPI document from the operation definitions and SHALL fail when it differs from the committed document, so that every API change shows up as a reviewed diff before it is released.

Source: design.md, Design rules: Public API

#### Scenario: An unregenerated change fails

- **WHEN** a pull request changes an operation's input schema without updating the committed OpenAPI document
- **THEN** CI fails

### Requirement: The client package `@tiehall/client`

`@tiehall/client` SHALL be generated from the OpenAPI document, and the CLI SHALL use it. It SHALL NOT be published to npm before someone has asked to build on the API; when it is published, it SHALL be at version 0.x, labeled beta, and licensed under Apache-2.0.

Source: D34; design.md, Decisions this change rests on; design.md, Design rules: Public API

#### Scenario: The published client matches the API

- **WHEN** `@tiehall/client` is published to npm
- **THEN** its version is 0.x, it is labeled beta and its license is Apache-2.0
- **AND** it was generated from the OpenAPI document of the release it targets

### Requirement: Client pieces are built from public source with provenance

The client pieces, the `tiehall` CLI, `@tiehall/client`, the Claude Code plugin with its skill and the contract Action, SHALL be built from this public repository; `@tiehall/packet` follows the same rule, as the handoff-packet capability defines. The npm packages SHALL be published only from CI, with npm trusted publishing and provenance, and never from a laptop. The only exception SHALL be one placeholder publish per package name that reserves the `tiehall` name and the `@tiehall` scope before trusted publishing can be set up.

Source: D28 #29; D34; D38; design.md, Decisions this change rests on; design.md, Design rules: Public API

#### Scenario: A published version carries provenance

- **WHEN** a version of the `tiehall` CLI or of `@tiehall/client` after the placeholder is published to npm
- **THEN** npm shows provenance linking it to a CI build of this public repository

### Requirement: The license map

The server, meaning the web app, the worker and the code only they use, SHALL be licensed under AGPL-3.0, which SHALL be the repository's root license. The client pieces SHALL be licensed under Apache-2.0, each with its own license file and a matching license field in its package metadata, and SHALL be exactly these: the `tiehall` CLI, `@tiehall/client`, the Claude Code plugin with its skill, the contract Action, and the handoff-packet schema with its conformance fixtures and `@tiehall/packet`. Every other part of the repository, the command catalog included, is server code under AGPL-3.0. CI SHALL fail when a package's license does not match this map, and when an Apache-2.0 piece imports code that is licensed under AGPL-3.0. So the CLI SHALL take its request commands from the OpenAPI document, in which each operation that the CLI offers names its command, through `@tiehall/client`, and SHALL NOT import the catalog.

Source: D34; design.md, Decisions this change rests on; design.md, Technical decisions: T3; design.md, Technical decisions: T10; design.md, Self-hosting decisions: S16

#### Scenario: The CLI and the Action are Apache-2.0

- **WHEN** someone reads the license of the `tiehall` CLI package on npm or of the contract Action
- **THEN** it is Apache-2.0

#### Scenario: The server is AGPL-3.0

- **WHEN** someone reads the repository's root license
- **THEN** it is AGPL-3.0

#### Scenario: A license mismatch fails CI

- **WHEN** a pull request changes the license field of the `tiehall` CLI package to AGPL-3.0
- **THEN** CI fails

#### Scenario: An Apache-2.0 piece cannot import server code

- **WHEN** a pull request makes the `tiehall` CLI import a module of the server, such as the command catalog
- **THEN** CI fails

#### Scenario: The catalog is server code

- **WHEN** someone reads the license of the command catalog's package
- **THEN** it is AGPL-3.0

#### Scenario: The CLI's commands follow the document

- **WHEN** a release adds an operation offered on the CLI
- **THEN** the release's OpenAPI document names the operation's CLI command
- **AND** the `tiehall` CLI built for that release offers the command without importing the catalog

# Spec Delta: public-api

## Purpose

Adds the row for GitHub or the Jira site failing an action that needs it, has a browser get a refusal on the web UI's page routes as an HTML page, names the sign-in callback's rate limit among the 429 refusals, and gives a GitHub webhook delivery a body limit of 25 MiB. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Request bodies have a size limit

Every HTTP endpoint Tiehall serves under `/api/v1` and `/mcp`, except the `contract.report` operation, SHALL refuse a request body larger than 2 MiB (2,097,152 bytes); the `contract.report` operation SHALL refuse one larger than 16 MiB (16,777,216 bytes); both with 413 and the problem type `payload-too-large`, as the error model defines. A body of exactly the limit SHALL NOT be refused for its size. Tiehall SHALL refuse the body before it parses it, so a body over the limit SHALL run no operation, SHALL change nothing and SHALL append no event, whatever it holds. Because the body is refused before it is read, a body over the limit SHALL be answered 413 before any other refusal the call would get, including a missing token and setup that is not complete. The limit SHALL count the bytes received, not a length the request declares: a body sent in chunks without a declared length SHALL be limited too, and a request that declares a length above the limit SHALL be refused before any byte of its body is read. Once the limit is passed, Tiehall SHALL send the answer and SHALL NOT read the rest of the body. On `/mcp`, a body over the limit SHALL be refused with the HTTP status 413 and not with a tool error, as the error model defines for the refusals on `/mcp` that are HTTP statuses. The web UI's own forms SHALL be covered by the same 2 MiB limit and the same answer. A GitHub webhook delivery to `/webhooks/github` SHALL be refused in the same way, before its signature is checked, when its body is larger than 25 MiB (26,214,400 bytes), which is at least GitHub's own largest delivery, as the tracker-mirrors capability defines; the 2 MiB limit SHALL NOT apply to it. The problem's detail SHALL name the limit that applied. The OpenAPI document SHALL list 413 for every operation that takes a body, described with the limit that applies to that operation, so that `@tiehall/client`, which is generated from the document, carries the answer; and the CLI SHALL show the problem as it shows every problem, as the error model defines.

Source: D43; D50 (19); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A packet revision over the limit

- **WHEN** an agent sends a 3 MiB packet revision for FE-142 through `/api/v1`, with `If-Match` set to the current revision's `ETag`
- **THEN** the API answers 413 with an RFC 9457 problem whose problem type is `payload-too-large`
- **AND** the problem's detail names the 2 MiB limit
- **AND** the packet's revision is unchanged and no event is appended

#### Scenario: A body of exactly the limit is not refused for its size

- **WHEN** a client sends a body of exactly 2,097,152 bytes to an operation under `/api/v1`, and then the same body with one more byte
- **THEN** the first call is not answered 413
- **AND** the second call is answered 413 with the problem type `payload-too-large`

#### Scenario: A large contract report is not refused for its size

- **WHEN** the contract Action sends a 10 MiB report to `contract.report`
- **THEN** the report is not answered 413
- **AND** the body reaches the operation's input validation

#### Scenario: A contract report over its own limit

- **WHEN** the contract Action sends a 17 MiB report to `contract.report`
- **THEN** the API answers 413 with an RFC 9457 problem whose problem type is `payload-too-large`
- **AND** the problem's detail names the 16 MiB limit
- **AND** no request is opened or updated

#### Scenario: A body over the limit is an HTTP status on /mcp

- **WHEN** an MCP client sends a 3 MiB body to `https://tiehall.example.com/mcp`
- **THEN** the HTTP answer's status is 413
- **AND** it is not a tool result with `isError` inside an HTTP 200 answer

#### Scenario: A chunked body over the limit

- **WHEN** a client sends a body to an operation under `/api/v1` in chunks with no declared length, and keeps sending past 2 MiB
- **THEN** the client receives 413 with the problem type `payload-too-large` before it has finished sending
- **AND** Tiehall reads none of the body after the byte that passed the limit

#### Scenario: A declared length above the limit

- **WHEN** a client's request to an operation under `/api/v1` declares a body length of 3 MiB
- **THEN** Tiehall answers 413 before reading any byte of the body

#### Scenario: A body over the limit before any other refusal

- **WHEN** setup is not complete and a client sends a 3 MiB body, with no token, to an operation under `/api/v1`
- **THEN** Tiehall answers 413 with the problem type `payload-too-large`
- **AND** the answer is not 503 with `setup-required` and not 401

#### Scenario: A web form over the limit

- **WHEN** Alice submits a form of the web UI whose body is larger than 2 MiB
- **THEN** Tiehall answers 413 with an RFC 9457 problem whose problem type is `payload-too-large`
- **AND** nothing changes

#### Scenario: The document lists 413 on operations that take a body

- **WHEN** a reader looks up `requests.create` and `contract.report` in `https://tiehall.example.com/api/v1/openapi.json`
- **THEN** `requests.create` lists 413 as an RFC 9457 problem, described with the 2 MiB limit
- **AND** `contract.report` lists 413, described with the 16 MiB limit
- **AND** an operation without a body, such as the read of a request, lists no 413

#### Scenario: The CLI shows the limit

- **WHEN** `tiehall open` sends a packet whose body is larger than 2 MiB
- **THEN** the CLI shows the problem it got, whose detail names the 2 MiB limit
- **AND** no request is created

#### Scenario: A GitHub delivery has a limit of its own

- **WHEN** GitHub sends a 3 MiB delivery to `https://tiehall.example.com/webhooks/github`, and a client then sends a request there that declares a body of 26 MiB
- **THEN** the 3 MiB delivery is not answered 413
- **AND** the 26 MiB request is answered 413 with the problem type `payload-too-large` before any byte of its body is read

### Requirement: One error model for Tiehall's own refusals

When Tiehall refuses a call for one of its own reasons, on an `/api/v1` operation or on any other HTTP endpoint it serves (`/mcp`, request URLs and intake pages, the web UI's routes, the sign-in service's routes, the consent and device approval pages, the review pages and confirmations of the confirmation step under `/confirm/…`, and `/setup`), it SHALL answer with the HTTP status that the table below gives for that reason, as an RFC 9457 problem details object, and with the problem type the table names where it names one. The one exception is a refusal to a browser on the routes that serve the web UI's pages: the web UI's pages and their forms, the setup screen, the review pages and confirmations under `/confirm/…`, the consent and device approval pages, request URLs and intake pages when they answer in HTML, and GitHub's return to either sign-in callback. There, a refusal to a request that negotiates HTML SHALL be an HTML page with the same status, which gives the problem's title and detail in Tiehall's own words and a link on: back to the page whose form was refused, to the page that was asked for, or, for a refused sign-in or a browser that is not signed in, to the sign-in page. On request URLs and intake pages, a request negotiates HTML exactly as the agent-surfaces capability defines; on every other of these routes, when its `Accept` header names `text/html`, as browsers send. Every other request to those routes, and every call to any other route, `/api/v1` and `/mcp` included, SHALL get the problem details object; wherever another capability says that a refusal comes with an RFC 9457 problem, a browser on those routes gets this page in its place. The answers that the setup gate gives before setup completes stay as the self-host-install capability defines. This table is the error model that the other capabilities refer to for the status of their refusals. The MCP tools SHALL refuse in the same cases and report each refusal as a tool error: a tool result with `isError` set to true, whose content names the problem type of the matching row. Wherever another capability speaks of a tool error, a validation error or a conflict error on the MCP tools, it means such a result. Three kinds of refusal on `/mcp` SHALL instead be HTTP statuses, not tool errors: a refused request state, as the row below and the agent-surfaces capability define; the OAuth refusals of a missing, invalid or insufficient token; and a request body over the size limit, as the row below and the requirement on request body sizes define. The CLI, which calls the REST API, SHALL show the problem it gets.

| Reason for the refusal | Status |
| --- | --- |
| No such route, or an operation that this surface does not offer, such as an operation not offered on REST, a closed route of the sign-in service, or `/setup` once setup is complete | 404 |
| The record that the path or the input names does not exist, such as a request key, a team key, a proposal id or a GitHub username that names no person's GitHub account | 404 |
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
| A request body is larger than the size limit, as the requirement on request body sizes defines: 2 MiB, 16 MiB for `contract.report`, or 25 MiB for a GitHub webhook delivery | 413, with the problem type `payload-too-large` |
| A packet revision is sent without `If-Match` | 428 |
| A write limit, a budget or a request cap is exceeded, or the rate limit on the sign-in callback, as the sign-in capability defines | 429, with a `Retry-After` header |
| GitHub or the Jira site failed a call that the action needs, by answering with an error that the action gives no answer of its own for, or by not answering within 10 seconds, such as the look-up of the GitHub account an invite names, the check of an uploaded App key or the exchange of the setup screen's manifest code | 502, with the problem type `integration-unavailable` |

Refusals whose status a protocol sets keep that status: the OAuth errors that the agent-access capability defines, such as 401 with `invalid_token`, 403 with `insufficient_scope`, and `unauthorized_client`; 412 for an `If-Match` that does not match the current revision; and 422 for an `Idempotency-Key` reused with a different body. An install holds one org, so no refusal hides another org's data behind a 404: a caller who has been removed from the install gets 403 on every surface, as the teams-and-roles capability defines for a removed member. When more than one row applies, a body over the size limit SHALL get 413 before any row is checked, a path that serves no operation on the surface SHALL answer 404 whoever calls it, and a removed member's call SHALL get 403 before any record is looked up, so it never learns whether a record exists. A refusal because GitHub or the Jira site is unavailable SHALL change nothing, and SHALL leave unused the confirmation that the refused action carried, so that the same review page can be confirmed again while its confirmation is valid.

Source: D28 #1; D29 (7); D30; D43; D50 (3), (7), (19), (20); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A body over the size limit

- **WHEN** an agent sends a 3 MiB body to `requests.create` through `/api/v1`
- **THEN** the API answers 413 with an RFC 9457 problem whose problem type is `payload-too-large`
- **AND** no request is created and no event is appended

#### Scenario: GitHub does not answer an action that needs it

- **WHEN** Ada, an admin, confirms on its review page the upload of a new private key for the install's GitHub App, and GitHub does not answer the key's check within 10 seconds
- **THEN** Tiehall answers 502 with the problem type `integration-unavailable`
- **AND** the key in use is unchanged
- **AND** the confirmation Ada used is not spent, so confirming the same review page again within its 5 minutes applies the upload once GitHub answers

#### Scenario: A browser gets a refusal as a page

- **WHEN** Dana, whose role is `member`, opens the web UI's page of the invites that wait to be accepted in a browser whose `Accept` header names `text/html`
- **THEN** Tiehall answers 403 with an HTML page that gives the refusal's title and detail and a link on
- **AND** the answer is not an RFC 9457 problem

#### Scenario: A client that does not ask for a page gets the problem

- **WHEN** a client with Dana's web session asks for the same page with an `Accept` header of `application/json`
- **THEN** Tiehall answers 403 with an RFC 9457 problem

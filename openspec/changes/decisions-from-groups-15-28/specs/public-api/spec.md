# Spec Delta: public-api

## Purpose

States the cap on request bodies read at once, the refusals the triage of groups 15 to 28 settles in the error model, the 200 answer to a withdrawal, the compatibility checks of stable operations and tools, where the CLI's version is checked, and the one case before the first release in which the `api-breaking` label allows a break. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Request bodies have a size limit

Every HTTP endpoint Tiehall serves under `/api/v1` and `/mcp`, except the `contract.report` operation, SHALL refuse a request body larger than 2 MiB (2,097,152 bytes); the `contract.report` operation SHALL refuse one larger than 16 MiB (16,777,216 bytes); both with 413 and the problem type `payload-too-large`, as the error model defines. A body of exactly the limit SHALL NOT be refused for its size. Tiehall SHALL refuse the body before it parses it, so a body over the limit SHALL run no operation, SHALL change nothing and SHALL append no event, whatever it holds. Because the body is refused before it is read, a body over the limit SHALL be answered 413 before any other refusal the call would get, including a missing token and setup that is not complete. The limit SHALL count the bytes received, not a length the request declares: a body sent in chunks without a declared length SHALL be limited too, and a request that declares a length above the limit SHALL be refused before any byte of its body is read. Once the limit is passed, Tiehall SHALL send the answer and SHALL NOT read the rest of the body. On `/mcp`, a body over the limit SHALL be refused with the HTTP status 413 and not with a tool error, as the error model defines for the refusals on `/mcp` that are HTTP statuses. The web UI's own forms SHALL be covered by the same 2 MiB limit and the same answer. A GitHub webhook delivery to `/webhooks/github` SHALL be refused in the same way, before its signature is checked, when its body is larger than 25 MiB (26,214,400 bytes), which is at least GitHub's own largest delivery, as the tracker-mirrors capability defines; the 2 MiB limit SHALL NOT apply to it. The problem's detail SHALL name the limit that applied. Besides each body's own limit, one web process SHALL hold at most 64 MiB (67,108,864 bytes) of request bodies being received at once, across every route that reads a body before it knows who calls: `/api/v1`, `/mcp`, `/webhooks/github`, the web UI's forms and the sign-in service's routes. A request that declares its body's length SHALL reserve that length when it arrives, and a body sent in chunks SHALL count its bytes as they arrive; the bytes a body holds SHALL be released once it has been read, refused or abandoned. A request whose body would take the bytes being received past that cap SHALL be answered at once with 503, the problem type `busy` and a `Retry-After` header, as the error model defines, before its body is read past the cap; it SHALL run no operation, SHALL change nothing and SHALL append no event. A body over its own limit SHALL still get 413, and the refusal for the cap SHALL come before every other refusal but that 413. On `/mcp`, the refusal for the cap SHALL be the HTTP status and not a tool error. A GitHub delivery refused for the cap is a failed delivery, which Tiehall asks GitHub to redeliver, as the tracker-mirrors capability defines. The OpenAPI document SHALL list 413 for every operation that takes a body, described with the limit that applies to that operation, and 503 with the problem type `busy`, so that `@tiehall/client`, which is generated from the document, carries the answer; and the CLI SHALL show the problem as it shows every problem, as the error model defines.

Source: D43; D50 (19); D55 (2), (5); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

- **WHEN** Alice submits a form of the web UI whose body is larger than 2 MiB from a browser whose `Accept` header names `text/html`, and a client then sends the same form with an `Accept` header of `application/json`
- **THEN** Tiehall answers Alice 413 with the refusal page, which names the 2 MiB limit
- **AND** it answers the client 413 with an RFC 9457 problem whose problem type is `payload-too-large`
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

#### Scenario: Bodies beyond what one process reads at once

- **WHEN** one web process is receiving two GitHub deliveries of 25 MiB each, and the contract Action then sends a report that declares a body of 15 MiB to `contract.report`
- **THEN** Tiehall answers the report 503 with the problem type `busy` and a `Retry-After` header, before reading any byte of its body
- **AND** no request is opened or updated
- **AND** once the two deliveries have been read, the same report is not refused for the cap

#### Scenario: A body over its own limit is refused for its size first

- **WHEN** one web process is receiving bodies that hold 60 MiB in all, and a client sends a request that declares a body of 3 MiB to `requests.create`
- **THEN** Tiehall answers 413 with the problem type `payload-too-large`, not 503

#### Scenario: The cap is an HTTP status on /mcp

- **WHEN** one web process is receiving bodies that hold 63 MiB in all, and an MCP client sends a body of 2 MiB to `https://tiehall.example.com/mcp`
- **THEN** the HTTP answer's status is 503 with the problem type `busy` and a `Retry-After` header
- **AND** it is not a tool result with `isError` inside an HTTP 200 answer

### Requirement: One error model for Tiehall's own refusals

When Tiehall refuses a call for one of its own reasons, on an `/api/v1` operation or on any other HTTP endpoint it serves (`/mcp`, request URLs and intake pages, the web UI's routes, the sign-in service's routes, the consent and device approval pages, the review pages and confirmations of the confirmation step under `/confirm/…`, and `/setup`), it SHALL answer with the HTTP status that the table below gives for that reason, as an RFC 9457 problem details object, and with the problem type the table names where it names one. The one exception is a refusal to a browser on the routes that serve the web UI's pages: the web UI's pages and their forms, the setup screen, the review pages and confirmations under `/confirm/…`, the consent and device approval pages, request URLs and intake pages when they answer in HTML, and GitHub's return to either sign-in callback. There, a refusal to a request that negotiates HTML SHALL be an HTML page with the same status, which gives the problem's title and detail in Tiehall's own words and a link on: back to the page whose form was refused, to the page that was asked for, or, for a refused sign-in or a browser that is not signed in, to the sign-in page. On request URLs and intake pages, a request negotiates HTML exactly as the agent-surfaces capability defines; on every other of these routes, when its `Accept` header names `text/html` in a media range whose quality is above 0, as browsers send; a range such as `text/html;q=0` says that HTML is not acceptable (RFC 9110, section 12.4.2) and does not ask for the page. Every other request to those routes, and every call to any other route, `/api/v1` and `/mcp` included, SHALL get the problem details object; wherever another capability says that a refusal comes with an RFC 9457 problem, a browser on those routes gets this page in its place. The answers that the setup gate gives before setup completes stay as the self-host-install capability defines. This table is the error model that the other capabilities refer to for the status of their refusals. The MCP tools SHALL refuse in the same cases and report each refusal as a tool error: a tool result with `isError` set to true, whose content names the problem type of the matching row. Wherever another capability speaks of a tool error, a validation error or a conflict error on the MCP tools, it means such a result. Five kinds of refusal on `/mcp` SHALL instead be HTTP statuses, not tool errors: a refused request state, as the row below and the agent-surfaces capability define; the OAuth refusals of a missing, invalid or insufficient token; a request body over the size limit, and a body refused for the cap on bodies being received at once, as the rows below and the requirement on request body sizes define; and a request whose `Origin` header names another origin than the install's, as the row below and the agent-surfaces capability define. The CLI, which calls the REST API, SHALL show the problem it gets.

| Reason for the refusal | Status |
| --- | --- |
| No such route, or an operation that this surface does not offer, such as an operation not offered on REST, a closed route of the sign-in service, a method other than `GET`, `HEAD` and `POST` on a request URL, as the agent-surfaces capability defines, or `/setup` once setup is complete | 404 |
| The record that the path or the input names does not exist, such as a request key, a team key, a proposal id or a GitHub username that names no person's GitHub account | 404 |
| Setup is not complete, as the self-host-install capability defines (pages redirect to `/setup` instead) | 503, with the problem type `setup-required` |
| The app is shutting down, for example for an upgrade | 503, with `Retry-After: 0` |
| One web process is already receiving as many request bodies as it holds at once, and the request's body would take it past that cap, as the requirement on request body sizes defines | 503, with the problem type `busy` and a `Retry-After` header |
| The input fails the operation's input schema | 400 |
| A value is outside what the install's settings allow, such as a personal access token lifetime above the admin's maximum | 400 |
| The CLI is older than its minimum supported version | 400, with the problem type `upgrade-required` |
| The caller may not take the action: their role in the install, or their part in the request or record (such as the requester side, the target team, the claimant, the accountable human, the other side of a cross-team commitment or the proposer), does not allow it | 403 |
| A GitHub account may not sign in under the install's sign-in rules, as the sign-in capability defines, including a sign-in whose only way in is an invite that has expired or been revoked | 403 |
| The admin has switched personal access tokens off | 403 |
| A confirmation that the action needs, as the agent-safety capability defines, is missing or invalid: no nonce, or one that is used, expired, or bound to another user, session or input, or a failed CSRF, `Origin` or `Sec-Fetch-Site` check | 403 |
| The caller has been removed from the install | 403 |
| A request to `/mcp` carries an `Origin` header that names another origin than the install's, as the agent-surfaces capability defines | 403 |
| A retried MCP call carries a request state that was bound to another user, client or proposal, was changed, or has expired | 403 |
| A CI caller presents a GitHub Actions OIDC token whose `jti` Tiehall has already seen (a replayed CI token) | 401, with the error `invalid_token`, as for any other invalid bearer token |
| A CI caller calls an operation other than `contract.report`, or reports for an API that is not registered to its repository or, for an API bound to a workflow, not from that workflow, or, from a run for a pull request, for another pull request than the run's, as the agent-access capability defines | 403 |
| An agent write to a request flagged `needs_human`, as the agent-safety capability defines | 409, with the problem type `needs-human` |
| Any other state conflict, including a confirmation or rejection of a proposal that has ended, the other side's confirmation or rejection of a cross-team commitment before the accountable human has confirmed it, an expired device code on the device approval page, and a role change or removal that would leave the install without an admin | 409 |
| A request body is larger than the size limit, as the requirement on request body sizes defines: 2 MiB, 16 MiB for `contract.report`, or 25 MiB for a GitHub webhook delivery | 413, with the problem type `payload-too-large` |
| A packet revision is sent without `If-Match` | 428 |
| A write limit, a budget or a request cap is exceeded, or the rate limit on the sign-in callback, as the sign-in capability defines | 429, with a `Retry-After` header |
| GitHub or the Jira site failed a call that the action needs, by answering with an error that the action gives no answer of its own for, or by not answering within 10 seconds, such as the look-up of the GitHub account an invite names, the look-up of a GitHub organization's members at a sign-in, as the sign-in capability defines, the check of an uploaded App key or the exchange of the setup screen's manifest code | 502, with the problem type `integration-unavailable` |

Refusals whose status a protocol sets keep that status: the OAuth errors that the agent-access capability defines, such as 401 with `invalid_token`, 403 with `insufficient_scope`, and `unauthorized_client`; 412 for an `If-Match` that does not match the current revision; and 422 for an `Idempotency-Key` reused with a different body. An install holds one org, so no refusal hides another org's data behind a 404: a caller who has been removed from the install gets 403 on every surface, as the teams-and-roles capability defines for a removed member. When more than one row applies, a body over the size limit SHALL get 413 before any row is checked, and a body refused for the cap on bodies being received at once SHALL get 503 `busy` before any other row; a path that serves no operation on the surface SHALL answer 404 whoever calls it; a removed member's call SHALL get 403 before any record is looked up and before its request state is checked, so it never learns whether a record exists or a request state holds, and on `/mcp` that refusal SHALL be the removed member's tool error; and a CI caller's call SHALL be checked in the order the agent-access capability defines, in which a call to an operation other than `contract.report` gets 403 before GitHub Actions' keys are read, so it never gets 502. A refusal because GitHub or the Jira site is unavailable SHALL change nothing, and SHALL leave unused the confirmation that the refused action carried, so that the same review page can be confirmed again while its confirmation is valid.

Source: D28 #1; D29 (7); D30; D43; D50 (3), (7), (19), (20); D55 (1), (5), (7), (26), (33), (42), (58), (61); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A range with quality 0 does not ask for a page

- **WHEN** a client with the web session of Dana, whose role is `member`, asks for the web UI's page of the invites that wait to be accepted with an `Accept` header of `text/html;q=0, application/json`
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** the answer is not an HTML page

#### Scenario: A sign-in GitHub cannot check

- **WHEN** an admin has connected the App's installation on the GitHub organization `acme`, and Lee, a member of `acme` who is not a member of the install and holds no invite, signs in while GitHub answers the look-up of `acme`'s members with 500
- **THEN** Tiehall answers 502 with the problem type `integration-unavailable`
- **AND** no session, Tiehall user or membership is created
- **AND** the activity log gains no event for a refused sign-in

#### Scenario: A foreign Origin on /mcp is an HTTP status

- **WHEN** a client calls `https://tiehall.example.com/mcp` with a valid access token and the header `Origin: https://attacker.example`
- **THEN** the HTTP answer's status is 403
- **AND** it is not a tool result with `isError` inside an HTTP 200 answer
- **AND** no tool runs

#### Scenario: A removed member's retry learns nothing of its request state

- **WHEN** Dana has been removed from the install, and their MCP client retries a tool call, with a token that has not expired, carrying a `requestState` whose content was changed after Tiehall signed it
- **THEN** the answer is a tool result with `isError` set to true whose content names the problem type of a removed member
- **AND** the HTTP answer's status is not 403

#### Scenario: Another method on a request URL

- **WHEN** a member's agent sends `DELETE https://tiehall.example.com/FE-142` with a valid token
- **THEN** Tiehall answers 404 with the problem type `route-not-found`
- **AND** FE-142 is unchanged

#### Scenario: A CI caller on another operation does not wait for GitHub

- **WHEN** GitHub Actions' keys cannot be read, and a caller with a GitHub Actions OIDC token calls `requests.create` through `/api/v1`
- **THEN** the API answers 403 with the problem type `ci-caller-refused`
- **AND** the answer is not 502

### Requirement: Commitments over the API answer 202 with a proposal

When a user caller calls an `/api/v1` operation that is a commitment under D23, the API SHALL NOT apply it. It SHALL create a proposal instead and answer 202 with a body that carries the proposal. The proposal, in the 202 body and wherever the API returns it, SHALL state the confirmations it needs and the ones it has received: the accountable human's, and, for a commitment that needs a confirmation from each side, the other side's, as the requests capability defines for cross-team commitments. It SHALL also state when it expires and, once it has ended without taking effect, how it ended, as the requests capability defines. The 202 body MUST NOT contain the proposal's confirm URL, or any other `/confirm/` URL, because agents that call the API with a personal access token read it. The commitment SHALL take effect only when the people the requests capability names have confirmed the proposal in the web UI, with the confirmation step that the agent-safety capability defines. The OpenAPI document SHALL describe the 202 answer for every commitment operation. A call of the operation that proposes commitments that instead withdraws one of the caller's pending proposals makes no commitment: it SHALL take effect at once and SHALL answer 200 with a body that carries the ended proposal, and the operation's 200 answer SHALL allow that body; a commitment proposed through the same operation SHALL still answer 202. The answer of the MCP tool `propose` is as the agent-surfaces capability defines.

Source: D23; D28 #16, #36; D30; D55 (37); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: Withdrawing a proposal answers 200

- **WHEN** a personal access token caller acting for Alice calls `POST /api/v1/proposals` with the kind `withdraw_proposal`, naming Alice's pending due-date proposal on FE-142
- **THEN** the API answers 200 with a body that carries the proposal, which states that it was withdrawn
- **AND** the answer is not 202

### Requirement: Notice before a breaking change is enforced in CI

A `beta` operation SHALL change in three steps: add the new shape; mark the old one `deprecated: true` with an `x-sunset` date at least 14 days after the change; then remove it on or after that date. A `stable` operation SHALL get at least 180 days between deprecation and removal. On every pull request, CI SHALL compare the OpenAPI document at the pull request's merge base with the pull request's version and SHALL fail on an error-level breaking change to a `beta` or `stable` operation, including a sunset date closer than that operation's notice period and a removal before the sunset date. For a `stable` operation, CI SHALL also fail on a change that removes something from the operation even when the comparison rates it as a warning rather than an error, such as the removal of an optional input property or of a property of the response, because a `stable` operation SHALL only gain things.

Source: D55 (30); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A stable operation loses an optional field

- **WHEN** a pull request removes an optional property from the input of `contract.report`, which is `stable`
- **THEN** CI fails
- **AND** the same removal from the input of a `beta` operation, with the version bumped, does not fail the compatibility check because of it

### Requirement: The `api-breaking` label for urgent security fixes

A breaking change to a `beta` or `stable` operation before its notice has run SHALL be allowed only for a security fix that cannot wait, and, before Tiehall's first release, for a break of a `beta` operation that an OpenSpec change the maintainers approved names, because no released install serves the old shape. Such a pull request SHALL carry the `api-breaking` label and SHALL add a changelog entry. Once the first release is published, the label SHALL again allow only a security fix that cannot wait. Before the packet schema is published, breaking packet changes also use the label, as the handoff-packet capability defines.

Source: D55 (47); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: An urgent security fix is announced

- **WHEN** a security fix must remove a field from a `beta` operation's input at once
- **THEN** the pull request carries the `api-breaking` label and adds a changelog entry
- **AND** the change is listed on the changelog page of an install running the release that carries it

#### Scenario: A break an approved change names, before the first release

- **WHEN** no release of Tiehall has been published, and a pull request renames the fields of the entries of `GET /api/v1/events/wait`, a break that an approved OpenSpec change names, with the `api-breaking` label, a changelog entry and the version bumped
- **THEN** the compatibility check does not fail because of the break
- **AND** the changelog page of an install built from that commit lists the break

### Requirement: MCP tools follow the same compatibility rules

MCP tools SHALL follow the stability level and notice rules of their operation: while the operation is `beta`, removing a tool or adding a required argument SHALL follow the same notice as the operation. Once the operation is `stable`, its tool SHALL only gain things; a breaking change SHALL get a new tool name, and the old tool SHALL stay for at least six months. The comparison of the snapshot SHALL fail, for the tool of a `stable` operation, on any change that removes something from it, such as an optional argument or a field of its output, even when the comparison rates it as a warning rather than an error, as for the operation's REST form. A snapshot of the tool names, descriptions, input schemas and output schemas SHALL be compared on every pull request.

Source: D55 (30); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The snapshot shows a removed tool

- **WHEN** a pull request removes an MCP tool or adds a required argument to one
- **THEN** the snapshot comparison reports the change in that pull request

#### Scenario: A breaking change to a stable tool gets a new name

- **WHEN** a tool whose operation is `stable` needs a breaking change to its arguments
- **THEN** the new behavior ships under a new tool name
- **AND** the old tool keeps working for at least six months

#### Scenario: A stable tool loses an optional argument

- **WHEN** a pull request removes an optional argument from the tool of a `stable` operation and keeps the tool's name
- **THEN** CI fails

### Requirement: The CLI sends its version and the server keeps a minimum

The CLI SHALL send its version with every call. The server SHALL keep a minimum supported CLI version and SHALL answer a call to `/api/v1` from an older CLI with 400 and an RFC 9457 problem of the type `upgrade-required` that says how to upgrade, without running the operation. `tiehall login` signs in through the authorization server's device flow, as the agent-access capability defines, which does not check the CLI's version, so a CLI older than the minimum SHALL be able to sign in, and SHALL be told to upgrade at its first call to `/api/v1`.

Source: D28 #1; D55 (35); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: An old CLI is told to upgrade

- **WHEN** a CLI older than the minimum supported version runs `tiehall inbox`
- **THEN** the server answers 400 with a problem of the type `upgrade-required` that says how to upgrade
- **AND** the operation does not run

#### Scenario: An old CLI signs in and is told to upgrade at its first command

- **WHEN** a CLI older than the minimum supported version runs `tiehall login https://tiehall.example.com`, the user approves it, and the user then runs `tiehall inbox`
- **THEN** the CLI holds a saved login for `https://tiehall.example.com`
- **AND** `tiehall inbox` gets 400 with a problem of the type `upgrade-required`, and the operation does not run

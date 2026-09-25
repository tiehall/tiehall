# Spec Delta: agent-access

## Purpose

Defines how agent clients, the `tiehall` CLI, personal access tokens, bot users and the company's CI get access to a Tiehall install: Tiehall as its own OAuth 2.1 authorization server, the six kinds of caller, client registration, scopes, token lifetimes, the restricted device flow, personal access tokens, and GitHub Actions OIDC for contract reports.

## ADDED Requirements

### Requirement: Tiehall is the authorization server for agent clients

Each install SHALL act as its own OAuth 2.1 authorization server for MCP clients and the `tiehall` CLI, with the install's public base URL, such as `https://tiehall.example.com`, as its issuer. It SHALL publish OAuth 2.0 Protected Resource Metadata (RFC 9728) under `/.well-known/` that names that issuer as the authorization server, and authorization server metadata that advertises `client_id_metadata_document_supported` while metadata-document fetching is on. The authorization server SHALL offer the authorization code grant with refresh tokens to MCP clients and the device authorization grant only to the CLI, and SHALL NOT offer the client credentials grant. An access token the install issues for its resource SHALL be accepted by both `/mcp` and `/api/v1`. Checking an access token SHALL make no outbound network call.

Source: D8; design.md, Decisions this change rests on; design.md, Design rules: Agent access; design.md, Technical decisions: T7; design.md, Technical decisions: T9; design.md, Self-hosting decisions: S13

#### Scenario: An MCP client discovers the authorization server

- **WHEN** metadata-document fetching is on, and an MCP client fetches the protected resource metadata for `https://tiehall.example.com/mcp`
- **THEN** the document names `https://tiehall.example.com` as the authorization server
- **AND** the authorization server metadata advertises `client_id_metadata_document_supported`
- **AND** its `grant_types_supported` does not list `client_credentials`

#### Scenario: One token works on both endpoints

- **WHEN** the CLI holds an unexpired access token from `tiehall login https://tiehall.example.com`
- **THEN** a call to `/api/v1` with that token is accepted
- **AND** a call to `/mcp` with the same token is accepted

#### Scenario: A token check makes no outbound call

- **WHEN** the install runs in a network where every outbound connection fails, and an agent calls `/mcp` with a valid access token
- **THEN** the call is accepted
- **AND** the install attempts no outbound connection to check the token

### Requirement: Six kinds of caller

Every call to a Tiehall operation SHALL come from exactly one of six kinds of caller, each authorized as follows:
- a web session, which acts for the signed-in user within the user's role, and whose actions are recorded with the actor kind `web_session`, as the requests capability defines;
- an OAuth token, held by an MCP client or by the CLI after its device flow, which acts for the user who approved the client, within the token's scopes and the user's role;
- a personal access token, which acts for the user who created it, within its scopes and the user's role;
- a CI caller, authenticated with a GitHub Actions OIDC token, which acts for a registered API's repository and is limited as the requirement on CI below defines;
- a system job, which acts for no user and runs only Tiehall's internal system commands, which are never commitments;
- an integration event, meaning a verified GitHub or Jira webhook or a change Tiehall reads from GitHub or Jira by polling or reconciliation, as the tracker-mirrors capability defines, which acts for the mapped user if there is one and runs only internal commands.

A system job or an integration event SHALL NOT be able to run an operation that is offered on REST, MCP or the CLI. An operation that no surface offers, an internal command, SHALL run only for a web session, through the web UI, or for a system job or an integration event, through the worker; an OAuth token, a personal access token or a CI caller SHALL NOT be able to run one. Every action guarded by the confirmation step, as the agent-safety capability defines, SHALL be an internal command, so it runs only for a web session. The operator commands that the self-host-install capability defines run on the host, outside these six kinds of caller, and are the one exception the agent-safety capability makes to the confirmation step.

Source: D23; design.md, Decisions this change rests on; design.md, Design rules: Agent access; design.md, Design rules: Public API; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S9

#### Scenario: A token cannot reach an internal command

- **WHEN** an agent holding a valid OAuth token for Bob calls the `/api/v1` path of an internal command, one that no surface offers
- **THEN** the call answers HTTP 404
- **AND** the command does not run

#### Scenario: A system withdrawal acts for no user

- **WHEN** Tiehall withdraws the unclaimed contract-change request FE-150 because its provider PR closed unmerged
- **THEN** the change is recorded with the actor kind `system`
- **AND** it names no user as the one it acted for

#### Scenario: An unmapped tracker account acts for no user

- **WHEN** a verified Jira webhook reports a change on a mirror issue, made by a Jira account that is linked to no Tiehall user
- **THEN** the event Tiehall records has the actor kind `integration`
- **AND** it names no user as the one it acted for

### Requirement: Clients identified by a Client ID Metadata Document are preferred

While metadata-document fetching is on, Tiehall SHALL accept clients whose `client_id` is an HTTPS URL pointing to a Client ID Metadata Document, and SHALL treat such a client as identified by that URL only when the fetched document's `client_id` equals the URL exactly. Tiehall SHALL fetch metadata documents only through the outbound fetcher that the agent-safety capability defines, which refuses loopback, private, link-local and cloud metadata addresses and redirects to them. Tiehall SHALL fetch at most 60 metadata documents per minute from any one host; an authorization request that Tiehall cannot check because that host's limit is used up SHALL be refused with HTTP 429 and a `Retry-After` header.

Source: D28 #43; design.md, Decisions this change rests on; design.md, Design rules: Agent access; design.md, Design rules: Agent safety

#### Scenario: A matching metadata document identifies the client

- **WHEN** a client starts authorization with the `client_id` `https://vendor.example/oauth/client.json`, and the document served at that URL has `client_id` equal to `https://vendor.example/oauth/client.json`
- **THEN** authorization continues to the consent screen
- **AND** the consent screen shows `vendor.example` as the client's verified host

#### Scenario: A mismatched metadata document is refused

- **WHEN** the document served at a client's `client_id` URL carries a different `client_id`
- **THEN** Tiehall refuses the authorization request
- **AND** no consent screen is shown

#### Scenario: A document on an internal address is never fetched

- **WHEN** a client starts authorization with a `client_id` URL whose host name resolves to `10.0.0.5`
- **THEN** Tiehall refuses the authorization request without connecting to that address
- **AND** no consent screen is shown

#### Scenario: Fetches from one host are limited

- **WHEN** Tiehall has fetched 60 metadata documents from `vendor.example` within one minute, and another authorization request in that minute names a `client_id` URL on `vendor.example`
- **THEN** Tiehall does not fetch that document
- **AND** refuses the authorization request with HTTP 429 and a `Retry-After` header

### Requirement: The operator can switch metadata-document fetching off

The operator SHALL be able to switch metadata-document fetching off with the `.env` setting `TIEHALL_CLIENT_METADATA_FETCH=off`, as the self-host-install capability defines. While it is off, Tiehall SHALL fetch no Client ID Metadata Document, its authorization server metadata SHALL NOT advertise `client_id_metadata_document_supported`, and an authorization request whose `client_id` is a URL SHALL be refused without fetching that URL. Dynamic Client Registration SHALL stay available, so clients can still connect through it.

Source: D28 #43; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S13

#### Scenario: Switched off, nothing is fetched

- **WHEN** the operator has switched metadata-document fetching off, and a client starts authorization with the `client_id` `https://vendor.example/oauth/client.json`
- **THEN** Tiehall refuses the authorization request
- **AND** makes no connection to `vendor.example`

#### Scenario: Switched off, the metadata stops advertising it

- **WHEN** the operator has switched metadata-document fetching off
- **THEN** the authorization server metadata does not advertise `client_id_metadata_document_supported`
- **AND** a client that registers through Dynamic Client Registration can still reach the consent screen

### Requirement: Dynamic Client Registration stays on, limited and unverified

Tiehall SHALL keep Dynamic Client Registration (RFC 7591) on, SHALL accept at most 10 registrations per hour from one IP address, and SHALL remove a registered client that has never been used 7 days after it registered. A registration beyond that limit SHALL be refused with HTTP 429 and a `Retry-After` header. The IP address SHALL be the client's address as the install sees it, taking forwarded headers only from the proxies the operator names, as the self-host-install capability defines. Because a DCR client's name is self-asserted and each installation of a client registers a new id, Tiehall SHALL treat every DCR client as unverified.

Source: D28 #43; design.md, Decisions this change rests on; design.md, Design rules: Agent access; design.md, Self-hosting decisions: S2

#### Scenario: A DCR client is labeled unverified

- **WHEN** a client registers through DCR and starts authorization
- **THEN** the consent screen shows the client's name together with an "unverified client" warning
- **AND** the consent screen shows no verified host for it

#### Scenario: Registrations beyond the limit are refused

- **WHEN** the address `203.0.113.5` has registered 10 clients through DCR within the past hour and sends another registration
- **THEN** Tiehall refuses that registration with HTTP 429 and a `Retry-After` header
- **AND** no client id is issued for it

#### Scenario: Addresses behind the operator's proxy are counted apart

- **WHEN** the operator's named reverse proxy forwards registrations from `203.0.113.5` and from `198.51.100.7`, and `203.0.113.5` has registered 10 clients within the past hour
- **THEN** a registration forwarded from `198.51.100.7` is accepted

#### Scenario: Unused DCR clients are removed

- **WHEN** a DCR client registered 7 days ago and has never completed an authorization
- **THEN** Tiehall removes its registration
- **AND** a later authorization request with that client id is refused

### Requirement: Authorization requests use PKCE S256, resource indicators and the iss parameter

In the authorization code flow, Tiehall SHALL require PKCE with the `S256` method and SHALL refuse requests that carry no code challenge or use the `plain` method. It SHALL take the RFC 8707 `resource` parameter and bind the issued access token's audience to that resource. Every authorization response SHALL carry the `iss` parameter (RFC 9207) set to the install's issuer.

Source: design.md, Design rules: Agent access

#### Scenario: A request without PKCE is refused

- **WHEN** a client sends an authorization request with no `code_challenge`
- **THEN** Tiehall refuses the request with the OAuth error `invalid_request`
- **AND** no authorization code is issued

#### Scenario: The plain PKCE method is refused

- **WHEN** a client sends an authorization request with `code_challenge_method=plain`
- **THEN** Tiehall refuses the request with the OAuth error `invalid_request`

#### Scenario: The token audience is bound to the resource

- **WHEN** a client completes authorization with `resource` set to `https://tiehall.example.com/mcp`
- **THEN** the issued access token's audience is that resource
- **AND** a token whose audience is not a resource of this install gets HTTP 401 at `/mcp`

#### Scenario: The authorization response names the issuer

- **WHEN** a user approves an authorization request
- **THEN** the redirect back to the client carries `iss` equal to the issuer in the install's authorization server metadata

### Requirement: Missing and insufficient tokens get standard challenges

A call to `/mcp` or `/api/v1` without an access token SHALL get HTTP 401 with a `WWW-Authenticate` challenge that points to the protected resource metadata and carries a scope hint. A call with an expired, malformed or otherwise invalid token SHALL get HTTP 401 with a challenge that carries `error="invalid_token"` (RFC 6750). A call whose token lacks a scope the operation needs SHALL get HTTP 403 with the error `insufficient_scope` and the needed scope in the `WWW-Authenticate` challenge, and the operation SHALL NOT run.

Source: design.md, Design rules: Agent access; design.md, Technical decisions: T9

#### Scenario: No token

- **WHEN** a client calls `/mcp` without an `Authorization` header
- **THEN** the response is HTTP 401
- **AND** its `WWW-Authenticate` header points to the protected resource metadata and carries a scope hint

#### Scenario: An invalid token

- **WHEN** a client calls `/mcp` with an access token whose signature does not verify
- **THEN** the response is HTTP 401
- **AND** its `WWW-Authenticate` challenge carries `error="invalid_token"`

#### Scenario: Not enough scope

- **WHEN** a client calls an operation with a token whose scopes do not include the scope that operation needs
- **THEN** the response is HTTP 403 with `error="insufficient_scope"` and the needed scope
- **AND** nothing is written

### Requirement: Credentials are accepted only in the Authorization header

Tiehall SHALL accept access tokens and personal access tokens only in the HTTP `Authorization` header. A token placed anywhere else in a request, such as the URL query string, SHALL be ignored.

Source: design.md, Design rules: Agent access

#### Scenario: A token in the query string is ignored

- **WHEN** a client requests an `/api/v1` operation with a valid token in the query string and no `Authorization` header
- **THEN** the response is HTTP 401

### Requirement: OAuth scopes are coarse

Tiehall SHALL offer exactly three OAuth scopes: `requests:read`, `requests:write` and `contracts:report`. There SHALL be no `admin` scope, because admin operations run only in the web UI; an authorization request that asks for a scope Tiehall does not offer SHALL be refused with the OAuth error `invalid_scope`. `contract.report` itself SHALL accept only the CI caller, as the requirement on CI below and the contract-changes capability define, so no OAuth token or personal access token can report contract changes, whatever scopes it carries. The `contracts:report` scope SHALL guard attaching classified contract changes to a request by hand: the MCP tool `attach_contract_changes` and its REST operation SHALL need `contracts:report`, as the contract-changes capability defines.

Source: D28 #48; D30 (3); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7

#### Scenario: There is no admin scope

- **WHEN** a client sends an authorization request whose `scope` includes `admin`
- **THEN** Tiehall refuses the request with the OAuth error `invalid_scope`
- **AND** no authorization code is issued

#### Scenario: A read-only token cannot post

- **WHEN** a client whose token carries only `requests:read` calls `post_message` on FE-142
- **THEN** the response is HTTP 403 with `error="insufficient_scope"` naming `requests:write`
- **AND** no message is posted

#### Scenario: A user token cannot report contract changes

- **WHEN** a member of the PAY team calls `contract.report` for `payments-api` with a personal access token that carries all three scopes
- **THEN** the call is refused with HTTP 403 and an RFC 9457 problem
- **AND** no request is opened or updated

#### Scenario: Attaching contract changes needs contracts:report

- **WHEN** an agent whose token carries `requests:read` and `requests:write` but not `contracts:report` calls `attach_contract_changes` on FE-142
- **THEN** the response is HTTP 403 with `error="insufficient_scope"` naming `contracts:report`
- **AND** the packet of FE-142 is unchanged

#### Scenario: A token with contracts:report can attach

- **WHEN** Alice, the requester of the unclaimed request FE-143, runs `tiehall contract diff` and attaches the result to FE-143 through `attach_contract_changes` with a token that carries `contracts:report`
- **THEN** FE-143 gets a new packet revision whose contract section holds the classified changes

### Requirement: The consent screen shows who is asking

The consent screen SHALL show the client's name; for a client identified by a Client ID Metadata Document, its verified host; for a DCR client, an "unverified client" warning; and the host name of the redirect URI. It SHALL show a warning when every redirect URI of the client is on localhost. The consent screen SHALL be served only to a signed-in member, as the sign-in capability defines, and SHALL ask for no choice of org, because an install has one org.

Source: design.md, Design rules: Agent access; design.md, Self-hosting decisions: S1

#### Scenario: The redirect host name is shown

- **WHEN** a client's redirect URI is `https://agent.vendor.example/callback`
- **THEN** the consent screen shows the host name `agent.vendor.example`
- **AND** it asks for no choice of org

#### Scenario: Localhost-only redirect URIs are flagged

- **WHEN** every redirect URI of a client is on `localhost`
- **THEN** the consent screen shows a warning about localhost redirect URIs

### Requirement: Approving an agent client uses the confirmation step

Approving an agent client on the consent screen SHALL use the confirmation step for that one approval, as the agent-safety capability defines, and SHALL run only in the web UI. Tiehall SHALL NOT issue an authorization code or a token for the approval until it has been confirmed; an approval without a valid confirmation SHALL be refused with HTTP 403. The grant SHALL act for the approving user in the install's one org. Each approval SHALL be recorded as a security event, as the activity-log capability defines.

Source: D19; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: An approval without a valid confirmation fails

- **WHEN** a request that approves an agent client reaches the consent endpoint without a valid confirmation for that approval
- **THEN** Tiehall refuses it with HTTP 403
- **AND** no authorization code is issued
- **AND** the client gets no token

#### Scenario: A confirmed approval issues a code

- **WHEN** Ana approves an agent client on the consent screen with the confirmation step
- **THEN** the client receives an authorization code
- **AND** the activity log gains a security event for the approval

### Requirement: Access tokens live 10 minutes and refresh tokens rotate

Access tokens SHALL expire 10 minutes after they are issued. Refresh tokens SHALL rotate: each use SHALL return a new refresh token, and a refresh token that has been used SHALL NOT be accepted again.

Source: design.md, Design rules: Agent access; design.md, Technical decisions: T7

#### Scenario: An access token expires after 10 minutes

- **WHEN** a client calls `/mcp` with an access token issued 11 minutes earlier
- **THEN** the response is HTTP 401

#### Scenario: A used refresh token is refused

- **WHEN** a client exchanges a refresh token, receives a new access token and a new refresh token, and then presents the first refresh token again
- **THEN** Tiehall refuses it with the OAuth error `invalid_grant`

### Requirement: Every token call is checked against the install's current state

On every call made with an OAuth access token or a personal access token, Tiehall SHALL check, at the time of the call, that the token's user is still a member of the install, as the teams-and-roles capability defines, and, for a personal access token, that the PAT switch is on. A call that fails either check SHALL be refused with HTTP 403, as the public-api capability's error model defines, and SHALL return no data, even when the token has not expired. Because the switch is read at each call, turning it off SHALL NOT revoke any personal access token: turning it on again SHALL let unexpired tokens work again.

Source: D28 #4; design.md, Decisions this change rests on; design.md, Design rules: Agent access; design.md, Design rules: Teams and roles

#### Scenario: A switch change applies to the next call

- **WHEN** a member's script has just called `/api/v1` successfully with their personal access token, and an admin then turns the PAT switch off with the confirmation step
- **THEN** the script's next call with that token is refused with HTTP 403
- **AND** it returns no data of the install

#### Scenario: Turning the switch on again restores unexpired tokens

- **WHEN** an admin turned the PAT switch off and later turns it on again, and a member calls `/api/v1` with a personal access token that has not expired and was never revoked
- **THEN** the call is accepted

### Requirement: Tokens act for one user within that user's role

An OAuth token SHALL act for the user who approved the client, and a personal access token SHALL act for the user who created it. What such a token can do SHALL be limited to its scopes and, within them, to what the user's role and their part in the request allow, as the teams-and-roles and requests capabilities define; whatever scopes a token carries, a call the role or part does not allow SHALL be refused with HTTP 403. No token SHALL run an admin operation, even for an admin, because admin operations are offered on no agent surface, as the agent-safety capability defines. Commitments started through a token SHALL become proposals, as the requests capability defines.

Source: D23; D28 #3, #4, #48; design.md, Decisions this change rests on; design.md, Design rules: Agent access

#### Scenario: A token cannot act outside the user's part

- **WHEN** Bob, who is not a member of team PAY, calls `claim` on PAY-7 with a token that carries `requests:write`
- **THEN** the call is refused with HTTP 403
- **AND** PAY-7 stays unclaimed

#### Scenario: A commitment through a token becomes a proposal

- **WHEN** an agent with Erin's token, Erin being a member of team FE, declines FE-142 through `/api/v1`
- **THEN** the answer is HTTP 202 with a proposal
- **AND** FE-142 is not declined until the proposal is confirmed in the web UI

### Requirement: The CLI signs in through a restricted device flow

The `tiehall` CLI SHALL be a pre-registered public client with a fixed client id, and SHALL sign in with the OAuth device authorization grant (RFC 8628) when the user runs `tiehall login <url>` with the install's URL. The device flow SHALL accept only the CLI's client id; a device authorization request from any other client, including one registered through DCR or identified by a metadata document, SHALL be refused with the OAuth error `unauthorized_client`. Device codes SHALL expire 10 minutes after they are issued; the device approval page SHALL refuse an expired code with HTTP 409, as the public-api capability's error model defines for a state conflict, and the CLI's token request SHALL then get the error `expired_token`. The token the CLI receives SHALL have the install's MCP resource as its only audience. No device-flow endpoint SHALL return a web session or a session token.

Source: design.md, Design rules: Agent access; design.md, Technical decisions: T7; design.md, Self-hosting decisions: S15

#### Scenario: Another client cannot use the device flow

- **WHEN** a device authorization request carries the client id of a client registered through DCR
- **THEN** Tiehall refuses it with the OAuth error `unauthorized_client`
- **AND** no device code is issued

#### Scenario: A device code expires after 10 minutes

- **WHEN** a user enters a device code 11 minutes after `tiehall login https://tiehall.example.com` printed it
- **THEN** the approval page refuses it with HTTP 409
- **AND** the CLI receives no token, and its token request gets the error `expired_token` (RFC 8628)

#### Scenario: The CLI token is for the MCP resource only

- **WHEN** a user approves a `tiehall login https://tiehall.example.com` device code
- **THEN** the CLI receives an access token and a refresh token
- **AND** the access token's only audience is `https://tiehall.example.com/mcp`
- **AND** no web session is created for the CLI

### Requirement: The device approval page cannot be prefilled

The device approval page SHALL be served only to a signed-in member, SHALL ignore any user code carried in its URL, so the user types the code the CLI printed, and SHALL show the IP address and the time of the request that started the flow, with the text "continue only if you just ran `tiehall login`". The IP address SHALL be the one the install sees, taking forwarded headers only from the proxies the operator names. The page SHALL store nothing until the user approves. Approving SHALL use the confirmation step, as the agent-safety capability defines; an approval without a valid confirmation SHALL be refused with HTTP 403. The page SHALL ask for no choice of org. Each approval SHALL be recorded as a security event, as the activity-log capability defines.

Source: design.md, Design rules: Agent access; design.md, Self-hosting decisions: S2; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: A code in the link is not used

- **WHEN** a user opens the device approval page through a link that carries a user code
- **THEN** the code field is empty
- **AND** the code from the link is not applied

#### Scenario: The page shows where the request came from

- **WHEN** a user opens the device approval page and types a valid code
- **THEN** the page shows the IP address and time of the `tiehall login` request
- **AND** the text "continue only if you just ran `tiehall login`"

#### Scenario: Nothing is stored before approval

- **WHEN** a user types a valid code on the device approval page and leaves without approving
- **THEN** no grant exists for the CLI
- **AND** the CLI receives no token

#### Scenario: Device approval needs the confirmation step

- **WHEN** a device approval reaches Tiehall without a valid confirmation for that approval
- **THEN** Tiehall refuses it with HTTP 403
- **AND** the CLI receives no token

### Requirement: The CLI keeps its token readable only by the user

The CLI SHALL store its tokens in a file that only the user who ran `tiehall login` can read and write (file mode 0600).

Source: design.md, Design rules: Agent access

#### Scenario: The token file is private

- **WHEN** `tiehall login https://tiehall.example.com` completes
- **THEN** the file holding the token has mode 0600

### Requirement: Personal access tokens are scoped, expiring and created in the web UI

Tiehall SHALL issue personal access tokens (PATs) whose value starts with `th_pat_`, for hosts that can only send a header. Every PAT SHALL carry one or more of the three scopes and SHALL expire no later than 90 days after creation, or earlier when an admin has set a shorter maximum lifetime; a request for a longer lifetime SHALL be refused with HTTP 400, as the public-api capability's error model defines for a value outside what the install's settings allow. Tiehall SHALL keep only a hash of each PAT, so its value is shown once, at creation, and never again. A user SHALL create a PAT only in the web UI and with the confirmation step, as the agent-safety capability defines; no agent surface offers PAT creation. Each PAT created and each PAT revoked SHALL be recorded as a security event, as the activity-log capability defines.

Source: design.md, Design rules: Agent access; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: A PAT longer than 90 days is refused

- **WHEN** a user asks for a PAT that expires 120 days from now
- **THEN** Tiehall refuses to create it with HTTP 400

#### Scenario: The admin's shorter maximum applies

- **WHEN** an admin has set the maximum PAT lifetime to 30 days, and a user asks for a PAT that expires in 45 days
- **THEN** Tiehall refuses to create it with HTTP 400

#### Scenario: The value is shown only at creation

- **WHEN** a user creates a PAT in the web UI with the confirmation step
- **THEN** the returned value starts with `th_pat_`
- **AND** no later page or API response contains that value
- **AND** the activity log gains a security event for the new PAT

#### Scenario: A token cannot create a PAT

- **WHEN** an agent calls the `/api/v1` path of the operation that creates a PAT, with a valid OAuth token that carries every scope
- **THEN** the call answers HTTP 404
- **AND** no PAT is created

### Requirement: An admin sets the PAT switch and the maximum lifetime

The install SHALL have a PAT switch, which is on in a new install, and a maximum PAT lifetime of at most 90 days, which is 90 days in a new install. Only an admin SHALL change either, only in the web UI and with the confirmation step, as the agent-safety capability defines; a maximum above 90 days SHALL be refused with HTTP 400. While the switch is off, every call with a PAT SHALL be refused with HTTP 403, including calls with PATs created while it was on. Each change SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #4; design.md, Decisions this change rests on; design.md, Design rules: Agent access; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: A new install allows PATs of up to 90 days

- **WHEN** setup has just completed and no admin has changed the PAT settings
- **THEN** the PAT switch is on
- **AND** the maximum PAT lifetime is 90 days

#### Scenario: Existing PATs stop working when switched off

- **WHEN** an admin turns the PAT switch off, and a member's existing PAT is then used to call `/api/v1`
- **THEN** the call is refused with HTTP 403

#### Scenario: A member cannot change the PAT settings

- **WHEN** Dana, whose role is `member`, submits the web UI's form that turns the PAT switch off
- **THEN** the change is refused with HTTP 403
- **AND** the PAT switch stays on

#### Scenario: The maximum cannot exceed 90 days

- **WHEN** an admin sets the maximum PAT lifetime to 120 days with the confirmation step
- **THEN** the change is refused with HTTP 400
- **AND** the maximum is unchanged

### Requirement: PAT owners are reminded before expiry

Tiehall SHALL remind the owner of every personal access token 14 days before the PAT expires and again 3 days before it expires. Each reminder SHALL appear in the owner's web inbox, and SHALL also be sent to the owner by email when SMTP is set up.

Source: D28 #46; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S10

#### Scenario: Two reminders before expiry

- **WHEN** Lee's PAT expires on 2026-12-31 and SMTP is set up
- **THEN** Lee's web inbox shows a reminder about it on 2026-12-17 and again on 2026-12-28
- **AND** Lee gets an email about it on each of those days

#### Scenario: Without SMTP the reminders stay in the inbox

- **WHEN** Lee's PAT expires on 2026-12-31 and SMTP is not set up
- **THEN** Lee's web inbox shows the reminders on 2026-12-17 and 2026-12-28
- **AND** no email is sent

### Requirement: Users list and revoke their own agent grants and tokens

Every user SHALL have a page named "Connected agents and tokens" that lists the grants they have given agent clients, including the CLI, and their personal access tokens, and that lets them revoke any of them. Revoking a grant SHALL stop its refresh token at once; access tokens already issued from it stop working when they expire, within 10 minutes. A revoked PAT SHALL stop working at once. Each revocation SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #47; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S14

#### Scenario: The page lists grants and tokens

- **WHEN** Ana has approved an MCP client, signed the CLI in and created a PAT, and opens "Connected agents and tokens"
- **THEN** the page lists the MCP client's grant, the CLI's grant and the PAT

#### Scenario: A revoked grant's refresh token stops working

- **WHEN** Ana revokes the MCP client's grant on that page, and the client then presents the refresh token it got from that grant
- **THEN** Tiehall refuses it with the OAuth error `invalid_grant`
- **AND** the activity log gains a security event for the revocation

#### Scenario: A revoked PAT stops working

- **WHEN** Ana revokes the PAT on that page, and a call is then made to `/api/v1` with that PAT
- **THEN** the response is HTTP 401

### Requirement: Machine access is a PAT held by a bot user

A company's bot or internal service SHALL get access through a PAT held by a dedicated bot user. A bot user SHALL sign in with its own GitHub account, which is admitted like any person's, through membership of a connected GitHub organization or an invite, as the sign-in capability defines, and it creates its PATs in the web UI like any user. What the bot flag is and does is defined by the teams-and-roles capability. A bot user SHALL get the expiry reminders that every PAT owner gets. Service accounts SHALL NOT be offered, and a token request with the client credentials grant SHALL be refused with the OAuth error `unsupported_grant_type`.

Source: D28 #94; design.md, Decisions this change rests on; design.md, Design rules: Agent access; design.md, Technical decisions: T7

#### Scenario: A bot user's PAT acts for the bot user

- **WHEN** the company's GitHub machine account `acme-ci-bot` signs in through an invite, an admin sets its bot flag, and it creates a PAT in the web UI
- **THEN** calls with its PAT act for that bot user
- **AND** their provenance names that bot user as the accountable human

#### Scenario: The bot user is reminded before expiry

- **WHEN** a bot user's PAT expires on 2026-12-31
- **THEN** the bot user's web inbox shows a reminder about it on 2026-12-17 and again on 2026-12-28

#### Scenario: The client credentials grant is not offered

- **WHEN** a client asks the install's token endpoint for a token with `grant_type=client_credentials`
- **THEN** Tiehall refuses the request with the OAuth error `unsupported_grant_type`

### Requirement: CI authenticates with GitHub Actions OIDC bound to registered repositories

The contract-report operation SHALL accept a GitHub Actions OIDC token directly, with no token exchange. Tiehall SHALL check that the token's issuer is GitHub Actions (`https://token.actions.githubusercontent.com`), that its audience is exactly the install's public base URL, such as `https://tiehall.example.com`, and that it has not expired; a token that fails any of these checks SHALL be refused with HTTP 401 and the error `invalid_token`. Tiehall SHALL refuse a token whose `jti` it has already seen with HTTP 401 and the error `invalid_token`, as it refuses any other invalid bearer token. Tiehall SHALL check that the token's `repository_id` and `repository_owner_id` match the repository of an API registered as the contract-changes capability defines. The admin who registers an API MAY bind it to one `job_workflow_ref`; for an API with that binding, Tiehall SHALL accept a report only from a token whose `job_workflow_ref` matches it. A CI caller SHALL be able to call only `contract.report`, only for the APIs registered to its repository, and SHALL act for no user. A call from a CI caller to any other operation, a report for an API that is not registered to the token's repository, and a report for a bound API from any other workflow SHALL each be refused with HTTP 403, as the public-api capability's error model defines for a CI caller. The membership re-check and the PAT switch SHALL NOT apply to CI callers.

Source: D14; D28 #1, #44; D29 (7); design.md, Decisions this change rests on; design.md, Design rules: Agent access; design.md, Technical decisions: T7

#### Scenario: A report from a registered repository is accepted

- **WHEN** the contract Action calls `contract.report` on `https://tiehall.example.com` with an unexpired OIDC token whose audience is `https://tiehall.example.com` and whose `repository_id` and `repository_owner_id` match a registered API
- **THEN** Tiehall accepts the report for that API

#### Scenario: A token for another audience is refused

- **WHEN** the contract Action calls `contract.report` on `https://tiehall.example.com` with an OIDC token whose audience is `https://tiehall.other.example`
- **THEN** Tiehall refuses the call with HTTP 401 and the error `invalid_token`
- **AND** no report is taken

#### Scenario: An unregistered repository is refused

- **WHEN** an OIDC token's `repository_id` matches no registered API
- **THEN** Tiehall refuses the report with HTTP 403 and an RFC 9457 problem

#### Scenario: A replayed token is refused

- **WHEN** a second call presents an OIDC token with a `jti` Tiehall has already accepted
- **THEN** Tiehall refuses the second call with HTTP 401 and the error `invalid_token`
- **AND** no report is taken from the second call

#### Scenario: A bound API accepts only its workflow

- **WHEN** the admin who registered `payments-api` bound it to the `job_workflow_ref` `acme/payments/.github/workflows/contract.yml@refs/heads/main`, and a run of `acme/payments/.github/workflows/nightly.yml@refs/heads/main` in the same repository reports for `payments-api`
- **THEN** Tiehall refuses the report with HTTP 403 and an RFC 9457 problem
- **AND** a report from a run of `contract.yml` on `main` is accepted

#### Scenario: An API without a binding accepts any workflow in its repository

- **WHEN** `payments-api` has no `job_workflow_ref` binding, and a run of any workflow in its registered repository reports for it with a valid OIDC token
- **THEN** Tiehall accepts the report

#### Scenario: A CI token cannot do anything else

- **WHEN** a caller authenticated with a GitHub Actions OIDC token calls any operation other than `contract.report` through `/api/v1`
- **THEN** the call is refused with HTTP 403 and an RFC 9457 problem

#### Scenario: The PAT switch does not block CI

- **WHEN** an admin has turned the PAT switch off, and a registered repository's Action sends a valid contract report
- **THEN** Tiehall accepts the report

### Requirement: Outbound calls use Tiehall's own credentials

Calls Tiehall makes to GitHub SHALL use the install's GitHub App installation tokens, and calls to Jira SHALL use the Jira bot account's API token, as the tracker-mirrors capability defines. Tiehall SHALL NOT use or forward a token that a client presented to Tiehall.

Source: design.md, Design rules: Agent access; design.md, Self-hosting decisions: S4; design.md, Self-hosting decisions: S8

#### Scenario: Linking a PR does not forward the agent's token

- **WHEN** an agent links a PR to a request through `/mcp`
- **THEN** Tiehall reads the PR from GitHub with an installation token of the install's GitHub App
- **AND** the agent's Tiehall token is not sent to GitHub

#### Scenario: A Jira mirror update uses the bot's token

- **WHEN** an agent's claim of FE-142 through `/api/v1` makes Tiehall create or update the Jira mirror issue of FE-142
- **THEN** Tiehall calls Jira with the bot account's API token
- **AND** the agent's token is not sent to Jira

### Requirement: Sign-in is tested on the four main clients

Tiehall's maintainers SHALL run a recurring client matrix, by hand because it needs real client accounts, that tests how Claude Code, Cursor, Codex and Copilot sign in to an install and list its tools: through a Client ID Metadata Document and through Dynamic Client Registration, including with metadata-document fetching switched off, on MCP protocol versions 2026-07-28 and 2025-11-25.

Source: design.md, Design rules: Agent access; design.md, Technical decisions: T17; design.md, Self-hosting decisions: S13

#### Scenario: The matrix records each sign-in path

- **WHEN** the client matrix runs
- **THEN** for each of Claude Code, Cursor, Codex and Copilot, on each protocol version, with metadata-document fetching on and off, it records whether the client could sign in, whether it identified itself through a metadata document or through DCR, and whether it listed the tools

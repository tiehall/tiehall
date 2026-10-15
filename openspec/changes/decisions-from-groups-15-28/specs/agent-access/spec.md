# Spec Delta: agent-access

## Purpose

States the authorization server's rate limits, scopes, resource and client metadata rules, the CLI's one grant and its approval page, the bounds and timing of personal access tokens, the order of a CI caller's checks and the workflow binding, and whom a polled change acts for. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Tiehall is the authorization server for agent clients

Each install SHALL act as its own OAuth 2.1 authorization server for MCP clients and the `tiehall` CLI, with the install's public base URL, such as `https://tiehall.example.com`, as its issuer. It SHALL publish OAuth 2.0 Protected Resource Metadata (RFC 9728) under `/.well-known/` that names that issuer as the authorization server, and authorization server metadata that advertises `client_id_metadata_document_supported` while metadata-document fetching is on. The authorization server SHALL offer the authorization code grant with refresh tokens to MCP clients and the device authorization grant only to the CLI, and SHALL NOT offer the client credentials grant. An access token the install issues for its resource SHALL be accepted by both `/mcp` and `/api/v1`. Checking an access token SHALL make no outbound network call. From one client address, as the install sees it after the proxies the operator names, the token endpoint SHALL take at most 20 calls in any minute besides the CLI's polls, the authorization endpoint at most 30 and the revocation endpoint at most 30, and the token endpoint SHALL take at most 60 of the CLI's polls in any minute, whatever device codes they carry. Each limit SHALL count the calls it took from the address in the past minute, so that calls older than a minute never count, however steadily the address calls; the next call over a limit SHALL be refused with 429, the problem type `rate-limited` and a `Retry-After` header, as the public-api capability's error model defines for a limit, SHALL change nothing and SHALL NOT be counted. A token call SHALL be one of the CLI's polls only when its body is a form, sent with the media type `application/x-www-form-urlencoded` exactly, parameters aside, that names the device code grant and the CLI's client id, each once; a body the token endpoint reads as JSON SHALL NOT be a poll, whatever text it holds. Registration has its own limit, as the requirement on Dynamic Client Registration defines.

Source: D8; D55 (14); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: The token endpoint's limit

- **WHEN** the address `203.0.113.5` has made 20 calls to the token endpoint within one minute other than the CLI's polls, such as refresh token exchanges, and makes another such call in that minute
- **THEN** Tiehall answers 429 with a `Retry-After` header
- **AND** issues no token for that call
- **AND** a call to the token endpoint from `198.51.100.7` in that minute is not refused for the limit

#### Scenario: A steady caller is not refused for the token endpoint's limit

- **WHEN** the clients behind the address `203.0.113.5` refresh their tokens once every 50 seconds between them, for an hour
- **THEN** none of their calls is refused for a limit

#### Scenario: The CLI's polls are not refused for the token endpoint's limit

- **WHEN** `tiehall login https://tiehall.example.com`, run at the address `203.0.113.5`, polls the token endpoint every 5 seconds for the 10 minutes its device code lives
- **THEN** none of its polls is refused for a limit
- **AND** each poll before the code is approved is answered with the error `authorization_pending`

#### Scenario: The CLI's polls have a limit of their own

- **WHEN** the address `203.0.113.5` has polled the token endpoint 60 times within one minute, with the CLI's client id and device codes that no one was issued, and polls again in that minute with a pending device code
- **THEN** Tiehall answers 429 with a `Retry-After` header
- **AND** a poll with the same device code from `198.51.100.7` in that minute is answered with `authorization_pending`, not `slow_down`, since the refused poll changed nothing

### Requirement: Six kinds of caller

Every call to a Tiehall operation SHALL come from exactly one of six kinds of caller, each authorized as follows:
- a web session, which acts for the signed-in user within the user's role, and whose actions are recorded with the actor kind `web_session`, as the requests capability defines;
- an OAuth token, held by an MCP client or by the CLI after its device flow, which acts for the user who approved the client, within the token's scopes and the user's role;
- a personal access token, which acts for the user who created it, within its scopes and the user's role;
- a CI caller, authenticated with a GitHub Actions OIDC token, which acts for a registered API's repository and is limited as the requirement on CI below defines;
- a system job, which acts for no user and runs only Tiehall's internal system commands, which are never commitments;
- an integration event, meaning a verified GitHub or Jira webhook or a change Tiehall reads from GitHub or Jira by polling or reconciliation, as the tracker-mirrors capability defines, which runs only internal commands, and which acts for the mapped user, the Tiehall user of the GitHub account or the linked Atlassian account that the webhook or the change names as the one that made it, only while that user is a member of the install when the command runs. For an account whose user is not a member, whether removed or never admitted, for an account that maps to no user, and for a change that names no account that made it, such as a change to a pull request that Tiehall reads from GitHub by polling, it SHALL act for no user. A change Tiehall reads by polling or reconciliation names the account that made it only where GitHub's read names one, as it names the account that closed an issue (`closed_by`); such a change SHALL act for that account's user under the same rule.

A system job or an integration event SHALL NOT be able to run an operation that is offered on REST, MCP or the CLI. An operation that no surface offers, an internal command, SHALL run only for a web session, through the web UI, or for a system job or an integration event, through the worker; an OAuth token, a personal access token or a CI caller SHALL NOT be able to run one. Every action guarded by the confirmation step, as the agent-safety capability defines, SHALL be an internal command, so it runs only for a web session. The operator commands that the self-host-install capability defines run on the host, outside these six kinds of caller, and are the one exception the agent-safety capability makes to the confirmation step.

Source: D23; D28 #75; D50 (10); D55 (77); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A removed member's GitHub activity acts for no user

- **WHEN** an admin has removed Dana from the install, and a verified delivery from a connected installation reports a change that Dana's GitHub account made
- **THEN** what Tiehall records for the change has the actor kind `integration`
- **AND** it names no user as the one it acted for

#### Scenario: A member's GitHub activity acts for them

- **WHEN** a verified delivery from a connected installation reports a change that the GitHub account of Lee, a member of the install, made
- **THEN** what Tiehall records for the change has the actor kind `integration`
- **AND** it names Lee's user as the one it acted for

#### Scenario: A removal while the delivery is processed

- **WHEN** a verified delivery from a connected installation reports a change that Dana's GitHub account made, and an admin removes Dana after Tiehall has read the delivery and before the command the change leads to runs
- **THEN** what Tiehall records for the change has the actor kind `integration`
- **AND** it names no user as the one it acted for

#### Scenario: A change read by polling acts for no user

- **WHEN** GitHub runs in polling mode, and the poll reads a change that Lee, a member of the install, made to a pull request in a covered repository
- **THEN** what Tiehall records for the change has the actor kind `integration`
- **AND** it names no user as the one it acted for

#### Scenario: A polled close acts for the account that closed the issue

- **WHEN** GitHub runs in polling mode, and the poll reads that the GitHub mirror issue of FE-142 was closed, with GitHub naming the account of Ayşe, a member of the install, as the one that closed it
- **THEN** what Tiehall records for the close has the actor kind `integration`
- **AND** it names Ayşe's user as the one it acted for

### Requirement: Clients identified by a Client ID Metadata Document are preferred

While metadata-document fetching is on, Tiehall SHALL accept clients whose `client_id` is an HTTPS URL pointing to a Client ID Metadata Document, and SHALL treat such a client as identified by that URL only when the fetched document's `client_id` equals the URL exactly. Tiehall SHALL fetch metadata documents only through the outbound fetcher that the agent-safety capability defines, which refuses loopback, private, link-local and cloud metadata addresses and redirects to them. Tiehall SHALL fetch at most 60 metadata documents per minute from any one host; an authorization request that Tiehall cannot check because that host's limit is used up SHALL be refused with HTTP 429 and a `Retry-After` header. A `client_id` URL SHALL have at most 1,024 characters, and a document SHALL give a client name of 1 to 100 characters and at most 10 redirect URIs of at most 2,048 characters each. An authorization request whose `client_id` URL is longer, which Tiehall SHALL refuse without fetching anything, or whose document breaks one of these bounds, SHALL be refused with the OAuth error `invalid_client`, and SHALL never be answered with a 500.

Source: D28 #43; D55 (25); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A client_id URL over its bound

- **WHEN** a client starts authorization with a `client_id` URL of 1,025 characters
- **THEN** Tiehall refuses the authorization request with the OAuth error `invalid_client`
- **AND** fetches no document
- **AND** the answer is not a 500

#### Scenario: A document over its bounds

- **WHEN** the document served at a client's `client_id` URL gives a client name of 101 characters, or lists 11 redirect URIs
- **THEN** Tiehall refuses the authorization request with the OAuth error `invalid_client`
- **AND** no consent screen is shown

### Requirement: Dynamic Client Registration stays on, limited and unverified

Tiehall SHALL keep Dynamic Client Registration (RFC 7591) on, SHALL accept at most 10 registrations per hour from one IP address, counting an IPv6 client by its /64 prefix so that every address in one /64 shares the limit, and SHALL remove a registered client that has never been used 7 days after it registered. A registration beyond that limit SHALL be refused with HTTP 429 and a `Retry-After` header. Every registration request that reaches the registration endpoint SHALL count toward the limit, including one refused for its metadata. A registration's client name, when it gives one, SHALL have 1 to 100 characters, and a registration SHALL list at most 10 redirect URIs of at most 2,048 characters each; a registration outside these bounds SHALL be refused with 400 and the OAuth error `invalid_client_metadata`, SHALL register nothing and SHALL never be answered with a 500. A registration that names no `application_type`, and whose every redirect URI is an `http` URI on `localhost`, `127.0.0.1` or `[::1]` or a URI with a native app's own scheme, SHALL be taken as a native public client's (RFC 8252), so its loopback redirect URIs and its app's scheme SHALL be accepted; any other registration SHALL keep the type it names, or the web type, whose redirect URIs must be `https` URIs. A redirect URI SHALL have a native app's own scheme, which needs no dot, such as `cursor:`, `vscode:` or `com.example.app:`, only when it is written in printable ASCII with no space, holds no fragment and no user information, has a scheme that is none of `http`, `https`, `ws`, `wss`, `ftp`, `file`, `javascript`, `vbscript`, `data`, `blob`, `about`, `filesystem`, `view-source`, `mailto`, `tel` and `sms`, and has, after its scheme's colon, a path, as in `com.example.app:/callback`, or `//`, a host and a path, as in `cursor://anysphere.cursor-mcp/oauth/callback`. A registration that names `native` SHALL be refused with 400 and the OAuth error `invalid_redirect_uri`, and SHALL register nothing, when one of its redirect URIs is neither an `http` nor an `https` URI and has no native app's own scheme. The IP address SHALL be the client's address as the install sees it, taking forwarded headers only from the proxies the operator names, as the self-host-install capability defines. Because a DCR client's name is self-asserted and each installation of a client registers a new id, Tiehall SHALL treat every DCR client as unverified.

Source: D28 #43; D55 (15), (16), (24), (25); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A registration of local redirect URIs is a native client's

- **WHEN** a client registers through DCR with no `application_type` and the one redirect URI `http://127.0.0.1:33418/callback`
- **THEN** Tiehall issues a client id
- **AND** the client is registered as a native public client

#### Scenario: Cursor's registration is a native client's

- **WHEN** a client registers through DCR with no `application_type` and the one redirect URI `cursor://anysphere.cursor-mcp/oauth/callback`
- **THEN** Tiehall issues a client id
- **AND** the client is registered as a native public client with that redirect URI
- **AND** a signed-in member's authorization request with that redirect URI and a PKCE `S256` challenge reaches the consent screen, while one with no code challenge is refused with the OAuth error `invalid_request`

#### Scenario: The web's and a browser's own schemes are no app's own

- **WHEN** a client registers through DCR, with no `application_type` or with `native`, and the one redirect URI `ws://agent.vendor.example/callback`, `javascript://agent.vendor.example/%0Aalert(1)` or `mailto:agent@vendor.example`
- **THEN** Tiehall refuses the registration with 400 and the OAuth error `invalid_redirect_uri`
- **AND** issues no client id

#### Scenario: An app's scheme beside an https redirect URI keeps the web type

- **WHEN** a client registers through DCR with no `application_type` and the redirect URIs `cursor://anysphere.cursor-mcp/oauth/callback` and `https://agent.vendor.example/callback`
- **THEN** Tiehall takes the registration as a web client's and refuses it with 400 and the OAuth error `invalid_redirect_uri`
- **AND** issues no client id

#### Scenario: A refused registration still counts

- **WHEN** the address `203.0.113.5` has sent 9 registrations within the past hour, one of them refused for a redirect URI Tiehall does not take, and then sends two valid registrations
- **THEN** the first of the two is accepted
- **AND** the second is refused with HTTP 429 and a `Retry-After` header

#### Scenario: IPv6 addresses in one /64 share the limit

- **WHEN** the address `2001:db8:1:2::5` has registered 10 clients within the past hour, and `2001:db8:1:2::9` sends a registration
- **THEN** Tiehall refuses it with HTTP 429 and a `Retry-After` header
- **AND** a registration from `2001:db8:1:3::5` is accepted

#### Scenario: Registration metadata over its bounds

- **WHEN** a client registers through DCR with a client name of 101 characters, or with 11 redirect URIs
- **THEN** Tiehall refuses the registration with 400 and the OAuth error `invalid_client_metadata`
- **AND** issues no client id, and the answer is not a 500

### Requirement: Authorization requests use PKCE S256, resource indicators and the iss parameter

In the authorization code flow, Tiehall SHALL require PKCE with the `S256` method and SHALL refuse requests that carry no code challenge or use the `plain` method. It SHALL take the RFC 8707 `resource` parameter and bind the issued access token's audience to that resource. An authorization request, and the token request that follows it, that carries no `resource` parameter SHALL be taken as naming the install's one resource, `TIEHALL_URL/mcp`, so that the token's audience is that resource and both `/mcp` and `/api/v1` accept it. Every authorization response SHALL carry the `iss` parameter (RFC 9207) set to the install's issuer.

Source: D55 (23); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A request without resource gets the install's resource

- **WHEN** a client completes authorization and exchanges its code with no `resource` parameter in either request
- **THEN** the issued access token's audience is `https://tiehall.example.com/mcp`
- **AND** a call to `/api/v1` with that token is accepted

### Requirement: Missing and insufficient tokens get standard challenges

A call to `/mcp` or `/api/v1` without an access token SHALL get HTTP 401 with a `WWW-Authenticate` challenge that points to the protected resource metadata and carries a scope hint. The install has one protected resource, `TIEHALL_URL/mcp`, whose metadata is served at `/.well-known/oauth-protected-resource/mcp`; `/api/v1` shares that resource, so its challenge SHALL point to that same metadata. A call with an expired, malformed or otherwise invalid token SHALL get HTTP 401 with a challenge that carries `error="invalid_token"` (RFC 6750). A call whose token lacks a scope the operation needs SHALL get HTTP 403 with the error `insufficient_scope` and the needed scope in the `WWW-Authenticate` challenge, and the operation SHALL NOT run.

Source: D55 (17); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: The API's challenge points to the one resource

- **WHEN** a client calls `https://tiehall.example.com/api/v1/inbox` without an `Authorization` header
- **THEN** the response is HTTP 401
- **AND** its `WWW-Authenticate` header points to `https://tiehall.example.com/.well-known/oauth-protected-resource/mcp`

### Requirement: OAuth scopes are coarse

Tiehall SHALL offer exactly three OAuth scopes: `requests:read`, `requests:write` and `contracts:report`. There SHALL be no `admin` scope, because admin operations run only in the web UI; an authorization request that asks for a scope Tiehall does not offer SHALL be refused with the OAuth error `invalid_scope`, except `offline_access`, which Tiehall SHALL ignore: it SHALL NOT be listed in `scopes_supported`, shown on the consent screen or carried among a token's scopes, and every grant SHALL bring a refresh token whether or not the client asked for one. An authorization request that names no scope, or only `offline_access`, SHALL be granted `requests:read` and `requests:write`, which the consent screen SHALL show before the person approves; `contracts:report` SHALL be granted only to a request that names it. `contract.report` itself SHALL accept only the CI caller, as the requirement on CI below and the contract-changes capability define, so no OAuth token or personal access token can report contract changes, whatever scopes it carries. The `contracts:report` scope SHALL guard attaching classified contract changes to a request by hand: the MCP tool `attach_contract_changes` and its REST operation SHALL need `contracts:report`, as the contract-changes capability defines.

Source: D28 #48; D30 (3); D55 (12), (13); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: offline_access is ignored

- **WHEN** a client sends an authorization request whose `scope` is `requests:read offline_access`, and the person approves it
- **THEN** the consent screen showed `requests:read` and not `offline_access`
- **AND** the issued access token carries `requests:read` alone
- **AND** the client receives a refresh token

#### Scenario: A request that names no scope

- **WHEN** a client sends an authorization request with no `scope`, and the person approves it
- **THEN** the consent screen showed `requests:read` and `requests:write`
- **AND** the issued access token carries those two scopes and not `contracts:report`

### Requirement: The consent screen shows who is asking

The consent screen SHALL show the client's name; for a client identified by a Client ID Metadata Document, its verified host; for a DCR client, an "unverified client" warning; and where the sign-in ends: the host name of the redirect URI, or, for a redirect URI with a native app's own scheme, that scheme and the whole URI, without showing the URI's host as a host the browser returns to. It SHALL show a warning when every redirect URI of the client is on localhost. The consent screen SHALL be served only to a signed-in member, as the sign-in capability defines, and SHALL ask for no choice of org, because an install has one org.

Source: D55 (15); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The redirect host name is shown

- **WHEN** a client's redirect URI is `https://agent.vendor.example/callback`
- **THEN** the consent screen shows the host name `agent.vendor.example`
- **AND** it asks for no choice of org

#### Scenario: Localhost-only redirect URIs are flagged

- **WHEN** every redirect URI of a client is on `localhost`
- **THEN** the consent screen shows a warning about localhost redirect URIs

#### Scenario: An app's own scheme is shown with its whole URI

- **WHEN** a DCR client's redirect URI is `cursor://anysphere.cursor-mcp/oauth/callback`
- **THEN** the consent screen shows the scheme `cursor:` and the URI `cursor://anysphere.cursor-mcp/oauth/callback` as where the sign-in ends
- **AND** it does not show `anysphere.cursor-mcp` as a host the browser returns to

### Requirement: The CLI signs in through a restricted device flow

The `tiehall` CLI SHALL be a pre-registered public client with a fixed client id, and SHALL sign in with the OAuth device authorization grant (RFC 8628) when the user runs `tiehall login <url>` with the install's URL. The device flow SHALL accept only the CLI's client id; a device authorization request from any other client, including one registered through DCR or identified by a metadata document, SHALL be refused with the OAuth error `unauthorized_client`. Device codes SHALL expire 10 minutes after they are issued; the device approval page SHALL refuse an expired code with HTTP 409, as the public-api capability's error model defines for a state conflict, and the CLI's token request SHALL then get the error `expired_token`. The token the CLI receives SHALL have the install's MCP resource as its only audience. No device-flow endpoint SHALL return a web session or a session token. Each member SHALL hold one grant for the CLI, which every `tiehall login` they approve, on any machine, updates; revoking that grant on the "Connected agents and tokens" page SHALL sign the CLI out on every machine, and the page SHALL say so beside the CLI's grant.

Source: D55 (21); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: One CLI grant for every machine

- **WHEN** Ana has approved `tiehall login https://tiehall.example.com` on two machines, and opens "Connected agents and tokens"
- **THEN** the page lists one grant for the CLI, and says that revoking it signs the CLI out on every machine
- **AND** once Ana revokes it, the refresh token of each machine's CLI is refused with the OAuth error `invalid_grant`

### Requirement: The device approval page cannot be prefilled

The device approval page SHALL be served only to a signed-in member, SHALL ignore any user code carried in its URL, so the user types the code the CLI printed, and SHALL show the IP address and the time of the request that started the flow, with the text "continue only if you just ran `tiehall login`". The IP address SHALL be the one the install sees, taking forwarded headers only from the proxies the operator names. The page SHALL store nothing until the user approves. Approving SHALL use the confirmation step, as the agent-safety capability defines; an approval without a valid confirmation SHALL be refused with HTTP 403. The page SHALL ask for no choice of org. The review page of the CLI's approval SHALL be reached only from the device approval page: a request for that review page's own URL, with an input or without, SHALL be sent to the device approval page, which asks for the code. A typed code SHALL be taken in lower or upper case, with or without its dash, and with any spaces removed. Each approval SHALL be recorded as a security event, as the activity-log capability defines.

Source: D55 (22); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: The approval's review page cannot be opened from a link

- **WHEN** a signed-in member opens the URL of the review page of the CLI's approval with an input that names a user code
- **THEN** they are sent to the device approval page
- **AND** its code field is empty

#### Scenario: A code typed in another form

- **WHEN** `tiehall login https://tiehall.example.com` printed the code `WDJB-MJHT`, and the user types `wdjb mjht` on the device approval page
- **THEN** the page shows the IP address and time of that `tiehall login` request, as it does for `WDJB-MJHT`

### Requirement: Personal access tokens are scoped, expiring and created in the web UI

Tiehall SHALL issue personal access tokens (PATs) whose value starts with `th_pat_`, for hosts that can only send a header. Every PAT SHALL carry one or more of the three scopes and SHALL expire no later than 90 days after creation, or earlier when an admin has set a shorter maximum lifetime; a request for a longer lifetime SHALL be refused with HTTP 400, as the public-api capability's error model defines for a value outside what the install's settings allow. Tiehall SHALL keep only a hash of each PAT, so its value is shown once, at creation, and never again. Every PAT SHALL carry a label its owner writes, of 1 to 100 characters with no control character; a label outside these bounds SHALL be refused with 400 and SHALL create no token. The label is its owner's own text: pages SHALL show it quoted and escaped, and no reminder SHALL name it. A user SHALL create a PAT only in the web UI and with the confirmation step, as the agent-safety capability defines; no agent surface offers PAT creation. Each PAT created and each PAT revoked SHALL be recorded as a security event, as the activity-log capability defines.

Source: D55 (18); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A label outside its bounds

- **WHEN** a user asks for a PAT whose label has 101 characters, or holds the character U+001B
- **THEN** Tiehall refuses to create it with HTTP 400
- **AND** no PAT is created

### Requirement: An admin sets the PAT switch and the maximum lifetime

The install SHALL have a PAT switch, which is on in a new install, and a maximum PAT lifetime of at most 90 days, which is 90 days in a new install. Only an admin SHALL change either, only in the web UI and with the confirmation step, as the agent-safety capability defines; a maximum above 90 days SHALL be refused with HTTP 400. While the switch is off, every call with a PAT SHALL be refused with HTTP 403, including calls with PATs created while it was on, and creating a PAT SHALL be refused with 403 and the problem type `personal-access-tokens-off` and SHALL create nothing; the "Connected agents and tokens" page SHALL then offer no form to create one, and SHALL say that an admin has switched them off. Each change SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #4; D55 (19); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: No PAT is created while the switch is off

- **WHEN** an admin has turned the PAT switch off, and Lee opens "Connected agents and tokens" and then sends the web UI's request that creates a PAT, with a valid confirmation
- **THEN** the page offers no form to create a PAT and says that an admin has switched them off
- **AND** the request is refused with 403 and the problem type `personal-access-tokens-off`
- **AND** no PAT is created

### Requirement: PAT owners are reminded before expiry

Tiehall SHALL remind the owner of every personal access token 14 days before the PAT expires and again 3 days before it expires. Each reminder SHALL appear in the owner's web inbox, and SHALL also be sent to the owner by email when SMTP is set up. The days SHALL be UTC days, counted back from the UTC day the PAT expires. A reminder whose day has come and that the PAT has not had yet SHALL be made at the reminder job's next run, so a stopped worker catches up; a PAT created after a reminder's day SHALL get no such reminder; only a PAT whose owner is a member of the install SHALL be reminded. A reminder SHALL stay in the standing list of its owner's web inbox until the PAT expires or is revoked, and neither the reminder nor its email SHALL name the PAT's label.

Source: D28 #46; D55 (20); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: Two reminders before expiry

- **WHEN** Lee's PAT expires on 2026-12-31 and SMTP is set up
- **THEN** Lee's web inbox shows a reminder about it on 2026-12-17 and again on 2026-12-28
- **AND** Lee gets an email about it on each of those days

#### Scenario: Without SMTP the reminders stay in the inbox

- **WHEN** Lee's PAT expires on 2026-12-31 and SMTP is not set up
- **THEN** Lee's web inbox shows the reminders on 2026-12-17 and 2026-12-28
- **AND** no email is sent

#### Scenario: A reminder missed while the worker was stopped

- **WHEN** Lee's PAT expires on 2026-12-31, and the worker is stopped from 2026-12-16 until 2026-12-18
- **THEN** Lee's web inbox shows the first reminder on 2026-12-18, at the reminder job's first run after the worker starts

#### Scenario: A PAT created inside the window

- **WHEN** Lee creates on 2026-12-20 a PAT that expires on 2026-12-31
- **THEN** Lee gets no reminder about it before 2026-12-28
- **AND** Lee's web inbox shows a reminder about it on 2026-12-28

#### Scenario: A reminder leaves with its PAT and never names its label

- **WHEN** Lee's PAT, labelled "deploy bot", expires on 2026-12-31, its first reminder was shown on 2026-12-17, and Lee revokes the PAT on 2026-12-20
- **THEN** neither the reminder nor its email contains "deploy bot"
- **AND** from 2026-12-20 on, Lee's web inbox no longer lists the reminder

#### Scenario: A removed member's PAT is not reminded of

- **WHEN** Dana has been removed from the install, and Dana's PAT expires 14 days later
- **THEN** no reminder about it is made

### Requirement: CI authenticates with GitHub Actions OIDC bound to registered repositories

The contract-report operation SHALL accept a GitHub Actions OIDC token directly, with no token exchange. Tiehall SHALL check that the token's issuer is GitHub Actions (`https://token.actions.githubusercontent.com`), that its audience is exactly the install's public base URL, such as `https://tiehall.example.com`, and that it has not expired; a token that fails any of these checks SHALL be refused with HTTP 401 and the error `invalid_token`. Tiehall SHALL refuse a token whose `jti` it has already seen with HTTP 401 and the error `invalid_token`, as it refuses any other invalid bearer token. Tiehall SHALL check that the token's `repository_id` and `repository_owner_id` match the repository of an API registered as the contract-changes capability defines. The admin who registers an API MAY bind it to one workflow, named by its repository and the path of its workflow file, such as `acme/payments/.github/workflows/contract.yml`; for an API with that binding, Tiehall SHALL accept a report only from a token whose `job_workflow_ref`, without the `@` and the ref that follow it, equals the binding. When the token's `ref` claim is `refs/pull/<n>/merge`, as on a run for a pull request, Tiehall SHALL accept a report only for pull request `n`. A CI caller SHALL be able to call only `contract.report`, only for the APIs registered to its repository, and SHALL act for no user. A call from a CI caller to any other operation, a report for an API that is not registered to the token's repository, and a report for a bound API from any other workflow SHALL each be refused with HTTP 403, as the public-api capability's error model defines for a CI caller. A report for a pull request other than the one its run was for SHALL be refused with 403 in the same way. The membership re-check and the PAT switch SHALL NOT apply to CI callers. Tiehall SHALL check a CI caller's call in this order. A call to an operation other than `contract.report` SHALL be refused with 403 before GitHub Actions' keys are read, so it never gets a 502. For `contract.report`, the token's signature, issuer, audience and expiry SHALL be checked first, and a failure refused with 401 and the error `invalid_token`, or with 502 and the problem type `integration-unavailable` when GitHub Actions' keys cannot be read within 10 seconds. Then a token whose repository has no registered API SHALL be refused with 403 without recording its `jti`, so the same token is refused with 403 again, not with 401. Then a token whose `jti` Tiehall has already recorded SHALL be refused with 401 and the error `invalid_token`. Otherwise its `jti` SHALL be recorded, and so spent, before the report itself is checked, so a report refused after that, for its input, its API, its workflow or its pull request, SHALL leave its token spent.

Source: D14; D28 #1, #44; D29 (7); D55 (58), (61); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

- **WHEN** the admin who registered `payments-api` bound it to the workflow `acme/payments/.github/workflows/contract.yml`, and a run of `acme/payments/.github/workflows/nightly.yml@refs/heads/main` in the same repository reports for `payments-api`
- **THEN** Tiehall refuses the report with HTTP 403 and an RFC 9457 problem
- **AND** a report from a run of `contract.yml` on `main`, whose `job_workflow_ref` is `acme/payments/.github/workflows/contract.yml@refs/heads/main`, is accepted

#### Scenario: An API without a binding accepts any workflow in its repository

- **WHEN** `payments-api` has no `job_workflow_ref` binding, and a run of any workflow in its registered repository reports for it with a valid OIDC token
- **THEN** Tiehall accepts the report

#### Scenario: A CI token cannot do anything else

- **WHEN** a caller authenticated with a GitHub Actions OIDC token calls any operation other than `contract.report` through `/api/v1`
- **THEN** the call is refused with HTTP 403 and an RFC 9457 problem

#### Scenario: The PAT switch does not block CI

- **WHEN** an admin has turned the PAT switch off, and a registered repository's Action sends a valid contract report
- **THEN** Tiehall accepts the report

#### Scenario: A pull request's run reports for its own pull request

- **WHEN** `payments-api` is bound to the workflow `acme/payments/.github/workflows/contract.yml`, and a run for PR #310 presents a token whose `job_workflow_ref` is `acme/payments/.github/workflows/contract.yml@refs/pull/310/merge` and whose `ref` is `refs/pull/310/merge`
- **THEN** Tiehall accepts a report from it for PR #310
- **AND** refuses with HTTP 403 a report that another token of the same run sends for PR #311

#### Scenario: A repeated token from an unregistered repository

- **WHEN** a run in a repository that no registered API is bound to calls `contract.report` twice with the same valid OIDC token
- **THEN** Tiehall refuses both calls with HTTP 403
- **AND** neither call is refused with 401

#### Scenario: A refused report spends its token

- **WHEN** the contract Action calls `contract.report` from a registered repository with a valid OIDC token and an input that fails the schema, and then calls again with the same token and a valid input
- **THEN** the first call is refused with HTTP 400
- **AND** the second is refused with HTTP 401 and the error `invalid_token`

#### Scenario: Another operation does not wait for GitHub Actions' keys

- **WHEN** GitHub Actions' keys cannot be read, and a caller with a GitHub Actions OIDC token calls `requests.create` through `/api/v1`
- **THEN** Tiehall refuses the call with HTTP 403 and an RFC 9457 problem
- **AND** the answer is not 502

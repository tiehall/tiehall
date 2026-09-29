# Spec Delta: sign-in

## Purpose

States the rate limit on the sign-in callback, which GitHub token a sign-in uses and for what, what Tiehall keeps of a refused sign-in and how a browser sees the refusal, and how long a web session lasts. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: GitHub is the only way to sign in

Tiehall SHALL let people sign in only with a GitHub account, through the user authorization of the install's own GitHub App, which the self-host-install capability creates during setup. Tiehall MUST NOT offer sign-in with a password, a magic link, an email code, a passkey or any other identity provider, and MUST NOT store passwords. Tiehall SHALL serve no sign-in route other than the GitHub one: a request to any other sign-in route, such as an email-and-password or a passkey sign-in, SHALL answer 404, as the public-api capability's error model defines for a route the install does not serve, and SHALL create no session. An Atlassian account SHALL NOT be a way to sign in; linking one is defined by the tracker-mirrors capability. Before setup is complete, the only sign-in SHALL be the one from the setup session, as the self-host-install capability defines. GitHub's return to the sign-in callback, `/api/auth/callback/github`, the one route of the sign-in service served over HTTP, SHALL take at most 100 calls from one client address in 10 seconds, in every environment the install runs in; a further call SHALL be refused with 429 and a `Retry-After` header, as the public-api capability's error model defines for a rate limit, and SHALL create no session and no Tiehall user. Calls from another client address SHALL be answered as before.

Source: D28 #1; D37; D50 (20); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The sign-in page offers GitHub only

- **WHEN** a person who is not signed in opens `https://tiehall.example.com` on an install whose setup is complete
- **THEN** they are offered sign-in with GitHub
- **AND** no other way to sign in is offered
- **AND** no page asks them for a password

#### Scenario: No route signs anyone in another way

- **WHEN** the CI route test lists every route of the install's sign-in service
- **THEN** no route accepts an email address and a password, a magic link, an email code or a passkey assertion
- **AND** every sign-in route other than the GitHub one answers 404 and creates no session

#### Scenario: A password sign-in attempt creates no session

- **WHEN** a client sends an email address and a password, or a passkey assertion, to any route of `https://tiehall.example.com` in the form of a sign-in request
- **THEN** no session is created
- **AND** no Tiehall user is created

#### Scenario: The sign-in callback is rate limited

- **WHEN** a client sends 101 requests to `https://tiehall.example.com/api/auth/callback/github` from the address 198.51.100.77 within 10 seconds, and then one from the address 198.51.100.78
- **THEN** the 101st request is answered 429 with a `Retry-After` header and creates no session
- **AND** the request from 198.51.100.78 is not answered 429

### Requirement: Tiehall keeps no GitHub user token

Sign-in SHALL use GitHub's user authorization only to learn which GitHub account signed in and that account's primary verified email address. The user access token that GitHub issues for a sign-in SHALL be used only during that sign-in, for one read of the account that signed in and one read of its email addresses, and for nothing else. Tiehall MUST NOT keep the GitHub user access token or its refresh token once sign-in has completed, and SHALL make every other call to GitHub with its App's own credentials, as the agent-access capability defines for outbound calls, never with a user's token.

Source: D37; D50 (1); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: No GitHub user token is stored

- **WHEN** Ana completes a sign-in with GitHub
- **THEN** Tiehall's database holds no GitHub user access token and no GitHub refresh token for Ana

#### Scenario: GitHub calls after sign-in use the installation token

- **WHEN** Ana, signed in, links a pull request in a covered repository to FE-142
- **THEN** Tiehall reads the pull request from GitHub with an installation token of the install's App
- **AND** no token that GitHub issued to Ana is used

#### Scenario: The sign-in's own token reads who signed in, and nothing else

- **WHEN** Ana completes a sign-in with GitHub
- **THEN** the only calls Tiehall makes to GitHub's API with the token GitHub issued for that sign-in are one read of the account that signed in and one read of its email addresses
- **AND** no later call to GitHub carries that token

### Requirement: Who may sign in

A person SHALL be able to sign in only when at least one of these holds for the GitHub account they sign in with:
- GitHub reports, through an installation of the install's App that an admin has connected, as the tracker-mirrors capability defines, that the account is a member of that installation's organization; the sign-in policy admits organization members; and the account is not blocked by an admin removal, as the requirement on admin removals defines;
- it holds a valid invite, as the teams-and-roles capability defines;
- its Tiehall user is already a member of the install;
- it signs in from the setup session while setup completes, which makes it the install's first admin, as the self-host-install capability defines, or, after the operator has reopened setup, it closes the reopened step, which only an account whose user is already an admin may do.

Tiehall SHALL check organization membership through the connected installations at each sign-in. An installation that no admin has connected SHALL admit no one, and an outside collaborator on a repository is not a member of its organization. A membership lookup that fails, or that goes through an installation that is suspended or deleted on GitHub, SHALL admit no one through that organization. Anyone else SHALL be refused with HTTP 403, as the public-api capability's error model defines for a GitHub account that may not sign in, with a message that tells them to ask an admin of the install for an invite; this includes a person whose only way in is an invite that has expired. A browser SHALL get that refusal as a page that gives the message and links to the sign-in page, as the error model defines for refusals to browsers. A refused sign-in SHALL create no session, no Tiehall user and no membership. Of a refused sign-in, Tiehall SHALL keep only its security event, a record of the refused GitHub account, which the event names (the account's numeric id, the login it had and the time of the refusal, kept as long as the event), and, for 90 days, the IP address and user agent recorded with the event, as the activity-log capability defines. Every successful sign-in and every refused sign-in SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #1, #5; D37; D50 (5), (7); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A member of the connected organization signs in

- **WHEN** an admin has connected the App's installation on the GitHub organization `acme`, and Lee, a member of `acme` who has never used the install, signs in with GitHub
- **THEN** Lee is signed in
- **AND** Lee is a member of the install
- **AND** the activity log gains a security event for the sign-in

#### Scenario: An installation nobody connected admits no one

- **WHEN** the App is also installed on the GitHub organization `acme-labs`, no admin has connected that installation, and Kim, who is a member of `acme-labs` only and holds no invite, signs in with GitHub
- **THEN** the sign-in is refused with HTTP 403
- **AND** the answer tells Kim to ask an admin of the install for an invite
- **AND** no session, Tiehall user or membership is created for Kim
- **AND** the activity log gains a security event for the refused sign-in

#### Scenario: An outside collaborator is refused

- **WHEN** Sam is an outside collaborator on a repository of `acme` but not a member of the `acme` organization, holds no invite, and signs in with GitHub
- **THEN** the sign-in is refused with HTTP 403

#### Scenario: A suspended installation admits no new member

- **WHEN** the connected installation on `acme` is suspended on GitHub, and Lee, a member of `acme` who is not a member of the install and holds no invite, signs in with GitHub
- **THEN** the sign-in is refused with HTTP 403
- **AND** Ana, who joined through `acme` earlier, still signs in, because they are already a member of the install

#### Scenario: An invite admits a person outside the organization

- **WHEN** an admin invited the GitHub username `jo-contracts` 2 days ago, and Jo, who is not a member of any organization with a connected installation, signs in with that GitHub account
- **THEN** Jo is signed in
- **AND** Jo is a member of the install with the invite's role

#### Scenario: An expired invite does not admit

- **WHEN** an admin invited the GitHub username `jo-contracts` 8 days ago, and Jo, who is not a member of any organization with a connected installation, signs in with that account
- **THEN** the sign-in is refused with HTTP 403
- **AND** Jo gains no membership

#### Scenario: A refused sign-in in a browser is a page

- **WHEN** Kim, who may not sign in, comes back in their browser from GitHub's authorization to the install's sign-in callback, with an `Accept` header that names `text/html`
- **THEN** the answer is HTTP 403 with an HTML page, not an RFC 9457 problem
- **AND** the page tells Kim to ask an admin of the install for an invite, and links to the sign-in page

#### Scenario: What a refused sign-in keeps

- **WHEN** the sign-in of Kim's GitHub account `kim-x` is refused
- **THEN** the activity log gains a security event that names a record of the account `kim-x`
- **AND** that record holds the account's numeric id, the login `kim-x` and the time of the refusal, and nothing else of Kim

### Requirement: Signing out and ending sessions

A web session SHALL expire 7 days after it was created or last extended. A use SHALL extend it to 7 days after that use when a day or more has passed since it was created or last extended, so a session in use expires between 6 and 7 days after its last use. A web session SHALL end at the latest 30 days after the sign-in that created it, however often it is used; the person then signs in with GitHub again, which checks again whether they may sign in, whether they have left the GitHub organization and which email address they have, as the requirements of this capability define. A browser whose web session has expired, has reached its 30 days or was ended by signing out SHALL be treated as not signed in and sent to sign in. A signed-in user SHALL be able to sign out, which ends that web session at once. Signing out SHALL end only that web session; it SHALL NOT revoke the user's agent grants or tokens, which the agent-access capability lets them list and revoke. When a member is removed, whether by an admin or by leaving the GitHub organization, Tiehall SHALL end every web session they hold, so that no page or operation of the install is served through any of them; a request that still carries one of those sessions SHALL be refused with HTTP 403 and SHALL return no data, as the teams-and-roles capability defines for a removed member, which also defines how the removal revokes their agent grants and personal access tokens.

Source: D37; D50 (6); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: Signing out ends the web session

- **WHEN** Ana signs out in their browser and then opens `https://tiehall.example.com/FE-142` in the same browser
- **THEN** the browser is treated as not signed in and is sent to sign-in
- **AND** a call of Ana's CLI with its unexpired token still succeeds

#### Scenario: A removed member's sessions end

- **WHEN** an admin removes Dana while Dana is signed in on two browsers
- **THEN** the next request from each browser is refused with HTTP 403
- **AND** neither answer contains data of the install

#### Scenario: A session in daily use ends 30 days after sign-in

- **WHEN** Ana signs in at 09:00 UTC on 2026-10-01 and opens a page of the install every day after that
- **THEN** Ana is still signed in at 08:59 UTC on 2026-10-31
- **AND** at 09:00 UTC on 2026-10-31 the browser is treated as not signed in and is sent to sign-in, and is not refused with 403

#### Scenario: A session not used for 7 days expires

- **WHEN** Ana signs in at 09:00 UTC on 2026-10-01 and opens no page of the install until 09:01 UTC on 2026-10-08
- **THEN** the browser is treated as not signed in and is sent to sign-in

#### Scenario: A use extends the session at most once a day

- **WHEN** Ana signs in at 09:00 UTC on 2026-10-01, opens a page at 10:00 UTC that day and at 10:00 UTC on 2026-10-02, and then none until 09:30 UTC on 2026-10-09
- **THEN** the use on 2026-10-01 did not extend the session, and the use on 2026-10-02 extended it to 10:00 UTC on 2026-10-09
- **AND** at 09:30 UTC on 2026-10-09 Ana is still signed in

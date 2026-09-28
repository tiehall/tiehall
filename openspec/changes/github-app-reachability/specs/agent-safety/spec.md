# Spec Delta: agent-safety

## Purpose

Adds storing a webhook secret for the install's GitHub App, which an admin does when moving an App without a webhook to webhook mode, to the actions that need the confirmation step. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Actions that need the confirmation step

Each of these actions SHALL take effect only after the person taking it has confirmed it with the confirmation step that this capability defines, one action at a time:
- confirming a proposal, which is how a commitment takes effect, and undoing a commitment within its undo window, as the requests capability defines who may do each and when;
- changing a member's role, removing a member, and creating an invite;
- changing the sign-in policy;
- connecting a GitHub installation, uploading a new private key for the install's GitHub App, storing a webhook secret for the install's GitHub App, as the tracker-mirrors capability defines, and connecting or changing the Jira connection;
- registering an API for contract reports;
- turning personal access tokens on or off, setting the longest lifetime a personal access token may have, and setting the daily write budget;
- creating a personal access token;
- approving an agent client on the consent screen or on the device approval page;
- confirming a contract-change fan-out to more than 10 consumer teams;
- exporting the activity log.

A request for one of these actions without a valid confirmation SHALL be refused with HTTP 403, as the error model in the public-api capability defines for a missing or invalid confirmation, and SHALL change nothing. Each action the confirmation step applies SHALL be recorded with the actor kind `web_session`; in v1, nothing Tiehall records claims that a person rather than an agent acted. The one exception to this list is the operator commands that the self-host-install capability defines, such as `admin grant`, which run on the host without the web UI and without the confirmation step, because whoever runs them already controls the host. Rejecting a proposal and withdrawing one end it without any effect, so they SHALL NOT need the confirmation step; a rejection sent from the web UI SHALL still pass the CSRF, `Origin` and `Sec-Fetch-Site` checks that every web UI write passes.

Source: D19; D23; D35; D49; design.md, Decisions this change rests on; design.md, Design rules: Moving to webhook mode; design.md, Rules carried from earlier changes

#### Scenario: A confirmed role change takes effect

- **WHEN** Pia, an admin, changes Lee's role from `member` to `admin` and confirms it on the review page
- **THEN** Lee's role becomes `admin`
- **AND** the change is recorded with the actor kind `web_session`

#### Scenario: A session and a CSRF token alone change nothing

- **WHEN** a same-origin request carries Pia's session cookie and a valid CSRF token but no confirmation, and asks to change Lee's role
- **THEN** the request is refused with HTTP 403
- **AND** Lee's role is unchanged

#### Scenario: A personal access token needs the confirmation step

- **WHEN** a user asks to create a personal access token without confirming it on the review page
- **THEN** the request is refused with HTTP 403
- **AND** no token is created

#### Scenario: An operator command needs no confirmation step

- **WHEN** Omar runs `admin grant lee-gh` on the host, where `lee-gh` is the login of Lee, a member
- **THEN** Lee's role becomes `admin` without any review page or confirmation

#### Scenario: A rejection needs no confirmation step

- **WHEN** Bob rejects a pending decline proposal whose accountable human Bob is, from their web inbox, with a request that passes the CSRF, `Origin` and `Sec-Fetch-Site` checks and carries no confirmation nonce
- **THEN** the proposal is rejected

#### Scenario: Approving an agent client needs the confirmation step

- **WHEN** a user presses approve on the consent screen but the approval carries no valid confirmation
- **THEN** the approval is refused with HTTP 403
- **AND** the client gets no authorization code and no token

#### Scenario: Storing the App's webhook secret needs the confirmation step

- **WHEN** Ada, an admin, enters a webhook secret for the install's GitHub App in the web UI and does not confirm it on the review page
- **THEN** the request is refused with HTTP 403
- **AND** no webhook secret is stored

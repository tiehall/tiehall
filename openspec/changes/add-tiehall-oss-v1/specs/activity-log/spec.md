# Spec Delta: activity-log

## Purpose

Gives an install's admins a record of who did what: every change to a request and every security-relevant action, in one append-only log that the app itself cannot rewrite. Admins view it in the web UI and export it; members never see its security events. The log is plain, not tamper-evident, and the documentation says so.

## ADDED Requirements

### Requirement: The activity log holds domain events and security events

The activity log SHALL be the install's event log, as the requests capability defines it, and every event in it SHALL be in exactly one of two classes:
- domain events, which record the committed changes to requests that the requests capability lists;
- security events, which record the actions that the requirement on security events lists.

Each event SHALL carry its sequence number, its time, its class, its type, the ids of what it concerns, and who caused it: the user and the actor kind, or the system, or the operator command, as the event's kind requires. Events SHALL NOT carry message or packet bodies, as the requests capability defines.

Source: design.md, Design rules: Requests and events; design.md, Self-hosting decisions: S14

#### Scenario: A claim is a domain event

- **WHEN** an agent claims FE-142 for its signed-in user Bob
- **THEN** the activity log holds a domain event for the claim that names FE-142, Bob and the actor kind `agent`

#### Scenario: A role change is a security event

- **WHEN** Pia, an admin, changes Lee's role to `admin` with the confirmation step
- **THEN** the activity log holds a security event for the role change that names Pia, Lee and the new role
- **AND** it does not hold a domain event for it

#### Scenario: A question is logged by id

- **WHEN** Bob posts a question on FE-142
- **THEN** the domain event for it names FE-142 and the message id
- **AND** it does not contain the question's text

### Requirement: Which actions are security events

Tiehall SHALL record a security event for each of these:
- a sign-in, and a refused sign-in, naming the GitHub account that was refused; a sign-in that clears an admin removal's block, as the sign-in capability defines, SHALL name the clearing;
- a role change, an invite, the revocation of an invite, and a member's removal, naming whether an admin removed them, with the block that such a removal records, or they were removed because they left the GitHub organization, as the sign-in capability defines;
- a change of the sign-in policy;
- an agent client's approval, and the revocation of an agent grant;
- a personal access token created or revoked;
- an integration connected, changed or disconnected, and a new private key uploaded for the install's GitHub App;
- an Atlassian account linked or unlinked by its user, and an admin's removal of a link, as the tracker-mirrors capability defines;
- an API registered for contract reports, and an API unregistered;
- a contract-change fan-out confirmed;
- a change to the PAT switch, the longest PAT lifetime or the daily write budget;
- an operator command run on the host, `admin grant` or `setup reopen`, as the self-host-install capability defines, naming the command and what it changed, and no user;
- a `reconciled` event, as the requirement on reconciliation defines;
- an export of the activity log;
- the completion of setup, naming the first admin.

For a change that Tiehall's own commands make, the change and its security event SHALL be recorded together or not at all.

Source: design.md, Technical decisions: T5; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S8; design.md, Self-hosting decisions: S14

#### Scenario: Leaving the GitHub organization is recorded with its cause

- **WHEN** Dana joined through membership of the GitHub organization `acme`, which has a connected installation, then leaves `acme`, and the reconciliation removes Dana from the install
- **THEN** the activity log holds a security event for Dana's removal
- **AND** the event names leaving the GitHub organization as the cause, not an admin

#### Scenario: A refused sign-in is recorded

- **WHEN** a GitHub account that is not a member of any GitHub organization with a connected installation, and holds no invite, tries to sign in and is refused
- **THEN** the activity log holds a security event for the refused sign-in that names that GitHub account

#### Scenario: An operator command is recorded

- **WHEN** the operator runs `admin grant octo-lee` on the host through the image's `admin` role, and `octo-lee` is the GitHub login of the member Lee
- **THEN** the activity log holds a security event that names the `admin grant` command and Lee as the user made an admin

#### Scenario: The completion of setup is recorded

- **WHEN** the operator completes the setup screen and signs in with GitHub as Pia
- **THEN** the activity log holds a security event for the completion of setup that names Pia as the first admin

#### Scenario: A budget change is recorded

- **WHEN** Pia sets the daily write budget to 10,000 with the confirmation step
- **THEN** the activity log holds a security event that names Pia and the new budget

#### Scenario: An admin removal records its block

- **WHEN** Pia, an admin, removes Lee, who joined through membership of `acme`, with the confirmation step
- **THEN** the activity log holds a security event for Lee's removal that names Pia as the admin who removed Lee and records the block on Lee's GitHub account

#### Scenario: An Atlassian link is recorded

- **WHEN** Ayşe links their Atlassian account, and later an admin removes that link
- **THEN** the activity log holds a security event for the link, naming Ayşe, and one for the removal, naming the admin

#### Scenario: A failed change leaves no security event

- **WHEN** Pia's removal of Lee fails and Lee stays a member
- **THEN** the activity log holds no security event for a removal of Lee

### Requirement: Writes the sign-in service owns are still recorded

Where the sign-in service itself stores a change, such as a new session at sign-in or an agent client's grant on the consent screen, Tiehall SHALL still record the matching security event, right after the sign-in service's write. Because the two are not written in one transaction, the nightly reconciliation that the next requirement defines catches an event that is lost between them.

Source: design.md, Technical decisions: T8; design.md, Self-hosting decisions: S14

#### Scenario: A sign-in is recorded

- **WHEN** Alice signs in with GitHub
- **THEN** the activity log holds a security event for Alice's sign-in

#### Scenario: A client approval is recorded

- **WHEN** Alice approves an MCP client on the consent screen with the confirmation step
- **THEN** the activity log holds a security event that names Alice and the client

#### Scenario: A grant revocation is recorded

- **WHEN** Alice revokes that client's grant on their "Connected agents and tokens" page
- **THEN** the activity log holds a security event for the revocation

### Requirement: Trust-state changes are reconciled every night

Every night, Tiehall SHALL compare the install's current members, their roles and the agent-client grants with the security events, and SHALL append a `reconciled` security event for each difference it finds, naming what differs, so that a change whose security event was lost, for example because the process stopped between a write the sign-in service owns and its event, still appears in the activity log.

Source: design.md, Technical decisions: T8; design.md, Self-hosting decisions: S14

#### Scenario: A lost event is reconciled

- **WHEN** Alice approved an MCP client, the grant was stored, and the process stopped before the approval's security event was appended
- **THEN** after the next nightly comparison, the activity log holds a `reconciled` security event that records Alice's grant for that client

#### Scenario: Nothing to reconcile

- **WHEN** every member, role and grant has its security event
- **THEN** the nightly comparison appends no `reconciled` event

### Requirement: Security events are shown to admins only

Security events SHALL appear only in the admin view and the export that this capability defines, which only admins can open. They SHALL NOT reach the pull readers, the long-poll wait endpoint or the web inbox, which serve only domain events, as the requests capability defines, not even for an admin. A member who is not an admin and asks for the admin view or an export SHALL be refused with 403, as the error model in the public-api capability defines for a role that does not allow the action. Members see requests' domain events through the request pages and the requester loop.

Source: D28 #4; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S14

#### Scenario: Updates leave out security events

- **WHEN** Pia, an admin, changes Lee's role, and then both Pia's agent and Bob's agent call `whats_new`
- **THEN** neither result includes the role-change event
- **AND** Pia sees the role-change event in the admin view

#### Scenario: A member cannot open the admin view

- **WHEN** Bob, a member who is not an admin, asks for the admin view of the activity log or an export of it
- **THEN** the request is refused with 403 and an RFC 9457 problem
- **AND** nothing is shown or exported

### Requirement: IP addresses and user agents are kept apart for 90 days

Tiehall SHALL keep the IP address and the user agent recorded with a security event apart from the event itself, and SHALL delete them 90 days after the event. The event SHALL stay in the activity log after they are deleted. While they are kept, the admin view SHALL show them next to their event; the export SHALL NOT include them.

Source: D28 #9; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S14

#### Scenario: The IP address is gone after 90 days

- **WHEN** 91 days have passed since Alice created a personal access token from the IP address 203.0.113.7
- **THEN** the database no longer holds 203.0.113.7 or the user agent recorded with that security event
- **AND** the security event for the token's creation is still in the activity log

#### Scenario: The IP address is kept within 90 days

- **WHEN** 30 days have passed since Alice created a personal access token from the IP address 203.0.113.7
- **THEN** the database still holds 203.0.113.7 with that security event
- **AND** the admin view shows 203.0.113.7 next to that event

#### Scenario: The export leaves IP addresses out

- **WHEN** Pia exports the activity log with the confirmation step 30 days after Alice created a personal access token from the IP address 203.0.113.7
- **THEN** the export holds the event for the token's creation
- **AND** it does not contain 203.0.113.7

### Requirement: The activity log is append-only

Events SHALL only be added, never changed or removed, by the app. The app's database role SHALL be able only to insert and read events, and the database SHALL refuse every update and every delete of an event; the app's database role SHALL NOT be able to remove that refusal. No operation on any surface, the web UI included, SHALL change or delete an event.

Source: design.md, Self-hosting decisions: S14

#### Scenario: The app's role cannot rewrite history

- **WHEN** code running with the app's database role tries to update an event, to delete an event, and to remove the database's refusal of updates and deletes
- **THEN** each attempt is refused
- **AND** the event is unchanged

#### Scenario: No operation deletes an event

- **WHEN** a reader looks through the web UI, the OpenAPI document, the MCP tools and the CLI commands
- **THEN** none of them offers a way to change or delete an activity-log event

### Requirement: The admin view

Admins SHALL be able to view the activity log in the web UI, with domain and security events, filtered by time, actor, request and event type. The view SHALL be offered only in the web UI and on no agent surface.

Source: D28 #4, #48; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S14

#### Scenario: Filtering by request

- **WHEN** Pia filters the admin view by the request FE-142
- **THEN** the view shows FE-142's events and no event of any other request

#### Scenario: Filtering by actor and type

- **WHEN** Pia filters the admin view by the actor Pia and the event type for role changes
- **THEN** the view shows only the role changes that Pia made

#### Scenario: Filtering by time

- **WHEN** Pia filters the admin view to 2026-10-01 from 00:00 to 23:59 UTC
- **THEN** every event shown has a time within that range

### Requirement: Exporting the activity log

An admin SHALL be able to export the activity log as JSONL, one event per line, from the web UI, with the confirmation step as the agent-safety capability defines. Each line SHALL carry the event's sequence number, time, class, type, the ids of what it concerns and who caused it, and no message or packet body. An export asked for without a valid confirmation SHALL be refused with 403 and SHALL export nothing. Each export SHALL be recorded as a security event.

Source: D28 #4; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: An admin exports the log

- **WHEN** Pia exports the activity log with the confirmation step, after Lee's role change and Bob's claim of FE-142
- **THEN** Pia receives a JSONL file with one event per line, including the role change and the claim
- **AND** the activity log then holds a security event for the export that names Pia

#### Scenario: An export without a confirmation

- **WHEN** Pia asks for an export with their session but without a valid confirmation
- **THEN** the request is refused with 403 and an RFC 9457 problem
- **AND** nothing is exported

#### Scenario: The export holds no bodies

- **WHEN** Pia exports the activity log after Bob posted the question "Which endpoint?" on FE-142
- **THEN** the export holds the event for the question, with FE-142 and the message id
- **AND** it does not contain the text "Which endpoint?"

### Requirement: What the activity log does not prove

Tiehall's documentation SHALL state that the activity log is not tamper-evident: whoever holds the database owner role or controls the host can change or delete events without the change being detectable, and the append-only rules only stop the app itself from rewriting history. It SHALL state that a tamper-evident log, with a hash chain anchored outside the install, is planned as a later addition.

Source: D35; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S14

#### Scenario: The docs state what the log does not prove

- **WHEN** a reader opens Tiehall's documentation on the activity log
- **THEN** it states that the database owner or whoever controls the host can change the log undetected
- **AND** it states that a tamper-evident, anchored log is a later addition

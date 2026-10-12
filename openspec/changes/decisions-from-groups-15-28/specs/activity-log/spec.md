# Spec Delta: activity-log

## Purpose

States that changes to the consumer map are domain events, that changes to who belongs to a team are security events, and which writes record their events in the same transaction. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: The activity log holds domain events and security events

The activity log SHALL be the install's event log, as the requests capability defines it, and every event in it SHALL be in exactly one of two classes:
- domain events, which record the committed changes to requests that the requests capability lists, and the changes to the consumer map that the contract-changes capability lists: a team's declaration that it consumes an API, its removal and its re-confirmation;
- security events, which record the actions that the requirement on security events lists.

Each event SHALL carry its sequence number, its time, its class, its type, the ids of what it concerns, and who caused it: the user and the actor kind, or the system, or the operator command, as the event's kind requires. Events SHALL NOT carry message or packet bodies, as the requests capability defines.

Source: D55 (60); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A declaration is a domain event

- **WHEN** Ayşe, a member of FE, declares that FE consumes `payments-api`
- **THEN** the activity log holds a domain event for the declaration that names FE, `payments-api` and Ayşe
- **AND** it does not hold a security event for it

### Requirement: Writes the sign-in service owns are still recorded

Where the sign-in service itself stores a change, such as a new session at sign-in, Tiehall SHALL still record the matching security event, right after the sign-in service's write. Because the two are not written in one transaction, the nightly reconciliation that the next requirement defines catches an event that is lost between them. The changes that Tiehall's own commands make in place of the sign-in service's routes, an agent client's grant on the consent screen, the CLI's grant on the device approval page and the revocation of a grant, SHALL be written together with their security events, in one transaction, or not at all.

Source: D55 (10); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A sign-in is recorded

- **WHEN** Alice signs in with GitHub
- **THEN** the activity log holds a security event for Alice's sign-in

#### Scenario: A client approval is recorded

- **WHEN** Alice approves an MCP client on the consent screen with the confirmation step
- **THEN** the activity log holds a security event that names Alice and the client

#### Scenario: A grant revocation is recorded

- **WHEN** Alice revokes that client's grant on their "Connected agents and tokens" page
- **THEN** the activity log holds a security event for the revocation

#### Scenario: A grant and its event are written together

- **WHEN** the write of the grant that Alice's approval of an MCP client stores fails
- **THEN** the activity log holds no security event for that approval

### Requirement: Which actions are security events

Tiehall SHALL record a security event for each of these:
- a sign-in, and a refused sign-in, naming the GitHub account that was refused; a sign-in that clears an admin removal's block, as the sign-in capability defines, SHALL name the clearing;
- a role change, an invite, the revocation of an invite, and a member's removal, naming whether an admin removed them, with the block that such a removal records, or they were removed because they left the GitHub organization, as the sign-in capability defines;
- a person added to a team or removed from a team, naming the admin, the person and the team;
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

Source: D55 (82); design.md, Decisions this change rests on; design.md, Technical decisions: T15; design.md, Rules carried from earlier changes

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

#### Scenario: A team membership change is recorded

- **WHEN** Ada, an admin, adds Lee to team FE in the web UI, and later removes Lee from team FE
- **THEN** the activity log holds a security event for the addition and one for the removal, each naming Ada, Lee and FE

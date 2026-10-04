# Spec Delta: activity-log

## Purpose

States that changes to the consumer map are domain events, and which writes record their events in the same transaction. The rest of the capability is unchanged.

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

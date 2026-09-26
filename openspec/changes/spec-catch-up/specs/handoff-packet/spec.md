# Spec Delta: handoff-packet

## Purpose

Brings the handoff-packet capability up to what the code does: the packet's top level, the `kind` discriminator, and the bounds of every text field.

## MODIFIED Requirements

### Requirement: Packet fields

The packet schema SHALL define fields for:
- the need and the acceptance criteria;
- a contract section: the API; the base and head ref and commit sha; the diff engine's name and version; a list of changes, each with the engine's id for the change, its level and the operation it touches; the provider PR; the provider status; migration notes; and a deprecation window;
- code refs, links, a due date and `extensions`.

Every packet SHALL carry at its top level: `schema_version`, as the requirement on the beta label defines; `kind`, which is `request` for a request's packet and `contract_change` for a contract-change request's; and, when the request has one, `due_date`, a calendar day written as `YYYY-MM-DD`. Every other field SHALL sit under the packet's `untrusted` object, as the requirement on untrusted fields defines. The need SHALL be required in every packet, and the contract section SHALL be required in every packet whose kind is `contract_change`, as the contract-changes capability defines; a packet whose kind is `request` MAY carry a contract section, such as a classified diff a developer attaches by hand. A packet that lacks a required field, that lacks `kind`, or whose kind is neither value SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema, and nothing SHALL be stored. A revision SHALL keep the request's kind: a revision whose kind differs from the current revision's SHALL be refused with 400 and SHALL add nothing. The fields a target team requires on top of these are defined by the agent-surfaces capability for its intake page.

Every text field of the packet SHALL be bounded, SHALL NOT be blank, and SHALL be kept exactly as written; a value outside its bound SHALL be refused with 400, as for any input that fails the schema, and nothing SHALL be stored. The bounds are:

| Field | Bound |
| --- | --- |
| the need; the migration notes | 1 to 20,000 characters each |
| the acceptance criteria | at most 100, each 1 to 2,000 characters |
| the code refs | at most 100; each repository 1 to 200 characters, path 1 to 1,000, ref 1 to 255 |
| the links | at most 100; each URL an `http` or `https` URL of at most 2,048 characters, each title 1 to 200 characters |
| the contract section | the API 1 to 200 characters; each ref 1 to 255; each sha 40 or 64 lower-case hexadecimal digits; the engine's name and version 1 to 100 each; at most 1,000 changes, each id 1 to 200 characters and each operation 1 to 1,000; the provider PR's repository 1 to 200 characters, its number a whole number of 1 or more, and its URL an `http` or `https` URL of at most 2,048 characters; each day of the deprecation window a calendar day |
| `extensions` | each key a namespace of at most 255 characters, and 16 KB of JSON in all, as the requirement on `extensions` defines |

Source: D9; D14; D28 #23; D45 (1), (2); design.md, Decisions this change rests on; design.md, Design rules: Handoff packet; design.md, Decisions: D45 (1), (2)

#### Scenario: A request packet

- **WHEN** a requester's agent opens a request to team FE with a need, acceptance criteria, a code ref and a link
- **THEN** the stored packet carries each of them in its own field

#### Scenario: A contract packet

- **WHEN** an agent reads the packet of a contract-change request
- **THEN** its contract section names the API, the base and head ref and sha, and the diff engine's name and version
- **AND** it lists the changes, each with the engine's change id, its level and the operation it touches
- **AND** it names the provider PR and the provider status

#### Scenario: A packet without a need

- **WHEN** an agent opens a request through `/api/v1` with a packet that has acceptance criteria but no need
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no request is created

#### Scenario: A contract-change packet without its contract section

- **WHEN** a client adds a packet revision to the contract-change request FE-150 that has no contract section
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no revision is created

#### Scenario: The kind names the packet's variant

- **WHEN** an agent reads the packet of FE-142, a request Alice opened, and the packet of FE-150, a contract-change request
- **THEN** the first carries `kind` `request` at its top level and the second `kind` `contract_change`
- **AND** only `schema_version`, `kind` and `due_date` sit outside the `untrusted` object of either

#### Scenario: A packet without a kind, or with an unknown one

- **WHEN** an agent opens a request through `/api/v1` with a packet that has no `kind`, or whose kind is `incident`
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no request is created

#### Scenario: A revision keeps the kind

- **WHEN** Alice's agent adds a revision to FE-142, whose packet is of kind `request`, with a packet of kind `contract_change`
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no revision is created

#### Scenario: A need over its bound

- **WHEN** Alice's agent opens a request through `/api/v1` with a need of 20,001 characters
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no request is created

#### Scenario: Too many acceptance criteria, or one too long

- **WHEN** Alice's agent adds a revision to FE-142 with 101 acceptance criteria, or with one criterion of 2,001 characters
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no revision is created

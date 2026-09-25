# Spec Delta: handoff-packet

## Purpose

`tiehall.packet/v1` is the typed, agent-readable handoff packet a request carries. This capability defines its fields, its immutable revisions, how user-written content is marked untrusted, which packet changes are commitments, how the schema stays labeled beta until real use has shaped it, and what publishing it under Apache-2.0 means.

## ADDED Requirements

### Requirement: The packet format

The typed content of a request SHALL be a handoff packet in the format `tiehall.packet/v1`, which SHALL be defined as a JSON Schema (draft 2020-12).

Source: D24; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet

#### Scenario: A packet validates against the schema

- **WHEN** an agent reads the packet of request FE-142 as JSON
- **THEN** the packet validates against the `tiehall.packet/v1` JSON Schema (draft 2020-12)

### Requirement: Packet fields

The packet schema SHALL define fields for:
- the need and the acceptance criteria;
- a contract section: the API; the base and head ref and commit sha; the diff engine's name and version; a list of changes, each with the engine's id for the change, its level and the operation it touches; the provider PR; the provider status; migration notes; and a deprecation window;
- code refs, links, a due date and `extensions`.

The need SHALL be required in every packet, and the contract section SHALL be required in the packet of every contract-change request, as the contract-changes capability defines. A packet that lacks a required field SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema, and nothing SHALL be stored. The fields a target team requires on top of these are defined by the agent-surfaces capability for its intake page.

Source: D9; D14; D28 #23; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet

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

### Requirement: One definition for the schema and the API

The packet JSON Schema and the packet component in the OpenAPI description of `/api/v1` SHALL be generated from one definition and SHALL match. The OpenAPI description SHALL use the same packet component for request bodies and response bodies.

Source: design.md, Design rules: Handoff packet

#### Scenario: The schema and the OpenAPI component agree

- **WHEN** the packet JSON Schema is compared with the packet component of `/api/v1/openapi.json`
- **THEN** they define the same fields with the same types

#### Scenario: One component for both directions

- **WHEN** a client reads `/api/v1/openapi.json`
- **THEN** the operation that adds a packet revision and the operation that reads a packet refer to the same packet component

### Requirement: The beta label

Until the schema is published, its `$id` SHALL be `https://tiehall.com/schemas/packet/v1-beta.json`, which differs from every release URL, and every packet SHALL carry a `schema_version` field with the value `"1-beta"`. Every install SHALL serve the schema at its own `/schemas/packet/v1-beta.json`, such as `https://tiehall.example.com/schemas/packet/v1-beta.json`, with that `$id` and without sign-in, because the schema holds no data of the install. The `$id` names the schema; it need not resolve before publication, and an install SHALL NOT fetch the schema from `tiehall.com` or from any other host. From publication on, packets SHALL carry the `schema_version` value `"1.0"`.

Source: D24; D26; D28 #22; D33; design.md, Decisions this change rests on; design.md, Technical decisions: T11; design.md, Self-hosting decisions: S13

#### Scenario: A packet before publication

- **WHEN** any packet is read before the schema is published
- **THEN** its `schema_version` is `"1-beta"`
- **AND** the schema it follows has the `$id` `https://tiehall.com/schemas/packet/v1-beta.json`, not a release URL such as `v1.0.json`

#### Scenario: Each install serves the beta schema

- **WHEN** a client fetches `https://tiehall.example.com/schemas/packet/v1-beta.json` before publication
- **THEN** the response is the packet JSON Schema
- **AND** the schema's `$id` is `https://tiehall.com/schemas/packet/v1-beta.json`

#### Scenario: The beta schema needs no sign-in

- **WHEN** a client without credentials fetches `https://tiehall.example.com/schemas/packet/v1-beta.json` on an install whose setup is complete
- **THEN** the response is 200 with the packet JSON Schema

#### Scenario: An install validates packets without calling out

- **WHEN** an install whose network allows no connection to `tiehall.com` accepts and validates a new packet revision
- **THEN** the revision is validated and stored
- **AND** the install made no connection to `tiehall.com`

#### Scenario: A packet after publication

- **WHEN** a packet is read after the schema has been published as v1.0
- **THEN** its `schema_version` is `"1.0"`

### Requirement: Open objects, strict server

Objects in the packet schema SHALL NOT forbid additional properties. The server SHALL still parse every incoming packet strictly: it SHALL refuse with 400 a packet whose known fields do not match the schema, and it SHALL drop keys it does not know, so a dropped key is neither stored nor returned. The contents of `extensions` SHALL be the exception: they are kept as sent, as the requirement on `extensions` defines.

Source: D28 #23; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet

#### Scenario: An unknown key is valid against the schema

- **WHEN** a packet carries a top-level key that the schema does not define
- **THEN** the packet still validates against the schema

#### Scenario: The server drops an unknown key

- **WHEN** a client adds a packet revision that carries a top-level key the server does not know
- **THEN** the revision is created
- **AND** reading that revision back does not return the unknown key

#### Scenario: A known field with the wrong type

- **WHEN** a client adds a packet revision in which a field the schema defines has a value of the wrong type
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no revision is created

### Requirement: The `extensions` field

The keys of the packet's `extensions` object SHALL be reverse-DNS namespaces, such as `com.acme.billing`. Tiehall SHALL keep the contents of `extensions` as sent, without dropping keys it does not know, and SHALL return them unchanged. The packet schema SHALL mark `extensions` as untrusted, so an agent that reads a packet as JSON finds its contents under an `untrusted` object. The `extensions` object SHALL be capped at 16 KB of JSON. A packet whose `extensions` has a key that is not a reverse-DNS namespace, or is larger than the cap, SHALL be refused with 400, and nothing SHALL be stored.

Source: D28 #23; design.md, Decisions this change rests on

#### Scenario: Extensions are kept as sent

- **WHEN** a client adds a packet revision whose `extensions` holds the key `com.acme.billing` with the value `{"cost_center": "CC-12", "flags": ["urgent"]}`
- **THEN** reading that revision back returns `extensions` with exactly that key and value
- **AND** no key inside `extensions` has been dropped

#### Scenario: Extensions are untrusted

- **WHEN** an agent reads the packet of FE-142 as JSON and the packet carries `extensions`
- **THEN** the contents of `extensions` sit inside an `untrusted` object
- **AND** the packet schema marks `extensions` as untrusted

#### Scenario: A key that is not a namespace

- **WHEN** a client adds a packet revision whose `extensions` has the key `billing`
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no revision is created

#### Scenario: Extensions over the cap

- **WHEN** a client adds a packet revision whose `extensions` takes 20 KB as JSON
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no revision is created

### Requirement: User-written fields are marked untrusted

The packet schema SHALL mark every field whose content a user or an agent writes as untrusted, and the packet's published spec SHALL say how. When an agent reads a packet as JSON, that text SHALL sit under `untrusted` objects, as the agent-safety capability defines for everything agents read.

Source: design.md, Design rules: Handoff packet; design.md, Design rules: Agent safety

#### Scenario: The need is marked untrusted

- **WHEN** an agent reads the packet of FE-142 as JSON
- **THEN** the need and the acceptance criteria sit inside an `untrusted` object
- **AND** the packet schema marks both fields as untrusted

### Requirement: Immutable, numbered revisions

A request's packet SHALL be kept as numbered revisions: the first packet is revision 1, and each change SHALL add the next revision (2, 3 and so on). A revision SHALL NOT change once it is created, and every earlier revision SHALL stay readable by its number. Adding a revision over REST SHALL need `If-Match` with the current revision's `ETag`, so that two writers adding a revision at once cannot overwrite each other; the public-api capability defines that rule and its answers when `If-Match` is missing or does not match. Every other surface that adds a packet revision or proposes a packet change SHALL carry the revision the caller expects, and a missing or stale value SHALL be refused the same way as on REST.

Source: D28 #21; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet

#### Scenario: The first packet

- **WHEN** a request is opened with a packet
- **THEN** that packet is revision 1

#### Scenario: A later change keeps the earlier revision

- **WHEN** the packet of FE-142 at revision 1 is changed
- **THEN** revision 2 becomes the current revision
- **AND** reading revision 1 returns exactly what it returned before the change

#### Scenario: A stale expected revision over MCP

- **WHEN** FE-142 is claimed by Bob at revision 3, and Alice's agent calls `propose` over MCP to change its acceptance criteria while naming revision 2 as the revision it expects
- **THEN** the call is refused the same way as a REST call whose `If-Match` does not match
- **AND** no proposal is created and FE-142 stays at revision 3

### Requirement: What changed since revision N

Tiehall SHALL answer, for a request and a revision number N, what changed in the packet between revision N and the current revision. The answer SHALL carry an RFC 6902 JSON Patch that turns the packet of revision N into the current packet, and a list of the packet fields that changed.

Source: D28 #25; design.md, Decisions this change rests on

#### Scenario: Changes across two revisions

- **WHEN** FE-142's acceptance criteria changed in revision 2, a link was added in revision 3, and a client asks what changed since revision 1
- **THEN** the answer's list of changed fields names the acceptance criteria and the links
- **AND** applying the answer's JSON Patch to the packet of revision 1 gives the packet of revision 3

#### Scenario: No changes since the current revision

- **WHEN** revision 3 is current and a client asks what changed since revision 3
- **THEN** the answer carries an empty JSON Patch and an empty list of changed fields

### Requirement: Packet changes that are commitments

These packet changes SHALL be commitments, as the requests capability defines: setting or changing the due date after the request was opened, and changing scope while the request is claimed, where scope means the need, the acceptance criteria and the contract section, and a claimed request is one that has a claimant at that moment. Such a change SHALL become a proposal, and its revision SHALL become the current revision only once the proposal has been confirmed in the web UI with the confirmation step, by its accountable human and by the other side, as the requests capability defines for cross-team commitments: for a due date, a person on the other side of the request; for a scope change while the request is claimed, the claimant, or a member of the target team when the claimant is no longer a member of the install. A due date in revision 1, the packet the request is opened with, SHALL NOT be a commitment. A change to scope while the request is unclaimed SHALL NOT be a commitment and SHALL be added as the next revision at once.

A proposed packet change SHALL record the revision it was based on. When the request's current revision moves past that base revision while the proposal is pending, whoever or whatever added the new revision, Tiehall SHALL cancel the proposal at once as stale, as the requests capability defines for how a proposal ends, and it SHALL no longer be listed as waiting in any web inbox. An attempt to confirm it SHALL then be refused with 409, and no revision SHALL be added; the change has to be proposed again on the current revision. Packet revisions SHALL come from the requester side, except that either side may propose a due date, as the requests capability defines; a packet change from anyone else SHALL be refused with 403. Revisions that Tiehall itself adds from a signed contract report are system actions, not commitments, as the contract-changes capability defines, and need no proposal even while the request is claimed.

Source: D23; D28 #3, #14, #15; D30 (2), (3), (4); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7

#### Scenario: A proposal whose base revision is no longer current

- **WHEN** FE-142 is claimed at revision 3, one proposal changes its acceptance criteria and another moves its due date, both on the base of revision 3, and the due-date proposal takes effect first, which adds revision 4
- **THEN** the acceptance-criteria proposal is cancelled as stale at once
- **AND** confirming it is refused with 409
- **AND** revision 4 stays the current revision and no revision 5 is added

#### Scenario: A contract report makes a waiting due date stale

- **WHEN** the contract-change request FE-150 is claimed at revision 2, Bob, a member of team FE, has proposed a due date on the base of revision 2 and confirmed it, and a signed contract report then adds revision 3 before the requester side confirms
- **THEN** the due-date proposal is cancelled as stale
- **AND** it is no longer listed as waiting in any web inbox
- **AND** the event log has an event that names it as cancelled

#### Scenario: Changing acceptance criteria after a claim

- **WHEN** FE-142 is claimed by Bob and the requester's agent submits a packet change to its acceptance criteria
- **THEN** a proposal is created and the current revision does not change
- **AND** once the accountable human confirms the proposal in the web UI, the current revision still does not change
- **AND** once Bob, the claimant, confirms it in the web UI too, the changed packet becomes the current revision

#### Scenario: A due date takes effect after both sides confirm

- **WHEN** Alice, the requester of FE-142, proposes moving its due date and confirms the proposal in the web UI
- **THEN** the current revision does not change
- **AND** once a member of FE-142's target team confirms it in the web UI, the moved due date is in a new current revision

#### Scenario: Changing the contract section after a claim

- **WHEN** FE-142 is claimed and its requester attaches a new classified diff to it as its contract section with `tiehall contract diff`
- **THEN** a proposal is created and the current revision does not change

#### Scenario: Changing a due date

- **WHEN** an agent submits a packet change that moves FE-142's due date
- **THEN** a proposal is created and the current revision does not change

#### Scenario: A due date in the opening packet

- **WHEN** a request is opened with a packet that carries the due date 2026-10-15
- **THEN** revision 1 carries the due date 2026-10-15
- **AND** no proposal is created

#### Scenario: Changing acceptance criteria before a claim

- **WHEN** FE-143 is `open` and has not been claimed, and the requester's agent changes its acceptance criteria
- **THEN** the change is added as the next revision without a proposal

#### Scenario: The target team cannot change the acceptance criteria

- **WHEN** FE-143 is `open` and Bob, a member of its target team FE who does not belong to the requesting team, submits a change to its acceptance criteria through `/api/v1`
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** no revision and no proposal are created

### Requirement: Breaking packet changes before publication

Before the schema is published, a breaking change to the packet schema SHALL be announced in the changelog, through the notice channels the public-api capability defines, at least 14 days before it takes effect, and no release SHALL contain it before that date. The pull request that makes it SHALL carry the `api-breaking` label and SHALL add a changelog entry. Every conformance fixture that validated against an earlier beta version of the schema SHALL still validate against later beta versions, unless a breaking change was announced this way, and CI SHALL fail a pull request that breaks a fixture without the label. The rule that v1 only gains optional fields SHALL apply from publication on, not before.

Source: design.md, Design rules: Handoff packet; design.md, Design rules: Public API

#### Scenario: Fourteen days' notice

- **WHEN** a breaking packet change is announced in the changelog on 2026-11-02
- **THEN** no release that contains it is made before 2026-11-16

#### Scenario: A change without notice keeps old packets valid

- **WHEN** the packet schema changes before publication without an announced breaking change
- **THEN** every conformance fixture that validated before the change still validates

#### Scenario: A breaking packet change carries the label

- **WHEN** a pull request before publication makes a breaking packet change, so that an earlier fixture no longer validates
- **THEN** CI fails unless the pull request carries the `api-breaking` label
- **AND** with the label, the pull request also adds a changelog entry for the change

### Requirement: When the schema is published

The packet schema SHALL NOT be published before both of these hold: no breaking packet change has been needed for four weeks, and at least three companies are known, from their own reports, to exchange packets, contract packets included. Because installs send no usage data, only what companies report themselves SHALL count. Once the test is met, publishing SHALL be a maintainers' decision, recorded in the changelog.

Source: D24; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet; design.md, Self-hosting decisions: S13

#### Scenario: Too few companies

- **WHEN** only two companies have reported that they exchange packets
- **THEN** the schema stays unpublished, with its beta `$id`

#### Scenario: No contract packets yet

- **WHEN** three companies have reported that they exchange packets but none of them exchanges contract packets
- **THEN** the schema stays unpublished

#### Scenario: A recent breaking change

- **WHEN** three companies have reported that they exchange packets, contract packets included, and the last breaking packet change took effect three weeks ago
- **THEN** the schema stays unpublished

#### Scenario: Unreported use does not count

- **WHEN** a fourth company runs an install that exchanges packets but has not reported it
- **THEN** that company is not counted toward the three

#### Scenario: The test is met

- **WHEN** three companies have reported that they exchange packets, contract packets included, four weeks have passed with no breaking packet change, and the maintainers decide to publish
- **THEN** the changelog records the decision
- **AND** the schema is published as the publication requirements define

### Requirement: Publication includes all four parts

Publishing the schema SHALL mean all four of these at once: the Apache-2.0 schema directory in the public repository with its spec and changelog, the fixed release URLs, the `@tiehall/packet` npm package, and the packet media type named in the published spec, as the requirements below define.

Source: D24; D28 #24; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet

#### Scenario: The schema is announced as published

- **WHEN** the maintainers announce that `tiehall.packet/v1` is published
- **THEN** the schema directory holds the spec and the changelog, the release URLs serve the schema, and the npm package exists
- **AND** the published spec names the packet media type

### Requirement: The Apache-2.0 schema directory

The packet schema and its conformance fixtures SHALL live in a directory of Tiehall's public repository that is licensed under Apache-2.0, with its own license file, as the license map of the public-api capability defines, from before publication on. On publication, that directory SHALL hold the schema, a short spec, conformance fixtures of valid and invalid packets, and a changelog. The spec SHALL cover what each field means, how user-written fields are marked untrusted, the rules for `extensions`, and the versioning rules.

Source: D24; D34; D38; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet; design.md, Self-hosting decisions: S16

#### Scenario: The directory is Apache-2.0 before publication

- **WHEN** anyone opens the packet schema directory in the public repository before publication
- **THEN** it holds the schema and the conformance fixtures
- **AND** its own license file is Apache-2.0, while the repository's root license is AGPL-3.0

#### Scenario: The directory's contents after publication

- **WHEN** anyone opens the packet schema directory after publication
- **THEN** it holds the schema, the spec, valid and invalid fixture packets, and a changelog
- **AND** the spec explains each field, the untrusted marking, the `extensions` rules and the versioning rules

#### Scenario: The fixtures behave as labeled

- **WHEN** the fixtures are validated against the schema
- **THEN** every valid fixture passes and every invalid fixture fails

### Requirement: Fixed release URLs

Each published release SHALL live at its own URL under `https://tiehall.com/schemas/` that never changes, and that URL SHALL be the release's `$id` (`v1.0.json`, `v1.1.json` and so on). `v1.json` SHALL always resolve to the latest v1.x release.

Source: D24; D26; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet

#### Scenario: A second release

- **WHEN** v1.1 is released after v1.0
- **THEN** v1.1 is served at its own release URL, which is also its `$id`
- **AND** v1.0's release URL still serves v1.0 unchanged
- **AND** `v1.json` resolves to v1.1

### Requirement: v1 only gains optional fields after publication

From publication on, a new v1.x release SHALL only add optional fields: it SHALL NOT add a required field, remove a field or narrow a type. A packet built against a newer v1.x release SHALL also validate against every older published v1.x release, and every conformance fixture that ever validated SHALL still validate.

Source: design.md, Design rules: Handoff packet

#### Scenario: A newer packet against an older release

- **WHEN** v1.1 adds an optional field and a packet that uses it is validated against v1.0
- **THEN** the packet validates against v1.0

#### Scenario: A required field is not released

- **WHEN** a proposed schema change after publication adds a required field
- **THEN** no v1.x release is made with that change

### Requirement: The npm package

On publication, `@tiehall/packet` SHALL be published to npm under the Apache-2.0 license, holding the packet's types, a validator and the conformance fixtures; it SHALL NOT include Tiehall's fencing renderer. It SHALL be built from Tiehall's public repository and published from CI with npm provenance, never from a developer's machine.

Source: D24; D34; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet; design.md, Design rules: Public API

#### Scenario: Installing the package

- **WHEN** a developer installs `@tiehall/packet` from npm after publication
- **THEN** its license is Apache-2.0
- **AND** it contains the types, a validator and the fixtures, and no fencing renderer
- **AND** its validator accepts every valid fixture and rejects every invalid one

#### Scenario: Provenance

- **WHEN** a developer looks up a published version of `@tiehall/packet` on npm
- **THEN** npm shows provenance that points to a CI build of Tiehall's public repository

### Requirement: The packet media type

On publication, the packet SHALL have the media type `application/vnd.tiehall.packet+json; version=1`, and the published spec SHALL name it. The media type SHALL only be named in the published spec: the API SHALL serve packets as `application/json`.

Source: D28 #24; design.md, Decisions this change rests on; design.md, Design rules: Handoff packet

#### Scenario: The spec names the media type

- **WHEN** anyone reads the published packet spec
- **THEN** it names `application/vnd.tiehall.packet+json; version=1` as the packet's media type

#### Scenario: The API serves JSON

- **WHEN** a client reads the packet of FE-142 through `/api/v1`
- **THEN** the response's content type is `application/json`

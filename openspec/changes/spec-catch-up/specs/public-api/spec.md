# Spec Delta: public-api

## Purpose

Brings the public-api capability up to what the code does: `If-Match` names one revision by its strong entity tag, and `*`, a weak tag, a list and a revision named in the body are refused.

## MODIFIED Requirements

### Requirement: Packet revisions use ETag and If-Match

Reading a packet SHALL return an `ETag` for its current revision: the strong entity tag of the revision's number, such as `"3"` for revision 3. An operation that adds a packet revision SHALL require `If-Match`: a call without it SHALL be answered `428 Precondition Required` and SHALL NOT add a revision. The revision a caller expects SHALL be taken from the header alone: a field of the body that names a revision SHALL be dropped, so a call whose body names one and whose header is missing still gets 428. The header SHALL name one revision by its strong entity tag. When the `If-Match` value is the entity tag of a revision that is no longer current, the API SHALL answer `412 Precondition Failed` and SHALL NOT add a revision. When the value is anything but one strong entity tag of a revision, such as `*`, a weak tag like `W/"3"`, a list of tags, an unquoted number, `"0"` or a word, it SHALL match no revision and the API SHALL answer 412 the same way and SHALL NOT add a revision; `*`, which elsewhere in HTTP matches any current representation, does not match here, because adding a revision must name the revision it builds on. Each 412 SHALL carry the problem type `precondition-failed`. The handoff-packet capability defines the revisions themselves.

Source: D28 #21; D45 (6); design.md, Decisions this change rests on; design.md, Design rules: Handoff packet; design.md, Design rules: Public API; design.md, Decisions: D45 (6)

#### Scenario: A stale revision is refused

- **WHEN** two agents read FE-142's packet at revision 3, the first adds revision 4, and the second then sends a new revision with `If-Match` set to revision 3's `ETag`
- **THEN** the API answers 412
- **AND** the packet stays at revision 4

#### Scenario: A revision without If-Match is refused

- **WHEN** an agent sends a new revision of FE-142's packet, which is at revision 3, without an `If-Match` header
- **THEN** the API answers 428 with an RFC 9457 problem
- **AND** the packet stays at revision 3

#### Scenario: If-Match: * is refused

- **WHEN** an agent sends a new revision of FE-142's packet, which is at revision 3, with `If-Match: *`
- **THEN** the API answers 412 with an RFC 9457 problem whose problem type is `precondition-failed`
- **AND** the packet stays at revision 3

#### Scenario: A weak tag or a list is refused

- **WHEN** an agent sends a new revision of FE-142's packet, which is at revision 3, with `If-Match` set to `W/"3"`, or to `"3", "2"`, or to `3` without quotes
- **THEN** the API answers 412 with an RFC 9457 problem
- **AND** the packet stays at revision 3

#### Scenario: The body cannot name the revision

- **WHEN** an agent sends a new revision of FE-142's packet, which is at revision 3, without an `If-Match` header and with a body field that names revision 3
- **THEN** the API answers 428 with an RFC 9457 problem
- **AND** the packet stays at revision 3

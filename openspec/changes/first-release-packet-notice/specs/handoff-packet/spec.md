# Spec Delta: handoff-packet

## Purpose

Applies the 14-day notice of a breaking packet change to every release after the first, and lets the first release carry one announced any day before it. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Breaking packet changes before publication

Before the schema is published, a breaking change to the packet schema SHALL be announced in the changelog, through the notice channels the public-api capability defines, at least 14 days before it takes effect, and once Tiehall has a release, no later release, a release candidate included, SHALL contain it before that date. The first release and its release candidates MAY contain a breaking packet change announced at any time before them, because no released install, published schema or reader depends on the packet's earlier shape. The pull request that makes it SHALL carry the `api-breaking` label and SHALL add a changelog entry. Every conformance fixture that validated against an earlier beta version of the schema SHALL still validate against later beta versions, unless a breaking change was announced this way, and CI SHALL fail a pull request that breaks a fixture without the label. The rule that v1 only gains optional fields SHALL apply from publication on, not before.

Source: design.md, Decisions (1); the main change's design.md, Design rules: Handoff packet; Design rules: Public API

#### Scenario: Fourteen days' notice

- **WHEN** Tiehall has a release and a breaking packet change is announced in the changelog on 2026-11-02
- **THEN** no release that contains it is made before 2026-11-16

#### Scenario: The first release

- **WHEN** a breaking packet change is announced in the changelog on 2026-10-12 and the changelog records no release yet
- **THEN** the first release, version 1.0.0, and its release candidates may contain it on 2026-10-17

#### Scenario: A change without notice keeps old packets valid

- **WHEN** the packet schema changes before publication without an announced breaking change
- **THEN** every conformance fixture that validated before the change still validates

#### Scenario: A breaking packet change carries the label

- **WHEN** a pull request before publication makes a breaking packet change, so that an earlier fixture no longer validates
- **THEN** CI fails unless the pull request carries the `api-breaking` label
- **AND** with the label, the pull request also adds a changelog entry for the change

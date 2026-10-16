# Spec Delta: self-host-install

## Purpose

Widens the one exception of the release age rule: besides the version an advisory names as fixed, a reviewed pull request may take before its 7 days the version of an npm package that a maintainer's recorded answer calls for, recorded with that answer and a supply-chain review, and the release notes list every exception. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Release pipeline integrity

The CI pipeline that builds and publishes the image and the npm packages SHALL follow these rules:
- the default workflow token is read-only, and each job declares only the permissions it needs;
- every CI action is pinned to a commit SHA;
- updates to action pins, dependencies and base images are proposed only after a 7-day minimum release age, and are never merged automatically; base-image updates are proposed every week;
- dependencies install from a frozen lockfile, and install scripts run only for an allowlist of packages;
- the job that builds and pushes the image runs only first-party steps;
- third-party scanners run in their own job, with read-only package access and no secrets;
- the operating system's security patches are applied when the image is built, from Debian's signed archives for the base image's release, its security archive and its stable updates, without waiting for the 7-day release age, which keeps applying to npm packages, to CI actions and to the base image; the base image stays pinned by digest and changes only through a reviewed pull request after 7 days; the patches upgrade only the packages the base image carries, and the image keeps no package index once they are applied;
- a fixable HIGH or CRITICAL finding of the image scan in Node's binary or in an npm package, whose fixed version is younger than the 7-day release age, may be fixed before then by a reviewed pull request that takes exactly the version the advisory names as fixed, carries the `release-age-exception` label, adds a changelog entry that names the advisory, and excludes from the release age that one version only, until it is 7 days old; such an update is never proposed or merged automatically;
- an update of npm packages that a maintainer's recorded answer calls for, whose versions are younger than the 7-day release age, may be taken before then by a reviewed pull request that takes exactly the versions that update brings, carries the `release-age-exception` label, adds for each version a changelog entry that names, in place of an advisory, that answer and the supply-chain review of the version, which says what it compared, the version's provenance, its install scripts and its dependencies, and excludes from the release age each of those versions only, until it is 7 days old; such an update is never proposed or merged automatically.

CI SHALL check the workflow files for these rules, the Dockerfile for the rule on the operating system's security patches, and every exclusion from the release age for the label and the changelog entry, which names an advisory, or a maintainer's answer and the supply-chain review of the version, and SHALL fail a change that breaks one of them. CI SHALL also fail while an exclusion from the release age names a version past the day it turns 7 days old, until the exclusion and its changelog entry are removed. The notes of each release SHALL list the exceptions to the release age it carries, each version with the advisory or the maintainer's answer it rests on and the day it turns 7 days old.

Source: D38; D53; D55 (85), (86); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A new action version is released

- **WHEN** a new version of a CI action that the workflows use is released
- **THEN** no update to it is proposed before 7 days have passed
- **AND** the update is never merged without review

#### Scenario: An unpinned action

- **WHEN** a pull request adds a workflow step that refers to an action by a tag instead of a commit SHA
- **THEN** CI fails

#### Scenario: A scanner cannot reach a secret

- **WHEN** the workflow files are inspected
- **THEN** the job that runs the third-party scanner holds no secret and only read access to packages
- **AND** the job that pushes the image runs no third-party step

#### Scenario: A security fix for the base image's operating system

- **WHEN** Debian's security archive publishes a fixed version of a package that the pinned base image carries in a vulnerable version, such as `libssl3t64`, and no rebuilt base image is 7 days old yet
- **THEN** the next build of the image carries the fixed version
- **AND** the scan of that image reports no fixable HIGH or CRITICAL finding in that package
- **AND** the Dockerfile still names the same base image digest
- **AND** the image holds no package index

#### Scenario: The security patches dropped from the image build

- **WHEN** a pull request removes the step that applies the operating system's security patches from the Dockerfile's runtime stage, or moves it after the image switches to its non-root user
- **THEN** CI fails

#### Scenario: A fix outside Debian before 7 days

- **WHEN** the image scan reports a fixable HIGH finding in an npm package whose fixed version was published 2 days ago, and a reviewed pull request takes exactly that version with the `release-age-exception` label and a changelog entry that names the advisory
- **THEN** CI passes
- **AND** the release age excludes that package at that version only

#### Scenario: An exclusion without the label

- **WHEN** a pull request excludes a package's version from the release age without the `release-age-exception` label, or without a changelog entry that names an advisory or a maintainer's answer with the supply-chain review of the version
- **THEN** CI fails

#### Scenario: An update a maintainer's answer calls for, before 7 days

- **WHEN** a maintainer's recorded answer calls for a version of an npm package that was published 1 day ago, a supply-chain review of that version comes out clean, and a reviewed pull request takes exactly that version with the `release-age-exception` label and a changelog entry that names the answer and the review, with what the review compared, the version's provenance, its install scripts and its dependencies
- **THEN** CI passes
- **AND** the release age excludes that package at that version only
- **AND** the notes of a release that carries it name the version, the answer, the review and the day the version turns 7 days old

#### Scenario: An answer without its review

- **WHEN** a pull request excludes a package's version from the release age with the `release-age-exception` label and a changelog entry that names a maintainer's answer, but no supply-chain review, or a review that does not say the version's provenance
- **THEN** CI fails

#### Scenario: An exception past its 7 days

- **WHEN** a version excluded from the release age, for an advisory or for a maintainer's answer, turned 7 days old the day before
- **THEN** CI fails
- **AND** CI passes again once the exclusion and its changelog entry are removed

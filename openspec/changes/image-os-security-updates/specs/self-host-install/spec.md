# Spec Delta: self-host-install

## Purpose

Adds to the release pipeline's rules that the image applies the operating system's security patches when it is built, from Debian's signed security archive, while the base image keeps its digest pin and the 7-day release age. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Release pipeline integrity

The CI pipeline that builds and publishes the image and the npm packages SHALL follow these rules:
- the default workflow token is read-only, and each job declares only the permissions it needs;
- every CI action is pinned to a commit SHA;
- updates to action pins, dependencies and base images are proposed only after a 7-day minimum release age, and are never merged automatically; base-image updates are proposed every week;
- dependencies install from a frozen lockfile, and install scripts run only for an allowlist of packages;
- the job that builds and pushes the image runs only first-party steps;
- third-party scanners run in their own job, with read-only package access and no secrets;
- the operating system's security patches are applied when the image is built, from Debian's signed security archive, without waiting for the 7-day release age, which keeps applying to npm packages, to CI actions and to the base image; the base image stays pinned by digest and changes only through a reviewed pull request after 7 days; the patches upgrade only the packages the base image carries, and the image keeps no package index once they are applied.

CI SHALL check the workflow files for these rules, and the Dockerfile for the rule on the operating system's security patches, and SHALL fail a change that breaks one of them.

Source: D38; D53; design.md, Decisions this change rests on; design.md, Design rules: Operating-system security updates; design.md, Rules carried from add-tiehall-oss-v1

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

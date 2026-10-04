# Spec Delta: self-host-install

## Purpose

States the memory and process limits of Tiehall's containers, the rights an older image's migrate step leaves alone, what `admin grant` records before setup, GitHub Actions' OIDC host among the outbound connections, and the wording and the one exception of the release age rule for the image. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Tiehall's containers are confined

The `migrate` step and the app SHALL each run as a non-root user, with a read-only root filesystem, a memory-backed `/tmp`, all Linux capabilities dropped and no-new-privileges. The release Compose file SHALL also limit the memory and the number of processes of each: the app to 2 GiB and 512 processes, and the `migrate` step to 512 MiB and 128 processes; the install docs SHALL say that an operator may change these values. CI SHALL check the release Compose file for these settings, and for a Postgres service that publishes no port, and SHALL fail a change that breaks one of them.

Source: D55 (55); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: Writing outside tmp

- **WHEN** a process in the app container tries to write a file outside `/tmp`
- **THEN** the write fails

#### Scenario: CI catches a loosened setting

- **WHEN** a pull request gives the app service an added capability, or gives the Postgres service a published port
- **THEN** CI fails

#### Scenario: The limits ship with the Compose file

- **WHEN** an operator reads the release `compose.yaml`
- **THEN** the app's memory limit is 2 GiB and its process limit 512
- **AND** the `migrate` step's memory limit is 512 MiB and its process limit 128

#### Scenario: CI catches a removed limit

- **WHEN** a pull request removes the memory limit or the process limit of the app service
- **THEN** CI fails

### Requirement: Only the migrate step holds the database owner's credentials

The Compose file SHALL pass the database owner's password, or the owner's connection URL of an external Postgres, only to the `migrate` step. The app, and the operator commands of the `admin` role, SHALL connect as the app role, which SHALL NOT be the owner of any table and SHALL NOT be able to change or drop the database's refusal of updates and deletes of events that the activity-log capability defines. The `migrate` step SHALL set the app role's rights only on the tables that its own image's migrations know; a table it does not know, which a newer image created, SHALL keep the rights the newer image gave it, so that running an older image after a newer one never widens the app role's rights. `backup.sh` and `restore.sh` SHALL run on the host and read the owner's credentials from `.env`. The bundled Postgres SHALL accept no network connection without a password. CI SHALL check the release Compose file and SHALL fail a change that lets the app service read an owner secret.

Source: D55 (54); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The app service gets no owner secret

- **WHEN** a pull request passes the database owner's password to the app service in `compose.yaml`
- **THEN** CI fails

#### Scenario: The app cannot connect as the owner

- **WHEN** a process in the app container tries to connect to the bundled Postgres as the database owner
- **THEN** it has no owner password to connect with, and a connection without a password is refused

#### Scenario: An operator command connects as the app role

- **WHEN** Omar runs `admin grant dana-gh` on the host
- **THEN** the command connects to the database as the app role
- **AND** Dana's role change and its security event are stored

#### Scenario: An older image leaves a newer table's rights alone

- **WHEN** an install ran release 1.4.0, whose migrations created a table that the app role may only read, and the operator goes back to release 1.3.0, which does not know that table, so that 1.3.0's `migrate` step runs
- **THEN** the app role still may only read that table

### Requirement: Operator commands on the host

The image SHALL have an `admin` role for commands the operator runs on the host, which work without the web UI and without the confirmation step, because whoever can run them already controls the host:
- `admin grant <github-login>` SHALL make the member whose GitHub account has that login an admin; a login that belongs to no member of the install SHALL change nothing, and the command SHALL say so;
- `setup reopen` SHALL reopen the setup screen's GitHub App step and print a new setup code, so the operator can create the App again, for example after its credentials leaked or it was deleted.

While the App step is open again, the install SHALL keep serving its members, web sessions and tokens with the App in use until a new App's credentials are stored. The reopened step SHALL close only when a person whose Tiehall user is already an admin signs in with GitHub from the setup session, and closing it SHALL make nobody an admin; a sign-in from the setup session by anyone else SHALL be refused with 403. When a new App replaces the old one, Tiehall SHALL delete the old App's stored credentials, the old App's installations SHALL no longer be connected, and the installations made during the reopened step SHALL be connected. Members, teams, roles, web sessions, agent grants and personal access tokens SHALL stay as they were, and members who joined through a GitHub organization SHALL stay as the sign-in capability defines for an installation that is no longer connected. Each run of either command SHALL be recorded as a security event that names the command and what it changed, as the activity-log capability defines, except a run of `admin grant` before setup completes: no org and no member exist then, so it SHALL change nothing, SHALL say that setup is not complete, and SHALL record nothing.

Source: D55 (53); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: Recovering admin access

- **WHEN** Ada, the install's only admin, has lost access to their GitHub account, and Omar runs `admin grant dana-gh` on the host, where `dana-gh` is the login of Dana, a member
- **THEN** Dana's role becomes `admin`
- **AND** the activity log gains a security event for the operator command

#### Scenario: A login that belongs to no member

- **WHEN** Omar runs `admin grant no-such-member`
- **THEN** no role changes
- **AND** the command says that no member has that login

#### Scenario: Reopening the App step

- **WHEN** the App's private key has leaked and Omar runs `setup reopen`
- **THEN** a new setup code is printed
- **AND** `/setup` no longer answers 404, and with the new code it leads to the GitHub App step
- **AND** members keep using the install as before
- **AND** the activity log gains a security event for the operator command

#### Scenario: Only an admin closes the reopened step

- **WHEN** Omar has created a new App in the reopened step and installed it on `acme`, and Dana, whose role is `member`, signs in with GitHub from the setup session
- **THEN** the sign-in is refused with 403 and the step stays open
- **AND** when Ada, an admin, then signs in from the setup session, the step closes and the new App's installation on `acme` is connected
- **AND** no member's role has changed

#### Scenario: A new App replaces the old one

- **WHEN** the reopened step closes with a new App
- **THEN** Tiehall no longer holds the old App's credentials and no longer acts on its installations
- **AND** every member, team, role, web session and personal access token is unchanged

#### Scenario: `admin grant` before setup

- **WHEN** the setup screen has not been completed, and Omar runs `admin grant dana-gh`
- **THEN** no role changes
- **AND** the command says that setup is not complete
- **AND** the activity log holds no event for it

### Requirement: No telemetry and a documented list of outbound connections

An install SHALL send nothing to the Tiehall project or to any service it runs: no usage statistics, no update check, no error reports and no license check, and framework telemetry SHALL be off at build and at run time. An install's only outbound connections SHALL be to GitHub (its API and web, and `token.actions.githubusercontent.com`, from which Tiehall reads the keys that sign GitHub Actions' OIDC tokens to check a CI caller, as the agent-access capability defines), the configured Jira site, the SMTP server when one is set, and the Client ID Metadata Documents of agent clients that connect, which Tiehall fetches through its guarded fetcher, as the agent-safety capability defines. The docs SHALL list these hosts, so operators can write egress rules. GitHub.com MUST be reachable from the install and from users' browsers; air-gapped installs are not supported. The web UI and the API reference page SHALL load nothing from other hosts. CI SHALL run an egress test that fails on any DNS query or connection attempt to a host other than the stubs of these services.

Source: D33; D55 (57); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The egress test

- **WHEN** CI runs an install through setup and its main flows in a network where only stubs of GitHub, Jira and an SMTP server are reachable
- **THEN** the install makes no DNS query and no connection attempt to any other host
- **AND** the test fails if it does

#### Scenario: An install without Jira or SMTP

- **WHEN** an install has no Jira connection and no SMTP settings, and no agent client has connected with a metadata document
- **THEN** its only outbound connections are to GitHub

#### Scenario: The web UI loads nothing from other hosts

- **WHEN** a signed-in member opens the web UI and the page `/docs/api`
- **THEN** the browser loads every script, style sheet, font and image from `TIEHALL_URL`'s origin

#### Scenario: A CI caller's keys come from GitHub Actions

- **WHEN** the contract Action reports to an install that holds no copy of GitHub Actions' keys yet
- **THEN** the install connects to `token.actions.githubusercontent.com` to read them
- **AND** to no host outside the documented list

### Requirement: Release pipeline integrity

The CI pipeline that builds and publishes the image and the npm packages SHALL follow these rules:
- the default workflow token is read-only, and each job declares only the permissions it needs;
- every CI action is pinned to a commit SHA;
- updates to action pins, dependencies and base images are proposed only after a 7-day minimum release age, and are never merged automatically; base-image updates are proposed every week;
- dependencies install from a frozen lockfile, and install scripts run only for an allowlist of packages;
- the job that builds and pushes the image runs only first-party steps;
- third-party scanners run in their own job, with read-only package access and no secrets;
- the operating system's security patches are applied when the image is built, from Debian's signed archives for the base image's release, its security archive and its stable updates, without waiting for the 7-day release age, which keeps applying to npm packages, to CI actions and to the base image; the base image stays pinned by digest and changes only through a reviewed pull request after 7 days; the patches upgrade only the packages the base image carries, and the image keeps no package index once they are applied;
- a fixable HIGH or CRITICAL finding of the image scan in Node's binary or in an npm package, whose fixed version is younger than the 7-day release age, may be fixed before then by a reviewed pull request that takes exactly the version the advisory names as fixed, carries the `release-age-exception` label, adds a changelog entry that names the advisory, and excludes from the release age that one version only, until it is 7 days old; such an update is never proposed or merged automatically.

CI SHALL check the workflow files for these rules, the Dockerfile for the rule on the operating system's security patches, and every exclusion from the release age for the label and the changelog entry, and SHALL fail a change that breaks one of them.

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

- **WHEN** a pull request excludes a package's version from the release age without the `release-age-exception` label or without a changelog entry that names an advisory
- **THEN** CI fails

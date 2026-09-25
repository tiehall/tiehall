# Spec Delta: self-host-install

## Purpose

Defines how a company installs and runs its own Tiehall: the Compose file and the one `.env`, the first-run setup screen with its setup code and the install's GitHub App, the operator commands, backups, upgrades, and what an install sends outside the company.

## ADDED Requirements

### Requirement: No model calls

Tiehall SHALL NOT call a language model, SHALL NOT host or run agents, and SHALL NOT send data to a model vendor; agents connect to it. Contract-change routing SHALL use the declared consumer map, change classification SHALL come from the diff engine that runs in the provider's CI or on a developer's machine, and every summary, digest, notice and receipt Tiehall writes SHALL be produced from templates. The documented list of outbound hosts SHALL name no model vendor.

Source: D3; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S13

#### Scenario: Summaries come from templates

- **WHEN** Tiehall writes the mirror summary of request FE-142 twice while the request does not change
- **THEN** both summaries are identical

#### Scenario: No model vendor among the outbound hosts

- **WHEN** an operator reads the documented list of hosts an install connects to
- **THEN** none of them is a model vendor

#### Scenario: The egress test sees no model call

- **WHEN** CI runs the egress test that the requirement on outbound connections defines, through setup, opening and answering requests, a contract report and the mirrors
- **THEN** the install connects to no host other than the stubs of GitHub, Jira and an SMTP server, so it calls no model

### Requirement: Compose runs Tiehall and Postgres

Each release SHALL publish a Compose file, `compose.yaml`, that runs a stock Postgres 17 image, a one-shot `migrate` step, and the Tiehall app in its `all` role, which serves the web UI, `/api/v1`, `/mcp`, the OAuth endpoints and the webhooks, and runs the background jobs in the same container. An install SHALL need Docker with Compose and nothing else: no cache, no object store, no cloud-vendor service and no service run by the Tiehall project. Once the operator has written `.env`, `docker compose up -d` SHALL be the one command that starts the install, and the app SHALL start only after the `migrate` step has finished. The Postgres service SHALL publish no port. An operator MAY use an external Postgres 17 or later instead of the bundled one, through two connection URLs in `.env`, one for the database owner and one for the app. CI SHALL boot the release Compose file against stock Postgres 17 on every build of the main branch, and SHALL run a fresh-install test, from a `.env` printed by `init` through the setup screen, before each release.

Source: D33; D36; design.md, Decisions this change rests on; design.md, Technical decisions: T17; design.md, Self-hosting decisions: S2

#### Scenario: Starting an install

- **WHEN** Omar has written `.env` with `init` for `https://tiehall.example.com` and runs `docker compose up -d`
- **THEN** Postgres starts, the `migrate` step finishes, and only then does the app start
- **AND** opening `https://tiehall.example.com/` leads to `/setup`

#### Scenario: Nothing else to run

- **WHEN** an operator reads the release `compose.yaml`
- **THEN** its services are Postgres, the `migrate` step, the app, and the reverse proxy of the optional `caddy` profile
- **AND** the Postgres service publishes no port

#### Scenario: An external Postgres

- **WHEN** `.env` gives the owner and app connection URLs of an external Postgres 17 database, and Omar runs `docker compose up -d`
- **THEN** the `migrate` step runs against that database
- **AND** the app stores its data there

#### Scenario: CI boots the Compose file

- **WHEN** a build of the main branch finishes
- **THEN** CI has booted the Compose file with the app in its `all` role against stock Postgres 17
- **AND** the build reports whether the install came up healthy

### Requirement: One `.env` holds the install settings

Every install setting SHALL live in one `.env` file next to `compose.yaml`: `TIEHALL_URL`, the install's public base URL; `TIEHALL_IMAGE`, pinned by version and digest; the database owner and app passwords, or the two connection URLs of an external Postgres; `TIEHALL_SECRET_KEY`, which encrypts stored integration secrets; `TIEHALL_AUTH_SECRET`, which signs sessions and tokens; the reverse proxies whose forwarded headers are trusted; `TIEHALL_CLIENT_METADATA_FETCH`, as the requirement on metadata-document fetching defines; and the optional SMTP settings and `TIEHALL_SOURCE_URL`. Every secret setting SHALL also accept a `*_FILE` form that names a file holding the value. Settings that are connections rather than install settings SHALL live in the admin UI and the database, encrypted when they are secret, and SHALL need no change to `.env` and no restart: the GitHub App's credentials, the connected installations, the sign-in policy, the Jira connection, team mappings, registered APIs, and the personal-access-token and write-budget settings.

Source: D36; design.md, Decisions this change rests on; design.md, Technical decisions: T7; design.md, Self-hosting decisions: S2

#### Scenario: A secret read from a file

- **WHEN** `.env` sets `TIEHALL_SECRET_KEY_FILE` to a file that holds the key, and does not set `TIEHALL_SECRET_KEY`
- **THEN** the install starts and encrypts stored integration secrets with the key from that file

#### Scenario: A connection needs no change to `.env`

- **WHEN** an admin connects the company's Jira site in the admin UI
- **THEN** the connection works without any change to `.env` and without a restart
- **AND** the Jira API token is stored encrypted in the database

### Requirement: `init` prints a complete `.env`

The image SHALL have an `init` role that prints a complete `.env` with fresh random secrets for the URL it is given, for example `docker run --rm <image> init --url https://tiehall.example.com > .env`. Each run SHALL generate new secrets, and the printed file SHALL start an install without further edits. Each release SHALL also publish `.env.example`, which names every setting.

Source: D36; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S2

#### Scenario: Fresh secrets on each run

- **WHEN** Omar runs `init --url https://tiehall.example.com` twice
- **THEN** both outputs set `TIEHALL_URL` to `https://tiehall.example.com`
- **AND** no secret value in the first output appears in the second

#### Scenario: The printed file starts an install

- **WHEN** Omar writes the output of `init` to `.env` without editing it and runs `docker compose up -d`
- **THEN** the install starts and serves the setup screen

### Requirement: `TIEHALL_URL` and TLS

`TIEHALL_URL` MUST use HTTPS, except `http://localhost`, with or without a port, for a trial on one machine; any other plain-HTTP host, `http://127.0.0.1` included, is not accepted. Tiehall SHALL refuse to start with any other `TIEHALL_URL`, and its log SHALL say why. TLS SHALL come either from the optional `caddy` profile of the Compose file, which obtains and renews certificates automatically, or from the operator's own reverse proxy. Without the `caddy` profile, the app SHALL publish one port, bound to `127.0.0.1` by default. Tiehall SHALL trust forwarded headers only from the proxies that `.env` names, and SHALL ignore them on requests from any other address.

Source: design.md, Self-hosting decisions: S2

#### Scenario: A plain-HTTP public URL

- **WHEN** `.env` sets `TIEHALL_URL` to `http://tiehall.example.com` and Omar runs `docker compose up -d`
- **THEN** the app does not start
- **AND** its log names `TIEHALL_URL` as the reason

#### Scenario: A trial on one machine

- **WHEN** `.env` sets `TIEHALL_URL` to `http://localhost`, or to `http://localhost:3000`
- **THEN** the app starts

#### Scenario: A loopback address is not a trial URL

- **WHEN** `.env` sets `TIEHALL_URL` to `http://127.0.0.1:3000`
- **THEN** the app does not start
- **AND** its log names `TIEHALL_URL` as the reason

#### Scenario: TLS through the caddy profile

- **WHEN** `TIEHALL_URL` is `https://tiehall.example.com`, the host name resolves to the host, and Omar runs `docker compose --profile caddy up -d`
- **THEN** `https://tiehall.example.com/` is served with a certificate the profile obtained automatically

#### Scenario: The app port stays on the host

- **WHEN** the install runs without the `caddy` profile and with the default settings
- **THEN** the app's port answers on `127.0.0.1` of the host
- **AND** a connection to that port from another machine gets no answer

#### Scenario: A forwarded header from an address that is not a named proxy

- **WHEN** a sign-in request reaches the app from an address that `.env` does not name as a proxy, carrying a forwarded-for header that names `203.0.113.7`
- **THEN** the security event for the sign-in records the connection's own address, not `203.0.113.7`

### Requirement: Tiehall's containers are confined

The `migrate` step and the app SHALL each run as a non-root user, with a read-only root filesystem, a memory-backed `/tmp`, all Linux capabilities dropped and no-new-privileges. CI SHALL check the release Compose file for these settings, and for a Postgres service that publishes no port, and SHALL fail a change that breaks one of them.

Source: design.md, Self-hosting decisions: S2

#### Scenario: Writing outside tmp

- **WHEN** a process in the app container tries to write a file outside `/tmp`
- **THEN** the write fails

#### Scenario: CI catches a loosened setting

- **WHEN** a pull request gives the app service an added capability, or gives the Postgres service a published port
- **THEN** CI fails

### Requirement: Only the migrate step holds the database owner's credentials

The Compose file SHALL pass the database owner's password, or the owner's connection URL of an external Postgres, only to the `migrate` step. The app, and the operator commands of the `admin` role, SHALL connect as the app role, which SHALL NOT be the owner of any table and SHALL NOT be able to change or drop the database's refusal of updates and deletes of events that the activity-log capability defines. `backup.sh` and `restore.sh` SHALL run on the host and read the owner's credentials from `.env`. The bundled Postgres SHALL accept no network connection without a password. CI SHALL check the release Compose file and SHALL fail a change that lets the app service read an owner secret.

Source: design.md, Technical decisions: T4; design.md, Technical decisions: T17; design.md, Self-hosting decisions: S2; design.md, Self-hosting decisions: S14

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

### Requirement: The setup code guards the setup screen

Until setup is complete, every page SHALL lead to `/setup`, and API calls SHALL answer 503 with the problem type `setup-required`, as the public-api capability's error model defines, the OpenAPI document at `/api/v1/openapi.json` included; `/docs/api` is a page and leads to `/setup`. The only routes served before setup completes SHALL be `/setup`, `/healthz` and, from the moment the setup screen has stored the GitHub App's credentials, `/webhooks/github`, which SHALL verify and store deliveries as the tracker-mirrors capability defines and process them once setup completes. While setup is incomplete, the app SHALL print a one-time setup code to its log each time it starts, where `docker compose logs app` shows it. The code SHALL carry at least 128 bits of randomness; Tiehall SHALL store only a hash of it, and each start SHALL replace it. Only a browser that enters the current code SHALL get a setup session; a wrong code SHALL be refused with 403 and SHALL open no session. Every step of the setup screen SHALL need that session. The setup screen SHALL check that the browser's origin matches `TIEHALL_URL`, and SHALL NOT continue when it does not.

Source: design.md, Technical decisions: T7; design.md, Technical decisions: T16; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S9

#### Scenario: Pages lead to the setup screen

- **WHEN** setup is not complete and a browser opens `https://tiehall.example.com/FE-142`
- **THEN** it is redirected to `/setup`

#### Scenario: The API before setup

- **WHEN** setup is not complete and a client calls an `/api/v1` operation
- **THEN** the call answers 503 with an RFC 9457 problem whose problem type is `setup-required`

#### Scenario: A stranger without the code

- **WHEN** setup is not complete and a visitor who cannot read the container log opens `/setup` and enters a wrong code
- **THEN** the answer is 403 and they get no setup session
- **AND** no setup step, App creation or account is available to them

#### Scenario: The OpenAPI document waits for setup

- **WHEN** setup is not complete and a client requests `/api/v1/openapi.json`
- **THEN** the answer is 503 with the problem type `setup-required`

#### Scenario: Health checks work before setup

- **WHEN** setup is not complete and the Compose health check requests `/healthz`
- **THEN** the answer is "up"

#### Scenario: A delivery during setup is kept

- **WHEN** the setup screen has stored the App's credentials, Omar installs the App on `acme`, and GitHub delivers the `installation` event to `https://tiehall.example.com/webhooks/github` before Omar signs in
- **THEN** Tiehall verifies and stores the delivery and answers with a 2xx status
- **AND** processes it once setup completes

#### Scenario: A restart replaces the code

- **WHEN** Omar read the setup code, the app restarted before Omar entered it, and Omar enters the old code
- **THEN** they get no setup session
- **AND** the log shows a new code, which opens a setup session

#### Scenario: Only a hash is stored

- **WHEN** the database is read while setup is incomplete
- **THEN** it does not hold the current setup code in plain text

#### Scenario: The browser's origin does not match

- **WHEN** `TIEHALL_URL` is `https://tiehall.example.com`, and Omar opens the setup screen through `http://10.0.0.5:3000` and enters the current code
- **THEN** the setup screen does not continue

### Requirement: Setup names the company and makes the first admin

The setup screen SHALL ask for the company's name, which becomes the name of the install's one org, as the teams-and-roles capability defines. It SHALL then create the install's GitHub App as the requirement on the manifest flow defines, send the operator to install the App on their GitHub organization, and have them sign in with GitHub from the setup session. The person who signs in SHALL become the install's first admin, and the App installations they made during setup SHALL be connected, as the tracker-mirrors capability defines connected installations. Setup SHALL then close for good: the setup code SHALL stop working, `/setup` SHALL answer 404, and pages and API calls SHALL be served. Only the operator command `setup reopen` SHALL open it again. The completion of setup SHALL be recorded as a security event, as the activity-log capability defines.

Source: D36; D37; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S14

#### Scenario: The operator becomes the first admin

- **WHEN** Omar enters the setup code, names the company "Acme", creates the App, installs it on the GitHub organization `acme`, and signs in with GitHub from the setup session
- **THEN** the install's org is named "Acme"
- **AND** Omar is a member with the role `admin`
- **AND** the installation on `acme` is connected
- **AND** the activity log gains a security event for the completion of setup

#### Scenario: Setup closes for good

- **WHEN** setup has completed and someone opens `https://tiehall.example.com/setup` or enters the setup code that was last printed
- **THEN** `/setup` answers 404
- **AND** no setup session is opened

#### Scenario: The API after setup

- **WHEN** setup has completed and a client calls `/api/v1/openapi.json`
- **THEN** the call answers 200 with the OpenAPI document

### Requirement: The GitHub App is created with GitHub's manifest flow

The setup screen SHALL create the install's GitHub App through GitHub's App manifest flow. It SHALL post the manifest to the new-App page of the GitHub organization that the operator names as the App's owner, which the screen recommends, or to the operator's personal new-App page when they name none. A `state` value bound to the setup session SHALL protect the round trip: a return whose `state` is missing or not bound to the current setup session SHALL be refused and SHALL store nothing. The manifest SHALL set:
- the App's name, by default made of "Tiehall" and the install's host, which the operator can edit, because App names are unique on GitHub;
- the App's URL, its sign-in callback URL and its redirect URL, all on `TIEHALL_URL`;
- the webhook URL `TIEHALL_URL/webhooks/github`, with the webhook active;
- `public` set to false;
- the permissions and events that the tracker-mirrors capability lists.

When GitHub redirects back with a code, Tiehall SHALL exchange it within the hour for the App's id, slug, client id and client secret, webhook secret and private key, and SHALL store them as the requirement on stored integration secrets defines. The App SHALL serve sign-in, PR links, close on merge, the GitHub Issues mirror, the mapping of PR authors to users and the organization-membership checks, and Tiehall SHALL call GitHub with the App's installation tokens, never with a user's token. The App SHALL be private, so it installs only on its owner; a company with several GitHub organizations can make it public in GitHub's settings and install it on each, and Tiehall acts only on installations an admin has connected, as the tracker-mirrors capability defines.

Source: D37; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S4

#### Scenario: An App owned by the company's organization

- **WHEN** Omar names the GitHub organization `acme` as the App's owner on the setup screen of `https://tiehall.example.com`
- **THEN** the manifest is posted to the new-App page of `acme`
- **AND** its webhook URL is `https://tiehall.example.com/webhooks/github`, with the webhook active
- **AND** it sets `public` to false
- **AND** it asks for exactly the permissions and events that the tracker-mirrors capability lists

#### Scenario: The operator edits the App's name

- **WHEN** the default name made of "Tiehall" and `tiehall.example.com` is taken on GitHub, and Omar changes the name to "Tiehall Acme" before creating the App
- **THEN** the manifest carries the name "Tiehall Acme"

#### Scenario: GitHub returns the App's credentials

- **WHEN** GitHub redirects back to the setup screen with a code and the `state` bound to Omar's setup session
- **THEN** Tiehall stores the App's id, slug, client id, client secret, webhook secret and private key
- **AND** the setup screen sends Omar on to install the App

#### Scenario: A return with a foreign state

- **WHEN** a redirect to the setup screen carries a code and a `state` that is not bound to the current setup session
- **THEN** it is refused
- **AND** no App credentials are stored

### Requirement: A rotated App key can be uploaded

An admin SHALL be able to upload a new private key for the install's GitHub App after rotating it in GitHub's settings, in the web UI and with the confirmation step, as the agent-safety capability defines. Before storing the key, Tiehall SHALL check it by requesting an installation token with it; a key that fails the check SHALL NOT be stored, and the key in use SHALL stay. Each stored key SHALL be recorded as a security event, as the activity-log capability defines.

Source: D37; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S4; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: A valid new key

- **WHEN** Ada, an admin, generates a new private key in the App's GitHub settings, uploads it and confirms the upload in the web UI
- **THEN** Tiehall stores the new key and uses it for its next call to GitHub
- **AND** the activity log gains a security event for the upload

#### Scenario: A key that fails the check

- **WHEN** Ada uploads, with the confirmation step, a private key that belongs to another GitHub App
- **THEN** the key is not stored
- **AND** Tiehall keeps calling GitHub with the key in use

#### Scenario: An upload without the confirmation step

- **WHEN** Ada uploads a new private key without confirming the upload in the web UI
- **THEN** the upload is refused with 403
- **AND** the key in use is unchanged

### Requirement: Stored integration secrets are encrypted

Integration secrets that Tiehall stores in its database, such as the GitHub App's client secret, webhook secret and private key and the Jira bot's API token, SHALL be encrypted under `TIEHALL_SECRET_KEY`, and each SHALL name the id of the key that encrypted it. `TIEHALL_SECRET_KEY` SHALL NOT be stored in the database, so a copy or a dump of the database without it SHALL NOT be able to use those secrets.

Source: design.md, Technical decisions: T4; design.md, Self-hosting decisions: S2; design.md, Self-hosting decisions: S11

#### Scenario: A stored secret read from the database

- **WHEN** the stored Jira API token is read directly from the database
- **THEN** only ciphertext and a key id are visible

#### Scenario: A restored dump without the key

- **WHEN** a dump of the install is restored into a new install whose `.env` holds a different `TIEHALL_SECRET_KEY`
- **THEN** the new install cannot call GitHub or Jira with any stored credential

### Requirement: Operator commands on the host

The image SHALL have an `admin` role for commands the operator runs on the host, which work without the web UI and without the confirmation step, because whoever can run them already controls the host:
- `admin grant <github-login>` SHALL make the member whose GitHub account has that login an admin; a login that belongs to no member of the install SHALL change nothing, and the command SHALL say so;
- `setup reopen` SHALL reopen the setup screen's GitHub App step and print a new setup code, so the operator can create the App again, for example after its credentials leaked or it was deleted.

While the App step is open again, the install SHALL keep serving its members, web sessions and tokens with the App in use until a new App's credentials are stored. The reopened step SHALL close only when a person whose Tiehall user is already an admin signs in with GitHub from the setup session, and closing it SHALL make nobody an admin; a sign-in from the setup session by anyone else SHALL be refused with 403. When a new App replaces the old one, Tiehall SHALL delete the old App's stored credentials, the old App's installations SHALL no longer be connected, and the installations made during the reopened step SHALL be connected. Members, teams, roles, web sessions, agent grants and personal access tokens SHALL stay as they were, and members who joined through a GitHub organization SHALL stay as the sign-in capability defines for an installation that is no longer connected. Each run of either command SHALL be recorded as a security event that names the command and what it changed, as the activity-log capability defines.

Source: design.md, Technical decisions: T4; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

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

### Requirement: Backups with the shipped scripts

Each release SHALL ship `backup.sh` and `restore.sh` next to `compose.yaml`. `backup.sh` SHALL make a Postgres custom-format dump inside the Postgres container, so the dump always matches the server's major version, write it as a timestamped file readable only by its owner into a backups directory, and then record in the database the time the backup finished. `restore.sh <file>` SHALL stop the app, restore the dump into the database and start the app again, whose `migrate` step brings a dump from an older release up to the running release. The docs SHALL tell operators to run `backup.sh` daily, with a cron example, and before every upgrade; to copy dumps off the host; and to back up `.env` separately and keep it secret, because a dump alone cannot use the stored integration secrets. Point-in-time recovery is left to the operator's own Postgres tooling or a managed Postgres. CI SHALL run a backup-and-restore round trip before each release: back up, restore into an empty database, boot, and find the data.

Source: D36; design.md, Decisions this change rests on; design.md, Technical decisions: T17; design.md, Self-hosting decisions: S11

#### Scenario: Taking a backup

- **WHEN** Omar runs `backup.sh`
- **THEN** a new dump file whose name carries the time appears in the backups directory
- **AND** only its owner can read it
- **AND** the admin page shows the time the backup finished

#### Scenario: Restoring into an empty database

- **WHEN** Omar runs `restore.sh` with a dump into an install whose database is empty
- **THEN** the app starts again
- **AND** the teams, members and requests from the dump are there

#### Scenario: Restoring a dump from an older release

- **WHEN** Omar restores a dump made on release 1.2.0 while the install runs release 1.3.0
- **THEN** the `migrate` step brings the data up to release 1.3.0 before the app starts

### Requirement: The admin page warns about missing backups

The admin page SHALL show when the last backup finished, and SHALL warn when no backup has finished yet or none has finished in the last 7 days.

Source: design.md, Self-hosting decisions: S11

#### Scenario: No backup yet

- **WHEN** an admin opens the admin page of an install on which `backup.sh` has never finished
- **THEN** the page warns that no backup has run

#### Scenario: The last backup is too old

- **WHEN** the last backup finished 8 days ago
- **THEN** the admin page shows its time and warns that no backup has finished in the last 7 days

#### Scenario: A recent backup

- **WHEN** the last backup finished 2 days ago
- **THEN** the admin page shows its time and no backup warning

### Requirement: Upgrades apply migrations before the app starts

To upgrade, the operator SHALL only need to back up, set the new `TIEHALL_IMAGE` in `.env`, and run `docker compose pull && docker compose up -d`. The `migrate` step SHALL run every pending migration before the app starts on the new image; if a migration fails, the app SHALL NOT start on the new image, and the log SHALL say why. Migrations SHALL never run backwards; problems are fixed by a later migration. Releases SHALL use semantic versions, and skipping releases SHALL work, because migrations run in order; the release notes SHALL name any release that must not be skipped. CI SHALL test an upgrade from the previous release's image with seeded data before each release. The admin page SHALL show the running version.

Source: D36; design.md, Decisions this change rests on; design.md, Technical decisions: T4; design.md, Technical decisions: T17; design.md, Self-hosting decisions: S12

#### Scenario: Migrations finish first

- **WHEN** Omar sets `TIEHALL_IMAGE` to release 1.3.0 and runs `docker compose pull && docker compose up -d`
- **THEN** every pending migration has finished before the app starts on release 1.3.0
- **AND** the admin page shows version 1.3.0

#### Scenario: A failed migration

- **WHEN** a migration of the new release fails during an upgrade
- **THEN** the app does not start on the new image
- **AND** the log of the `migrate` step says why

#### Scenario: Skipping a release

- **WHEN** an install on release 1.2.0 upgrades straight to release 1.4.0, and no release note says 1.3.0 must not be skipped
- **THEN** the migrations of 1.3.0 and then those of 1.4.0 run in order
- **AND** the app starts on 1.4.0

### Requirement: Migrations expand, then contract

A release's migrations SHALL only add to the schema, such as tables, nullable columns and indexes; backfills SHALL run as batched background jobs, never inside migrations; and contract steps, such as dropping a column, SHALL ship at least one release after the expand step they follow and SHALL be flagged in that release's notes. When a background job's payload changes shape, its jobs SHALL go to a new queue name, so a worker of an earlier release never takes a job it cannot read. Until a contract step has run, the previous release's image SHALL run on the newer schema, so going back SHALL only take setting the previous `TIEHALL_IMAGE` and running `docker compose up -d`. After a contract step has run, the way back SHALL be the backup taken before the upgrade, restored with the previous image. The `migrate` step SHALL refuse, with a clear message in its log, to start an image older than the database's schema can serve, meaning older than a release whose contract step has run on it, and the app SHALL then not start on that image.

Source: D36; design.md, Decisions this change rests on; design.md, Technical decisions: T4; design.md, Technical decisions: T6; design.md, Self-hosting decisions: S12

#### Scenario: Going back before a contract step

- **WHEN** release 1.3.0 added a column in an expand step, and Omar sets `TIEHALL_IMAGE` back to release 1.2.0 and runs `docker compose up -d`
- **THEN** the app starts on release 1.2.0 and serves the install's data

#### Scenario: An image older than the schema

- **WHEN** release 1.4.0 ran a contract step that dropped a column release 1.2.0 reads, and Omar sets `TIEHALL_IMAGE` to release 1.2.0 and runs `docker compose up -d`
- **THEN** the `migrate` step refuses to start, with a message that the image is older than the database's schema
- **AND** the app does not start on release 1.2.0

#### Scenario: Contract steps are flagged

- **WHEN** a release contains a contract step
- **THEN** its release notes flag that step
- **AND** the expand step it follows shipped in an earlier release

#### Scenario: A job whose payload changes shape

- **WHEN** a release changes the payload shape of a background job
- **THEN** its new jobs go to a new queue name
- **AND** a worker of the previous release never receives them

### Requirement: A restart stops the app gracefully

An upgrade or restart SHALL stop the app container gracefully. While the app shuts down, it SHALL answer new calls with 503 and `Retry-After: 0`, as the public-api capability's error model defines, and SHALL end open long-poll waits as the requester-loop capability defines for the wait endpoint, so clients retry once the app is back. The worker SHALL stop gracefully: a background job that has not finished SHALL run again after the restart, so no job is lost. One `all` container is the supported shape of an install, so an upgrade interrupts service while the container restarts.

Source: design.md, Technical decisions: T6; design.md, Technical decisions: T15; design.md, Self-hosting decisions: S12

#### Scenario: A mirror job running during an upgrade

- **WHEN** the job that creates the mirror issue of FE-142 is running and Omar runs `docker compose up -d` with a new image
- **THEN** once the app is back, the job has either finished before the stop or runs again
- **AND** exactly one mirror issue exists for FE-142

#### Scenario: A call during shutdown

- **WHEN** the app is shutting down for an upgrade and a client calls an `/api/v1` operation
- **THEN** the call answers 503 with `Retry-After: 0`

### Requirement: Optional email through SMTP

Email SHALL be optional. `.env` MAY hold SMTP settings: host, port, TLS mode, user, password and from address. With them, Tiehall SHALL send the emails that the other capabilities name, to each user's GitHub primary verified email, as the sign-in capability defines. Without them, Tiehall SHALL send no email, its notices SHALL stay in the web inbox and in admin banners, and every v1 feature SHALL work. The admin page SHALL show whether email is set up and SHALL be able to send a test message.

Source: design.md, Self-hosting decisions: S10

#### Scenario: No email without SMTP

- **WHEN** `.env` holds no SMTP settings and a proposal waits for Dana's confirmation
- **THEN** Tiehall sends no email
- **AND** the proposal is in Dana's web inbox

#### Scenario: A test message

- **WHEN** `.env` holds SMTP settings and Ada, an admin, asks the admin page to send a test message
- **THEN** Tiehall sends a test email through the configured SMTP server

#### Scenario: The admin page shows the email state

- **WHEN** an admin opens the admin page of an install without SMTP settings
- **THEN** the page shows that email is not set up

### Requirement: No telemetry and a documented list of outbound connections

An install SHALL send nothing to the Tiehall project or to any service it runs: no usage statistics, no update check, no error reports and no license check, and framework telemetry SHALL be off at build and at run time. An install's only outbound connections SHALL be to GitHub (its API and web), the configured Jira site, the SMTP server when one is set, and the Client ID Metadata Documents of agent clients that connect, which Tiehall fetches through its guarded fetcher, as the agent-safety capability defines. The docs SHALL list these hosts, so operators can write egress rules. GitHub.com MUST be reachable from the install and from users' browsers; air-gapped installs are not supported. The web UI and the API reference page SHALL load nothing from other hosts. CI SHALL run an egress test that fails on any DNS query or connection attempt to a host other than the stubs of these services.

Source: D33; design.md, Decisions this change rests on; design.md, Technical decisions: T17; design.md, Self-hosting decisions: S13

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

### Requirement: The setting that switches metadata-document fetching off

`.env` SHALL have the setting `TIEHALL_CLIENT_METADATA_FETCH`, which is `on` when it is not set and which the operator sets to `off` to stop the fetching of Client ID Metadata Documents. While it is `off`, Tiehall SHALL make no outbound request for a metadata document, and the install's only outbound connections SHALL be the others the requirement on outbound connections lists. How the authorization server behaves while fetching is off, and that Dynamic Client Registration stays available, is defined by the agent-access capability.

Source: D28 #43; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S2; design.md, Self-hosting decisions: S13

#### Scenario: Fetching is off

- **WHEN** `.env` sets `TIEHALL_CLIENT_METADATA_FETCH=off`, and an agent client starts authorization with the `client_id` `https://vendor.example/oauth/client.json`
- **THEN** the install makes no connection to `vendor.example`

#### Scenario: Fetching is on by default

- **WHEN** `.env` does not set `TIEHALL_CLIENT_METADATA_FETCH`
- **THEN** Tiehall fetches the metadata documents of agent clients that connect, through its guarded fetcher

### Requirement: `/healthz` answers only up or down

`/healthz` SHALL need no authentication and SHALL answer only "up" or "down". It SHALL NOT reveal the version, the schema state or any other detail; the running version is shown on the admin page.

Source: design.md, Self-hosting decisions: S12; design.md, Self-hosting decisions: S13

#### Scenario: A healthy install

- **WHEN** an unauthenticated client requests `/healthz` of a running install
- **THEN** the answer is "up"
- **AND** it contains no version or schema state

#### Scenario: The database is unreachable

- **WHEN** the app cannot reach its database and a client requests `/healthz`
- **THEN** the answer is "down"

### Requirement: Logs carry ids, never message text or credentials

Tiehall's logs SHALL be JSON on standard output and SHALL carry ids, never the text of messages or packets. They SHALL NOT contain credentials: no access token, refresh token, personal access token, OIDC token, session cookie, confirmation nonce, API token or App secret, no `Authorization` or `Cookie` header, and no query string. The one secret the log shows SHALL be the setup code, which the requirement on the setup code prints there on purpose. CI SHALL send a canary string and a canary token through a failing request and a failing background job, and SHALL fail when either appears in the logs.

Source: design.md, Technical decisions: T17; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S13

#### Scenario: A failing request carries message text

- **WHEN** a request whose message body contains a canary string fails
- **THEN** the canary string appears nowhere in the app's log

#### Scenario: A failing job carries message text

- **WHEN** a background job for a message that contains a canary string fails
- **THEN** the canary string appears nowhere in the app's log
- **AND** the log names the job and the message by their ids

#### Scenario: A failing request carries a token

- **WHEN** a request whose `Authorization` header holds a canary personal access token, and whose URL carries the query string `?token=canary`, fails
- **THEN** neither the canary token nor the query string appears anywhere in the app's log

### Requirement: The running version links to its source

The web UI's footer and the admin page SHALL show the running version with a link to its source. By default the link SHALL point to that release's source in the public Tiehall repository. When `.env` sets `TIEHALL_SOURCE_URL`, the link SHALL point there instead, so an operator who runs a modified server offers its users the modified source, as the AGPL-3.0 asks of a server offered over a network. The license of each part of the repository is defined by the public-api capability.

Source: D34; D38; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S16

#### Scenario: The default source link

- **WHEN** an install runs release 1.3.0 without `TIEHALL_SOURCE_URL` and a member looks at the web UI's footer
- **THEN** it shows version 1.3.0 with a link to the source of release 1.3.0 in the public Tiehall repository

#### Scenario: A modified server

- **WHEN** `.env` sets `TIEHALL_SOURCE_URL` to `https://git.acme.example/tiehall-fork`
- **THEN** the footer and the admin page link to `https://git.acme.example/tiehall-fork`

### Requirement: Releases carry signed attestations

Each release SHALL build the image once, in CI, from this public repository, and SHALL name it by digest. Each image SHALL carry signed build-provenance and SBOM attestations that operators can check with GitHub's artifact attestation verification. A release SHALL publish the image digest and version tag, `compose.yaml`, the `Caddyfile`, `.env.example`, `backup.sh`, `restore.sh` and the release notes.

Source: D38; design.md, Decisions this change rests on; design.md, Technical decisions: T13

#### Scenario: An operator checks an image

- **WHEN** Omar checks the attestations of the image digest named in release 1.3.0 against the public Tiehall repository
- **THEN** the check passes
- **AND** the image carries an SBOM attestation

#### Scenario: What a release publishes

- **WHEN** an operator opens the page of release 1.3.0
- **THEN** it names the image digest and the version tag
- **AND** it offers `compose.yaml`, the `Caddyfile`, `.env.example`, `backup.sh`, `restore.sh` and the release notes

### Requirement: Release pipeline integrity

The CI pipeline that builds and publishes the image and the npm packages SHALL follow these rules:
- the default workflow token is read-only, and each job declares only the permissions it needs;
- every CI action is pinned to a commit SHA;
- updates to action pins, dependencies and base images are proposed only after a 7-day minimum release age, and are never merged automatically; base-image updates are proposed every week;
- dependencies install from a frozen lockfile, and install scripts run only for an allowlist of packages;
- the job that builds and pushes the image runs only first-party steps;
- third-party scanners run in their own job, with read-only package access and no secrets.

CI SHALL check the workflow files for these rules and SHALL fail a change that breaks one of them.

Source: D38; design.md, Decisions this change rests on; design.md, Technical decisions: T13

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

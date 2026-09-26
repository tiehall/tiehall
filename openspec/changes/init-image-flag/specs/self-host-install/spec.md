# Spec Delta: self-host-install

## Purpose

Changes how `init` fills `TIEHALL_IMAGE` in the `.env` it prints: from `--image` when it is given, and from the image's own name and version tag otherwise, with a comment that says where the digest comes from. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: One `.env` holds the install settings

Every install setting SHALL live in one `.env` file next to `compose.yaml`: `TIEHALL_URL`, the install's public base URL; `TIEHALL_IMAGE`, the image the install runs, pinned by version, and by digest as well when the reference carries one, as the install command in the release notes does; the database owner and app passwords, or the two connection URLs of an external Postgres; `TIEHALL_SECRET_KEY`, which encrypts stored integration secrets; `TIEHALL_AUTH_SECRET`, which signs sessions and tokens; the reverse proxies whose forwarded headers are trusted; `TIEHALL_CLIENT_METADATA_FETCH`, as the requirement on metadata-document fetching defines; and the optional SMTP settings and `TIEHALL_SOURCE_URL`. Every secret setting SHALL also accept a `*_FILE` form that names a file holding the value. Settings that are connections rather than install settings SHALL live in the admin UI and the database, encrypted when they are secret, and SHALL need no change to `.env` and no restart: the GitHub App's credentials, the connected installations, the sign-in policy, the Jira connection, team mappings, registered APIs, and the personal-access-token and write-budget settings.

Source: D36; D42; design.md, Decisions this change rests on; design.md, How `init` fills `TIEHALL_IMAGE`

#### Scenario: A secret read from a file

- **WHEN** `.env` sets `TIEHALL_SECRET_KEY_FILE` to a file that holds the key, and does not set `TIEHALL_SECRET_KEY`
- **THEN** the install starts and encrypts stored integration secrets with the key from that file

#### Scenario: A connection needs no change to `.env`

- **WHEN** an admin connects the company's Jira site in the admin UI
- **THEN** the connection works without any change to `.env` and without a restart
- **AND** the Jira API token is stored encrypted in the database

#### Scenario: The image pinned as the release notes give it

- **WHEN** `.env` sets `TIEHALL_IMAGE` to the reference the release notes of 1.3.0 give, `ghcr.io/<owner>/tiehall:1.3.0@sha256:<digest>`, and Omar runs `docker compose up -d`
- **THEN** the install runs the image with that digest
- **AND** the admin page shows version 1.3.0

#### Scenario: A version tag without a digest

- **WHEN** `.env` sets `TIEHALL_IMAGE` to `ghcr.io/<owner>/tiehall:1.3.0`, with no digest, and Omar runs `docker compose pull && docker compose up -d`
- **THEN** the install runs the image the registry serves for release 1.3.0
- **AND** the admin page shows version 1.3.0

### Requirement: `init` prints a complete `.env`

The image SHALL have an `init` role that prints a complete `.env` with fresh random secrets for the URL it is given, for example `docker run --rm <image> init --url https://tiehall.example.com > .env`. Each run SHALL generate new secrets, and the printed file SHALL start an install without further edits. `init` SHALL accept an optional `--image <reference>`:
- when `--image` is given, `TIEHALL_IMAGE` in the printed file SHALL be that reference, verbatim. A value that is not an image reference, as container engines read one (an optional registry, a repository, an optional tag and an optional digest), SHALL be refused: `init` SHALL say in a clear message that the value is not an image reference, SHALL exit non-zero and SHALL print no `.env`;
- when `--image` is not given, `TIEHALL_IMAGE` SHALL be the image's own name and version tag, which the build bakes into the image: the repository the image is pushed to and the release it is, such as `ghcr.io/<owner>/tiehall:1.3.0`, or, for a build of `main` that is no release, the tag of its commit, `sha-<commit>`, as the build tags it. The printed file SHALL carry, at that line, a comment that says the digest comes from the release notes and how to pin it: by setting `TIEHALL_IMAGE` to the reference the release notes give, or by running `init` again with `--image`.

The install command in the release notes SHALL include `--image` with the release's reference pinned by version and digest. Each release SHALL also publish `.env.example`, which names every setting and shows the install command with `--image`.

Source: D42; design.md, Decisions this change rests on; design.md, How `init` fills `TIEHALL_IMAGE`

#### Scenario: Fresh secrets on each run

- **WHEN** Omar runs `init --url https://tiehall.example.com` twice
- **THEN** both outputs set `TIEHALL_URL` to `https://tiehall.example.com`
- **AND** no secret value in the first output appears in the second

#### Scenario: The printed file starts an install

- **WHEN** Omar writes the output of `init` to `.env` without editing it and runs `docker compose up -d`
- **THEN** the install starts and serves the setup screen

#### Scenario: The install command from the release notes

- **WHEN** Omar runs the install command from the release notes of 1.3.0, whose `--image` is `ghcr.io/<owner>/tiehall:1.3.0@sha256:<digest>`
- **THEN** the printed file sets `TIEHALL_IMAGE` to exactly that reference
- **AND** written to `.env` unedited, it starts an install on that image

#### Scenario: Fresh secrets with `--image`

- **WHEN** Omar runs `init --url https://tiehall.example.com --image ghcr.io/<owner>/tiehall:1.3.0@sha256:<digest>` twice
- **THEN** both outputs set `TIEHALL_IMAGE` to that reference
- **AND** no secret value in the first output appears in the second

#### Scenario: No `--image` on a release image

- **WHEN** Omar runs `init --url https://tiehall.example.com` on the image of release 1.3.0, without `--image`
- **THEN** the printed file sets `TIEHALL_IMAGE` to `ghcr.io/<owner>/tiehall:1.3.0`
- **AND** the comment at that line says the release notes name the digest, and how to pin it
- **AND** written to `.env` unedited, it starts an install on release 1.3.0

#### Scenario: No `--image` on a build of main

- **WHEN** Omar runs `init --url https://tiehall.example.com` on an image built from `main` that is no release, without `--image`
- **THEN** the printed file sets `TIEHALL_IMAGE` to the image's name and the tag of its commit, `ghcr.io/<owner>/tiehall:sha-<commit>`

#### Scenario: A value that is not an image reference

- **WHEN** Omar runs `init --url https://tiehall.example.com --image "ghcr.io/<owner>/Tiehall:1.3.0 latest"`
- **THEN** `init` exits non-zero
- **AND** prints no `.env`
- **AND** its message says that the value is not an image reference

#### Scenario: `.env.example` shows the command with `--image`

- **WHEN** an operator reads the `.env.example` of release 1.3.0
- **THEN** it names every setting
- **AND** its install command carries `--image`

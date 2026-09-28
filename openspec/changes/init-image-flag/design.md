# Design: `init --image`

## Context

`init` is the image's role that prints a complete `.env` with fresh secrets (the main change's design.md, Technical decisions: T1 and Self-hosting decisions: S2). Two rules of the self-host-install spec meet in it:

- `TIEHALL_IMAGE` in `.env` is pinned by version and digest, so an install runs exactly the image a release published, and `docker compose pull` cannot move it.
- `init --url <url>` alone prints a file that starts an install without further edits.

A running container cannot see the image it was started from: the container engine passes neither the image's name nor its tag nor its digest into the container, and a digest is computed from the image's manifest after the build, so it cannot be baked in either. `init` knows only what the build gave it. The two rules conflict, and the code built under the main change's task 5.2 already took an optional `--image` without the spec saying so. This change settles the rule and states what `init` writes without the option.

**Constraints.**
- The printed file must start an install unedited, with or without the option (D36, read as the main change's R1 reads it).
- Nothing in the install path calls home (the main change's S13): `init` connects to nothing, so it cannot look a digest up.
- The image name follows the repository: the build workflow names the image `ghcr.io/<owner>/tiehall`, with the owner of the repository in lowercase.

## Goals / Non-Goals

**Goals:**
- One install command in the release notes that pins the digest, with nothing for the operator to copy by hand.
- A useful `.env` from `init --url` alone: it names the version and says where the digest comes from.
- A clear refusal of a value that is not an image reference, before anything is printed.

**Non-Goals:**
- Looking a digest up from a registry, which would be a call out of the install path.
- Checking that a reference names an image that exists, or that its digest belongs to its tag: `docker compose pull` does that, with the engine's own message.
- Changing the upgrade path. `TIEHALL_IMAGE` in `.env` stays the one place where the running image is set, for upgrades and for going back (the main change's S12).

## Decisions

### Decisions this change rests on

- **D36. Install: Docker Compose, Tiehall plus Postgres, with one command.** The main change's design.md restates it in full. The part this change touches: settings live in one `.env`, which `init` writes before the one command `docker compose up -d`, and the printed file starts an install without further edits (the main change's R1). This change keeps that reading.
- **D42. `init` takes an optional `--image <reference>`.** A container cannot see the image it was started from, so `init` pins the digest only when given `--image`, which the install command on the release page includes. Without it, `init` writes the version tag it was built with and a comment that says where the digest comes from; the printed `.env` still starts an install unedited.
  - **Why.** The release notes are the one place that knows a release's digest, and their install command already names the image the operator runs `init` from, so passing the same reference again costs the operator nothing. Without the option, `init` still knows its own name and release, because the build bakes them in, and a version tag starts an install.
  - **Alternatives.** Making `--image` required, which breaks the rule that `init --url` alone prints a file that starts an install. Moving the pin into the release's `compose.yaml`, which changes the upgrade path: the operator sets `TIEHALL_IMAGE` in `.env` to upgrade and to go back (the main change's S12), and a pin in the Compose file would fight it. A placeholder the operator edits, which breaks the unedited-`.env` rule and invites typos in a digest.

### How `init` fills `TIEHALL_IMAGE`

- **With `--image`.** `init` checks that the value is an image reference and writes it into `TIEHALL_IMAGE` verbatim: no normalizing, no added tag or digest. An image reference is `[registry/]repository[:tag][@digest]`, as container engines read one: an optional registry, a host name with an optional port; a repository path of one or more components, each made of lowercase letters and digits joined by `.`, `_`, `__` or one or more `-`, with `/` between components, at most 255 characters without the registry, as Docker counts them (the first component is the registry when it has a `.` or a `:`, is `localhost` or has an uppercase letter, and a one-component name on Docker Hub, with no registry or with `docker.io` or `index.docker.io`, counts as `library/<name>`), so `ghcr.io/` may precede a path of 255 characters while a one-component name with no registry has at most 247; an optional tag of at most 128 letters, digits, `_`, `.` and `-`, starting with a letter, a digit or `_`; and an optional digest of an algorithm name, `:` and its hexadecimal value, such as `sha256:` followed by 64 hexadecimal digits. A value with anything else, such as an uppercase letter in the repository, a space, an empty tag or a digest of the wrong length, is refused: one plain line on standard error names `--image`, says the value is not an image reference and shows the shape; the exit code is 1, as for a URL the install would refuse; and nothing is printed on standard output. `--image` without a value, or with an empty one, is a usage error, exit code 2, as a missing `--url` is. A reference that carries no tag or no digest is a reference all the same and is written as given: what the install command in the release notes carries is a rule for releases, not a check in `init`.
- **Without `--image`.** `TIEHALL_IMAGE` is the image's own name and version tag: `<name>:<version>` for a release, such as `ghcr.io/<owner>/tiehall:1.3.0`, and `<name>:sha-<commit>` for a build that is no release, which is how the build workflow tags a build of `main`. The line carries a comment that says `init` named the release it ran from by version, that the release notes name that release's digest, and how to pin it: set `TIEHALL_IMAGE` to the reference the release notes give, or run `init` again with `--image`, as the install command in the release notes does. With `--image`, the comment says the image is as given to `init`. Both comments end with the upgrade step, as the comment does today.
- **What the build bakes in.** Three build arguments become environment variables of the image, which `init` reads; the `migrate` role records `TIEHALL_VERSION` with each migration as the schema floor, and the other roles only log the version and the commit when they start. The three: `TIEHALL_IMAGE_NAME`, the repository the image is pushed to, which the build workflow sets to `ghcr.io/<owner>/tiehall` from the repository owner in lowercase, and which is `tiehall` by default, for a local build; `TIEHALL_VERSION`, the release, which the release workflow sets from the version tag, and which is `0.0.0-dev` by default, marking a development build; and `TIEHALL_COMMIT_SHA`, the commit, which every build passes. The Dockerfile declares all three, and the build workflow passes the name and the commit already; the release workflow passes the version when the main change's task 29.1 builds it.
- **The install command.** The release notes show the install command with `--image` and the release's reference pinned by version and digest: `docker run --rm <reference> init --url https://tiehall.example.com --image <reference> > .env`, where `<reference>` is `ghcr.io/<owner>/tiehall:<version>@sha256:<digest>`. `.env.example` and the header of `compose.yaml` show the same shape with placeholders.
- **The `.env` rule.** `TIEHALL_IMAGE` is pinned by version always, and by digest as well when the reference carries one. The install command in the release notes carries both; `init` without `--image` writes the version; an operator who edits the value keeps at least the version tag, as the upgrade docs show.

### Where the specs leave room

- The wording of the refusal and of the two comments, as long as each says what the rules above name.
- Whether the comment of a development build names the release notes or says the build is no release.
- How `init` parses its options.

## Risks / Trade-offs

- [An operator runs `init` without `--image` and never pins the digest] → The printed file says where the digest comes from and how to pin it, and the release notes' command carries `--image`. `docker compose pull` on a version tag still gets the release, only without the digest check.
- [The reference check is stricter or looser than the engine's] → It follows the engine's published grammar. A reference that passes `init` but not the engine fails at `docker compose pull` with the engine's own message; a reference the engine accepts but `init` refuses is a bug, fixed by loosening the check.
- [A local build prints a tag that no local image carries] → A build that is no release prints `<name>:sha-<commit>`; a developer tags a local build that way, or passes `--image`. The boot test passes `--image`.

## Migration Plan

Nothing to migrate: `init` prints a file, and files printed before this change keep working. A `.env` written with `--image` before this change was already written verbatim; the refusal and the comment are the only new behavior.

## Open Questions

- Whether `init` should also refuse a reference that carries no version tag, so that `.env` always names a version. The narrowest reading, which the spec applies, is that any image reference is accepted verbatim.
- Whether the digest comment should differ for a development build, which no release notes describe.

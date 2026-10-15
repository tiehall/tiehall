# Design: Operating-system security updates in the image

## Context

[proposal.md](proposal.md) says why the image applies Debian's security updates when it is built. This document restates the decision the spec rests on, says how the image applies the updates and how CI checks it, and records what stays open. It cites nothing outside this repository.

**How the specs cite this document.** The `Source:` line in `specs/self-host-install/spec.md` cites the sections of this document that the rule comes from, as add-tiehall-oss-v1's design.md describes: decisions first, sections after, separated by semicolons. The sections are:
- **Decisions this change rests on** (`design.md, Decisions this change rests on`): D53, as a public rule, with the alternatives that lost, and a note of the decisions carried from add-tiehall-oss-v1.
- **Design rules: Operating-system security updates** (`design.md, Design rules: Operating-system security updates`): the rules the changed requirement states.
- **Rules carried from add-tiehall-oss-v1** (`design.md, Rules carried from add-tiehall-oss-v1`): the parts of the MODIFIED requirement that this change keeps unchanged, whose sources stay in that change's design.md.
- **Technical decisions T1–T2**: the step in the Dockerfile and the checks.

**Current state.** The Dockerfile has two stages on one base image, `node:24.21.0-trixie-slim`, pinned by digest (add-tiehall-oss-v1, Technical decisions: T1 and T13). The runtime stage first removes the package managers the base image ships (npm, npx, corepack and yarn), then copies the build output and switches to the unprivileged user 1000:1000. It runs no apt step, so its operating-system packages are exactly the base image's. The base image names three Debian suites, all signed with Debian's archive keyring, which it carries: the release (`trixie`), its stable updates (`trixie-updates`) and its security archive (`trixie-security`). On every push to `main` the Build workflow builds the image on a fresh runner, and a separate job scans it with a third-party scanner pinned by digest, which fails on any fixable HIGH or CRITICAL finding. Renovate proposes a new base-image digest weekly, after the 7-day release age, through a reviewed pull request labelled `node-base-image`. The image tests start each role on a read-only root filesystem as a non-root uid, and check that no package manager for Node is left.

**What went red.** After group 16 of add-tiehall-oss-v1 the scan found CVE-2026-75804 and CVE-2026-84782 in `libssl3t64` and `openssl-provider-legacy`: 3.5.7-1~deb13u2 is installed, and 3.5.7-1~deb13u3, which Debian's security archive publishes, fixes both. Docker has not yet published a Node image rebuilt on the fix. Under the rules of add-tiehall-oss-v1 no pull request could fix the image before a rebuilt base exists and is 7 days old.

**Constraints.**
- The base image stays pinned by digest and changes only through reviewed pull requests after 7 days (add-tiehall-oss-v1, Technical decisions: T13).
- The job that builds and pushes the image runs only first-party steps. The update is a step of the Dockerfile that `docker build` runs, not a new CI action.
- The roles keep running as a numeric non-root uid on a read-only root filesystem, and the image keeps no package manager for Node (self-host-install: Tiehall's containers are confined).
- The scan stays as it is: the same scanner, the same severities, and fixable findings only.

## Goals / Non-Goals

**Goals:**
- Each build of `main` and each release carries the Debian security updates published by the time it is built, so a fix that Debian has published does not wait for a rebuilt base image and its 7-day age.
- A rule in the spec and a check in CI, so the step cannot be dropped or moved without a failing check.
- No package index and no downloaded package left in the image.

**Non-Goals:**
- Changing the scan, its image or its threshold.
- Updating the build stage, whose operating system does not ship.
- Holding operating-system updates to a release age, or pinning their versions.
- Removing apt and dpkg from the image. They stay as the base image ships them, with no package index to install from, and a role cannot run them usefully as the non-root user on a read-only root filesystem.
- Changing how the base image is updated. Renovate's configuration is unchanged.
- Fixes outside Debian's archives, such as a fix in Node's own binary or in an npm package (Open Questions).

## Decisions

### Decisions this change rests on

- **D53. The image applies Debian's security updates when it is built.** The operating system's security patches are applied when the image is built, from Debian's signed security archive. The 7-day release-age rule keeps applying to npm packages and to the base image, which stays pinned by digest and is updated only through reviewed pull requests after 7 days. Decided by the maintainer on 2026-09-30, after the Build workflow went red on two OpenSSL vulnerabilities of the base image that Debian had fixed and Docker had not yet rebuilt.
  - **Why.** The release age guards against a release that nobody has had time to look at: a compromised or broken npm package, action or image. A Debian security update is published by Debian's security team, in an archive signed with keys the base image already carries, as a minimal fix for a published vulnerability; holding it for a week keeps a known vulnerability in every image built meanwhile. The base image keeps the release age, because a new digest changes Node itself and every package at once, which is what the review before merge is for.
  - **Alternatives that lost.**
    - *Waiting a week or more with a red Build.* Until Docker publishes a rebuilt Node image and it is 7 days old, every build of `main` is red and any release carries a known vulnerability; a red Build also hides the next finding.
    - *A temporary `.trivyignore` with an end date.* It turns the Build green without fixing anything: the image still ships the vulnerable library, every operator's own scan still reports it, and the exception has to be tracked and removed by hand.
    - *A spec exception for urgent base-image bumps.* It keeps the fix waiting for Docker's rebuild, which had not happened, and it opens the one path the release age exists to close: a base image a few days old, merged in a hurry.

Carried, restated in add-tiehall-oss-v1's design.md and not repeated here: D38 and T13 (Rules carried from add-tiehall-oss-v1).

### Design rules: Operating-system security updates

These are the rules the changed requirement states.

- **When.** Every build of the image applies the updates: each build of `main` and each release, which CI builds on a fresh runner without a build cache, so each fetches the updates published by then.
- **From where.** From the Debian archives the base image names, all signed with Debian's archive keyring, which the base image carries: its security archive, and with it the release's stable updates (Readings to confirm, R1). apt checks each archive's signature and refuses an archive that is unsigned or signed with another key, which fails the build.
- **What.** Upgrades of the packages the base image already has, and nothing else: no package is installed, recommended packages included, and none is removed. The step runs without asking anything and keeps the configuration files as the base image has them.
- **Where.** In the runtime stage, which becomes the image: before the package managers are removed and before the image switches to its non-root user. The build stage is not updated, because its operating system does not ship.
- **What the image keeps.** The step is one layer that removes the package lists and apt's caches before it ends, so the image holds no package index and no downloaded package, and the layer holds only the upgraded files. The image keeps a numeric non-root user, runs on a read-only root filesystem and holds no package manager for Node.
- **The release age.** The updates are not held to the 7-day release age. The release age keeps applying to npm packages, to CI actions and to the base image, which stays pinned by digest and changes only through a reviewed pull request after 7 days, proposed weekly, as before.
- **The check.** CI fails a change whose Dockerfile's runtime stage has no such step, runs it after the image switches to its non-root user or after the package managers are removed, runs it interactively or with recommended packages, lets it install or remove packages, or leaves the package lists in the image.
- **The scan.** Unchanged. Because a build carries every fix Debian has published by then, a fixable HIGH or CRITICAL finding in the operating system's packages now fails the Build only when the fix reached Debian's archives after the build.

### Rules carried from add-tiehall-oss-v1

The MODIFIED requirement keeps every rule, sentence and scenario it had. It adds one rule to its list, names the Dockerfile among what CI checks, and adds two scenarios. The unchanged parts rest on the sources their original `Source:` line cites, which stay restated in add-tiehall-oss-v1's design.md and are not repeated here: D38 under "Decisions this change rests on" and T13 under "Technical decisions".

### Technical decisions

#### T1. One step at the start of the runtime stage

- **Choice.** The first instruction of the runtime stage is one `RUN` that exports `DEBIAN_FRONTEND=noninteractive` and runs, joined with `&&` so that any failure fails the build: `apt-get update --error-on=any`, which fails when an archive cannot be fetched or its signature does not check out, where by default it only warns and exits 0, leaving the upgrade nothing to upgrade; `apt-get upgrade --yes --no-install-recommends`, with dpkg told to keep the configuration files as they are (`--force-confdef`, `--force-confold`); `apt-get clean`; and `rm -rf /var/lib/apt/lists/*`. It comes before the `RUN` that removes the package managers, and so before `USER`. `DEBIAN_FRONTEND` is exported in the step rather than set with `ENV`, so it is not left in the environment the roles run with.
- **Why.** `apt-get upgrade` never installs or removes a package, so the image's package set stays the base image's and only versions change. One step keeps the package lists out of every layer: lists removed in a later step would still sit in the earlier layer. The first position keeps the step independent of the build output, so a builder with a cache reuses it until the base image changes.
- **Alternatives.** `apt-get full-upgrade`, which may install or remove packages to satisfy a changed dependency, so the package set could drift from the base image's without review; a held-back upgrade shows up in the scan instead. A step limited to the security archive, with a sources file of its own: a security update can depend on a version that only the stable updates carry, and both are signed with the same keyring (R1). `apt` instead of `apt-get`: its interface is not stable for scripts. An upgrade stage whose root filesystem is copied into the image: it loses the base image's layers and makes every build ship a whole new root filesystem.

#### T2. The checks

- **Choice.** A module in `tools/repo-checks/src` reads the Dockerfile, joins continued lines, takes the last stage, which is the runtime stage, and reports a problem for each rule the step breaks: no `RUN` that updates the package lists and upgrades; an upgrade without `--yes` or `--no-install-recommends`, or without `DEBIAN_FRONTEND=noninteractive`; a step that can install or remove packages: an `apt-get upgrade` that names packages or allows new ones (`--with-new-pkgs`), any other `apt-get` command that installs, removes or upgrades packages, or `apt`, `aptitude` or `dpkg` run to do so; commands joined with anything but `&&`, or an `apt-get update` without `--error-on=any`; no removal of `/var/lib/apt/lists` or of apt's caches in the same `RUN`; the step after the `RUN` that removes the package managers, or after `USER`. Its test in `tools/repo-checks/test` runs it on fixture Dockerfiles, one per problem and one that passes, and on the repository's Dockerfile; `pnpm test` runs it in CI, as it runs the test that keeps framework telemetry off in the Dockerfile. An image test checks that the built image holds no file under `/var/lib/apt/lists` and no downloaded package under `/var/cache/apt`, and that dpkg reports no package left half-installed.
- **Why.** The repository check fails a pull request before any image is built, on a laptop without Docker too. The scan is the end-to-end check, but it fails only once Debian publishes a fix that the image lacks, which can be weeks after the step was dropped.
- **Alternatives.** An image test that no upgrade is pending: it needs the network and the archive's state at test time, so it would fail whenever Debian publishes an update after the build. A test of the version of one package, such as `libssl3t64`: it pins a moment and is wrong at the next update.

### Where the specs leave room

- The exact options of apt and dpkg, as long as the step runs without asking anything, installs no recommended package and leaves no package index.
- Whether the step also removes apt's and dpkg's logs.
- Where in the runtime stage the step sits, as long as it comes before the package managers are removed and before the switch to the non-root user.

## Risks / Trade-offs

- [Two builds of the same commit can carry different package versions] → The image is built once per release and named by digest (add-tiehall-oss-v1, Technical decisions: T13); the digest pins what was built, and the release's SBOM attestation lists the versions it holds. The image tests, the boot test and the scan run against that digest.
- [A broken Debian update reaches the image without the 7-day wait] → Debian's security updates are minimal fixes; the image tests and the boot test run on every build of `main`, and a release is cut from a build that passed them. An operator can go back to the previous release's image through `TIEHALL_IMAGE`.
- [A tampered mirror or a network attacker, since the base image fetches over HTTP] → apt checks the archive's signed release files and the hashes they list, with the keyring the base image carries; a package Debian did not sign fails the build.
- [A builder with a warm cache reuses the update step, so a local build can lack recent updates] → CI builds every image of `main` and every release on a fresh runner without a cache. A local build that needs the latest updates passes `--no-cache`.
- [The build now needs Debian's archives] → The build already fetches npm packages; an outage of Debian's archives fails the build, which is run again.
- [The image grows by the upgraded files] → Only upgraded packages land in the layer, and the package lists do not.

## Migration Plan

Nothing to migrate. The next build of `main` carries the updates, and operators get them with the next release. No setting, no data and no operator step changes. This change is archived after add-tiehall-oss-v1, because its MODIFIED requirement applies to the `self-host-install` spec that change creates.

## Open Questions

- **Fixable findings outside Debian's archives** (settled by `decisions-from-groups-15-28`'s D55 (86): a reviewed exception to the release age for exactly the advisory's fixed version, labelled and recorded in the changelog).
- **Releases between Debian fixes.** An install gets the updates only with a new release. Whether a Debian security fix alone triggers a patch release is a question for the release process that add-tiehall-oss-v1's group 29 builds.

## Readings to confirm with the founder

No decision settles the point below. The spec applies the reading, and it can change in review without changing the approach.

- **R1. "From Debian's signed security archive"** (D53). Reading: the step takes every upgrade apt offers from the Debian archives the base image names: the security archive, and the release's stable updates with it, all signed with the same Debian keyring. A security update can depend on a version that only the stable updates carry, and a step limited to the security archive would then hold that security update back; the stable updates are Debian's own reviewed fixes to its stable release. `decisions-from-groups-15-28`'s D55 (85) words the spec as this reading. Specs: self-host-install.

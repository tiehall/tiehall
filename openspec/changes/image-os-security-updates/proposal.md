# Proposal: Operating-system security updates in the image

## Why

The Build workflow went red after group 16 of add-tiehall-oss-v1. Its image scan found two fixable OpenSSL vulnerabilities, CVE-2026-75804 and CVE-2026-84782, in `libssl3t64` and `openssl-provider-legacy`. Neither comes from Tiehall's code or its npm dependencies: both come from the Debian base of the Node image that the Dockerfile pins by digest, `node:24.21.0-trixie-slim`, which carries 3.5.7-1~deb13u2, while Debian's security archive already publishes the fix, 3.5.7-1~deb13u3. Docker has not yet published a Node image rebuilt on it, and the pipeline rules accept a new base-image digest only once it is 7 days old, through a reviewed pull request. Under those rules no change could fix the image before a rebuilt base exists and has aged a week, and every build of `main` stays red meanwhile.

D53, which the maintainer decided on 2026-09-30, settles it: the image applies Debian's security updates when it is built. [design.md](design.md#decisions-this-change-rests-on) restates it with the alternatives that lost.

## What Changes

- The runtime stage of the Dockerfile applies the available operating-system updates from Debian's signed archives when the image is built: non-interactively, without recommended packages, installing and removing no package, in one step that also removes the package lists and apt's caches, so the image holds no package index. The step runs before the package managers are removed and before the image switches to its non-root user. The image keeps its rules: a numeric non-root user, a read-only root filesystem and no package manager for Node.
- The self-host-install requirement "Release pipeline integrity" gains the rule that the operating system's security patches are applied when the image is built, from Debian's signed security archive. The 7-day release age keeps applying to npm packages, to CI actions and to the base image, which stays pinned by digest and changes only through reviewed pull requests after 7 days.
- A repository check fails a Dockerfile whose runtime stage lacks that step, places it after the switch to the non-root user or after the package managers are removed, lets it install or remove packages, or leaves the package lists in the image; CI runs it with the other repository tests. An image test checks that the built image holds no package list and no downloaded package.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `self-host-install`: the requirement "Release pipeline integrity" adds the rule on the operating system's security patches and says that CI checks the Dockerfile for it; it keeps every rule and scenario it had and gains two scenarios.

## Impact

- **Code:** the runtime stage of the `Dockerfile`; a new check of the Dockerfile in `tools/repo-checks`, with its fixtures; the image tests in `tools/image-tests`.
- **The image:** each build carries the Debian updates published by the time it is built. The digest still pins what a build produced, and the SBOM that a release attests lists the upgraded packages.
- **Pipeline:** the build workflow, its scan and Renovate's configuration are unchanged. The base image stays pinned by digest, and Renovate still proposes a new version of it, with its tag and digest, weekly, after 7 days (and, since 2026-10-17, no new digest for the same tag, which carries no release time: add-tiehall-oss-v1, task 2.5), through a reviewed pull request.
- **Operators:** nothing changes in `.env`, in the Compose file or in the upgrade path; a new release carries the updates.
- **Ordering:** this change is archived after add-tiehall-oss-v1, whose `self-host-install` spec it modifies.

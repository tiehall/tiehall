# Proposal: An exception to the release age for an update a maintainer calls for

## Why

The release age lets in no dependency version younger than 7 days (self-host-install: "Release pipeline integrity"). `decisions-from-groups-15-28`'s D55 (86) made one reviewed exception to it: the version an advisory names as fixed, for a fixable HIGH or CRITICAL finding of the image scan. On 2026-10-16 the maintainer answered that Better Auth 1.7.10, the sign-in library's release of 2026-10-15, which takes Cursor's first registration itself, is taken now through that reviewed exception, once a supply-chain review of it comes out clean. The review came out clean the same day, but 1.7.10 fixes no advisory, so the exception as D55 (86) words it, and the check that task 1.58 of that change built, refuse its record. Later that day the maintainer answered the open question this raised with its option A: the exception also takes an update that a maintainer's recorded answer calls for. [design.md](design.md#decisions-this-change-rests-on) restates that answer as a public rule, with the alternatives that lost.

## What Changes

- A reviewed pull request may take, before it is 7 days old, exactly the version of an npm package that a maintainer's recorded answer calls for, besides the version an advisory names as fixed. Its record, the exception's changelog entry, names that answer, by the day it was given and where it is recorded, and the supply-chain review of the version, by its day and where it is recorded, with what the review compared, the version's provenance, its install scripts and its dependencies, in place of an advisory.
- Everything else stays as for an advisory's exception: never proposed or merged automatically, the `release-age-exception` label, an exclusion of that one version only, removed once it is 7 days old, and a line in the notes of each release that carries it, which now names the answer and the review.
- `pnpm check:workflows` accepts such a record, and still fails a record that names neither an advisory nor an answer, an answer without its review, a review without one of its parts, a record without the label and one whose day has passed. `CONTRIBUTING.md` says how.
- `decisions-from-groups-15-28`'s open question on 1.7.10 is settled here, with the review it records, and that change's task 1.58 gets a note.
- The first exceptions it takes are Better Auth 1.7.10, its `@better-auth/*` packages at 1.7.10 and `better-call` 1.4.2, on the review of 2026-10-16.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `self-host-install`: "Release pipeline integrity" adds the exception for an update a maintainer's recorded answer calls for and says that the release notes list each exception; it keeps every rule and scenario it had, changes the body of one scenario with its rule, and gains three scenarios.

## Impact

- **Code:** the release-age check, its label step's message and the release notes in `tools/repo-checks`; the description of `tools/repo-checks/release-age-exceptions.json`; `CONTRIBUTING.md`; comments of the API-compatibility workflow.
- **Dependencies:** none in the tasks that build the rule; Better Auth 1.7.10 is taken by a task of its own, with its records.
- **Operators:** nothing changes in an install; a release's notes list each exception it carries, as before, with what it rests on.
- **Order:** archived after `add-tiehall-oss-v1`, `image-os-security-updates` and `decisions-from-groups-15-28`, whose text of "Release pipeline integrity" it starts from.
- **Approval:** the maintainer approved this change in the answer of 2026-10-16 that it states.

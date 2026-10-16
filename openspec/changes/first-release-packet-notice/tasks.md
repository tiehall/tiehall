# Tasks

One group, before the first release (GP-20). Tests come first.

## 1. The first release without the 14-day wait

- [x] 1.1 Tests first: `tools/repo-checks/test/api-changelog.test.ts` records the first release with a breaking packet change announced one day before it, and still refuses a later release, with an earlier release recorded, while the notice is younger than 14 days; `tools/repo-checks/test/release-notes.test.ts` finds the first release's candidate, before and after its record, and the first release itself carry a breaking packet change announced the same day. Verified by the two new tests failing on the old code (2 failed, 34 passed) and passing after 1.2.
- [x] 1.2 Apply the hold only when the changelog records an earlier release, in `tools/repo-checks/src/api-changelog.ts` and `tools/repo-checks/src/release-sources.ts`; verified by `api-changelog.test.ts`, `release-notes.test.ts` and `packet-compat.test.ts` passing (50 tests).
- [x] 1.3 Record release 1.0.0 with `pnpm changelog:release 1.0.0`; verified by its output, "Recorded release 1.0.0 in openapi/changelog.json: 11 entries and 25 changes".
- [x] 1.4 Record the decisions in `CONTRIBUTING.md`, the main change's design.md D38 (1) and GP-4 and GP-20 of `docs/maintainers/going-public.md`, with `going-public.test.ts` changed first; verified by the repo checks and `openspec validate --all --strict` passing.

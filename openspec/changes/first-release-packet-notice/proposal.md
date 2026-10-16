# Proposal: the first release carries breaking packet changes without the 14-day wait

## Why

The maintainer decided on 2026-10-17 to publish Tiehall's first release, version 1.0.0, at once. `pnpm changelog:release 1.0.0` refused it: a breaking packet change announced on 2026-10-12 may only be released from 2026-10-26, because the handoff-packet capability holds every release, a release candidate included, until 14 days after a breaking packet change's notice. Before the first release, that wait protects no one: no install runs a released Tiehall, the packet schema is not published, and no reader depends on the packet's old shape. The maintainer chose to keep the wait for every later release and to drop it for the first, as [design.md](design.md#decisions) restates, over waiting until 2026-10-26.

The same day the maintainer answered two questions of the first release: its version is 1.0.0, and the film's end card keeps "Coming soon".

## What Changes

- The 14-day hold on a breaking packet change applies once Tiehall has a release: every later release and release candidate keeps it. The first release and its candidates may carry a breaking packet change announced any day before them.
- `pnpm changelog:release` and the release workflow's check of the release notes apply the hold only when the changelog records an earlier release.
- `openapi/changelog.json` records release 1.0.0.
- The contributors' guide says so; design.md D38 (1) and GP-4 and GP-20 of the checklist record that the first release is 1.0.0 and that the film's end card stays as it is.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `handoff-packet`: the requirement "Breaking packet changes before publication".

## Impact

- **Code:** `tools/repo-checks/src/api-changelog.ts` and `tools/repo-checks/src/release-sources.ts`, with their tests.
- **Data:** `openapi/changelog.json`.
- **Docs:** `CONTRIBUTING.md`, `docs/maintainers/going-public.md`, and the main change's `design.md`.
- **Ordering:** archived after `add-tiehall-oss-v1` and `decisions-from-groups-15-28`, whose `handoff-packet` spec it modifies.

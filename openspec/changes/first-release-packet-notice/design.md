# Design: the first release carries breaking packet changes without the 14-day wait

## Context

The handoff-packet capability's requirement "Breaking packet changes before publication" holds every release until 14 days after a breaking packet change is announced in the changelog, so that readers of the packet have time to adapt. `pnpm changelog:release` checks it when it records a release, and the release workflow when it writes a release's notes, on the day it runs. On 2026-10-17 the maintainer decided to publish the first release; the hold refused it until 2026-10-26, because of a breaking packet change announced on 2026-10-12.

## Decisions

(1) **The first release carries breaking packet changes without the wait** (the maintainer's answer of 2026-10-17). The hold applies once the changelog records a release: every later release and release candidate keeps it. The first release, and its candidates, may carry a breaking packet change announced any day before them, because no install runs a released Tiehall, the packet schema is not published and no reader depends on the old shape. The alternative, waiting until 2026-10-26, kept the rule as it was and was declined for the first release alone.
- `pnpm changelog:release` records the first release with no hold when `openapi/changelog.json` records no release yet.
- The release workflow's check holds a candidate whose final version is not recorded yet only when the changelog records a release, and a recorded release only when the changelog records an earlier one, by version order. A release candidate gets no record of its own, so a candidate never counts as an earlier release.

(2) **The first release is version 1.0.0** (the maintainer's answer of 2026-10-17), tagged `v1.0.0` after a release candidate, as GP-20 of `docs/maintainers/going-public.md` says.

(3) **The film's end card keeps "Coming soon" at the first release** (the maintainer's answer of 2026-10-17). D38 (1) had the end card changed when the first release ships, with a new encode, a new README attachment and the YouTube film; none of them changes now.

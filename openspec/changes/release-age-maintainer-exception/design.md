# Design: An exception to the release age for an update a maintainer calls for

## Context

[proposal.md](proposal.md) says why the release age needs a second kind of reviewed exception. This document restates the maintainer's answer the delta rests on as a public rule, with its reason and the alternatives that lost, says how the record, the check and the release notes carry it, and records the review of the first update it takes. It cites nothing outside this repository.

**How the specs cite this document.** The `Source:` line of `specs/self-host-install/spec.md` keeps the decisions its requirement cited before this change, D38, D53 and D55 (85) and (86), and names the sections of this document: `design.md, Decisions this change rests on`, where the maintainer's answer is, and `design.md, Rules carried from earlier changes`, which says where the unchanged parts of the requirement keep their sources.

**Current state.** pnpm resolves only versions published at least 7 days ago (`minimumReleaseAge` in `pnpm-workspace.yaml`), the age Renovate waits for. `decisions-from-groups-15-28`'s D55 (86), built by its task 1.58, makes one reviewed exception: `minimumReleaseAgeExclude` names `<package>@<version>`, and `tools/repo-checks/release-age-exceptions.json` records it with the package, the version, the advisory that names the version as fixed, the label `release-age-exception` and the day the version turns 7 days old (`agedOn`). `pnpm check:workflows` fails an exclusion that names more than one exact version or that the list does not record, a record without its advisory, its label or its day, a record whose day has passed, and a record of an exclusion the workspace does not make; the API-compatibility workflow's label step fails a pull request that adds an exclusion without the label; and the release notes list each exception a release carries with its advisory (that change's T16). The list holds no exception.

**The update that raised it.** Better Auth, the sign-in library, published 1.7.10 on 2026-10-15; it takes Cursor's first registration itself, which Tiehall's own rule on app's schemes takes already (`decisions-from-groups-15-28`, D55 (15)). The maintainer answered on 2026-10-16 that 1.7.10 is taken now through the reviewed exception to the release age, once a supply-chain review of it comes out clean, and not by turning the rule off, while Tiehall's rule and its stand-ins stay. The review, done on 2026-10-16 and first recorded in `decisions-from-groups-15-28`'s design.md that day (commit 9101ae97), came out clean:
- **The update.** It moves the library and its ten `@better-auth/*` packages from 1.7.5 to 1.7.10 and `better-call` from 1.4.0 to 1.4.2, takes for the library the `@better-auth/utils` 0.5.0 that the lockfile already holds, and brings no other package.
- **What was compared.** A diff of every published file, old against new, finds no install script, no new dependency, no `eval`, `new Function` or `child_process`, no network call that 1.7.5 does not make, and no minified or obfuscated code.
- **Provenance.** Each tarball's SHA-512 is the registry's, and `npm audit signatures` verifies their signatures and their provenance, which names the `release.yml` workflow of the library's own GitHub repository, and of `better-call`'s and `utils`' own for those two.
- **Advisories.** No advisory names 1.7.8, 1.7.9 or 1.7.10 as fixed, so the exception as D55 (86) words it refuses their records. 1.7.7, past the release age since 2026-10-07, fixes three advisories of the library's repository that affect 1.7.5, GHSA-965c-763c-88jm (critical, Magic Link), GHSA-r4xp-prcw-77qf (high, OAuth Proxy) and GHSA-44jh-23m7-hpcf (low, rate limits kept in the database), none of which reaches Tiehall, which builds neither plugin and keeps its rate limits in its own storage, and none of which the GitHub Advisory Database holds yet, so the image scan does not report them.
- **Tiehall's tests.** With 1.7.10 in a scratch copy, beside the release-age check, which refuses the exclusions, only the route inventory test fails, on the library's new `POST /oauth2/client/rotate-keys`, which the update classifies as blocked, as the other client routes are; a test that read the exclusions as workspace folders reads only the packages list since `decisions-from-groups-15-28`'s task 1.58 fixed it.
- **The day.** 1.7.10 turns 7 days old on 2026-10-22.

**Constraints.**
- The rule stays a reviewed exception for one exact version at a time, labelled, recorded, dated and removed after 7 days; nothing turns the release age off.
- pnpm's release age covers npm packages only. CI actions and the base image keep their 7 days through Renovate, and a fix to Node's binary moves the base image by digest through a reviewed pull request, as task 1.58 of `decisions-from-groups-15-28` records.
- The check reads only the repository, and calls no service.

## Goals / Non-Goals

**Goals:**
- An update the maintainer calls for comes in before its 7 days through the same reviewed, recorded and dated path as a security fix, with its answer and its review on record.
- The check, the label step, the release notes and `CONTRIBUTING.md` state the same rule.

**Non-Goals:**
- Exceptions for CI actions or the base image.
- Judging what a review says beyond that it names each of its parts: the review is the reviewers' work, and the pull request's review holds it to account.
- Saying who may give such an answer: the maintainers, as for the approval of any OpenSpec change.
- Taking Better Auth 1.7.10 in the tasks that build the rule: a task of its own takes it, with its records.

## Decisions

### Decisions this change rests on

- **The maintainer's answer of 2026-10-16: a reviewed exception for an update a maintainer's recorded answer calls for.** Given by the maintainer on 2026-10-16 to `decisions-from-groups-15-28`'s open question "Taking the sign-in library's 1.7.10 before its 7 days", with its option A, which approves this change. As public rules:
  - Besides the version an advisory names as fixed (D55 (86)), a reviewed pull request may take before it is 7 days old exactly the version of an npm package that a maintainer's recorded answer calls for, once a supply-chain review of that version comes out clean. An answer that calls for an update that moves several packages calls for each version the update moves, and each is excluded and recorded on its own.
  - Its record, the exception's changelog entry, names that answer, by the day it was given and where it is recorded, and the supply-chain review of the version, by its day and where it is recorded, and says what the review compared, the version's provenance, its install scripts and its dependencies, in place of an advisory. A record rests on an advisory or on an answer, never on both.
  - Everything else is as for an advisory's exception: never proposed or merged automatically, the `release-age-exception` label, an exclusion from the release age of that one version only, removed once the version is 7 days old, and a line in the notes of each release that carries it, which names the answer and the review.
  - CI fails an exclusion whose record names neither an advisory nor an answer, an answer without its review, a review that leaves out one of its parts, a record without the label, and a record whose day has passed.
  - **Why.** The maintainer answered that Better Auth 1.7.10 is taken now, through the reviewed exception and not by turning the rule off. The release age guards against a version nobody has had time to look at; a supply-chain review, recorded where the maintainers and reviewers can read it, is that look, taken on purpose. The label, the record, the end day and the release notes keep the exception as visible and as short-lived as an advisory's. The review's parts are the ones the review of 1.7.10 covered.
  - **Alternatives that lost.** *Taking 1.7.10 as any update on 2026-10-22, when the release age lets it in, after the same review (option B):* six days later, which the maintainer's answer declined. *Taking 1.7.7 now, past its 7 days, after a review of its own, and 1.7.10 on 2026-10-22 (option C):* 1.7.7 carries three fixes, none of which Tiehall needs (Context), and not Cursor's registration. *An advisory field that holds the answer's text:* the check could not tell a security fix from an answered update, and the release notes would call the answer an advisory. *Excluding the package by name or by a range, or turning the release age off for the update:* every later version would come in without review. *An exception that the label alone vouches for:* nothing would say why the version came early or what was checked.

Carried, restated where they are and not repeated here: in the main change's design.md, D38 (Decisions this change rests on there) and T13; in `image-os-security-updates`' design.md, D53; in `decisions-from-groups-15-28`'s design.md, D55 (85) and (86), and T16.

### Rules carried from earlier changes

The MODIFIED requirement, self-host-install "Release pipeline integrity", starts from `decisions-from-groups-15-28`'s text and keeps every sentence and scenario it had. It adds the rule on an update a maintainer's recorded answer calls for, names the answer and the review among what CI checks of an exclusion's changelog entry, says that CI fails an exclusion whose version is past its 7 days and that the release notes list each exception, and adds three scenarios; the kept scenario "An exclusion without the label" changes its body with its rule. Its unchanged parts rest on the sources its earlier `Source:` line cites, D38, D53 and D55 (85) and (86), restated in the main change's design.md, in `image-os-security-updates`' and in `decisions-from-groups-15-28`'s.

### Text corrections to earlier changes

Applied by this change's task 1.4; each is a text edit, with no effect on any spec beyond this change's delta.

- **`decisions-from-groups-15-28`'s design.md.**
  - D55 (15)'s Code: "and Tiehall's rule and its stand-ins stay (Open Questions)." becomes "and Tiehall's rule and its stand-ins stay (`release-age-maintainer-exception`)."
  - D55 (86): after its Alternatives add "  - **Widened.** As the maintainer answered on 2026-10-16, `release-age-maintainer-exception` widens this exception to the version of an npm package that a maintainer's recorded answer calls for, recorded with that answer and a supply-chain review of the version in place of an advisory."
  - T16's Choice: "records each exception: the package, the exact version, the advisory and the day the version turns 7 days old" becomes "records each exception: the package, the exact version, the advisory or, for an update a maintainer's recorded answer calls for, that answer and the supply-chain review (`release-age-maintainer-exception`), and the day the version turns 7 days old".
  - The Open Question "Taking the sign-in library's 1.7.10 before its 7 days" keeps its bold lead, and its citations, text and options become "(D55 (15), (86); T16; settled by the maintainer's answer of 2026-10-16, option A, which `release-age-maintainer-exception` states: a reviewed exception to the release age for the version of an npm package that a maintainer's recorded answer calls for, recorded with that answer and the supply-chain review of the version, with the label, the end day and the listing in the release notes of an advisory's exception; that change's design.md records the review of 1.7.10 and the options that lost)."
- **`decisions-from-groups-15-28`'s tasks.md.** Task 1.58, keeping its checkbox, gains the note: "Note, on 2026-10-16: the maintainer's answer to the open question "Taking the sign-in library's 1.7.10 before its 7 days" widened the exception, and `release-age-maintainer-exception` builds it in the same files: a record may name, in place of an advisory, a maintainer's answer and the supply-chain review of the version, and the release notes name them."

### Technical decisions

#### T1. The record of an answered update

- **Choice.** `tools/repo-checks/release-age-exceptions.json` keeps one record per exclusion. A record that rests on an answer holds, in place of `advisory`, an `answer` with its `day` and `recordedIn`, and a `review` with its `day`, `recordedIn`, `compared`, `provenance`, `scripts` and `dependencies`, each a text that is not empty; its `package`, `version`, `label` and `agedOn` are as an advisory's record has them. `releaseAgeViolations()` in `tools/repo-checks/src/release-age.ts` fails a record with neither an advisory nor an answer, one with both, an answer without a real day or without where it is recorded, an answer without its review, and a review without a real day or without one of its texts; every other rule stays as task 1.58 of `decisions-from-groups-15-28` built it. The label step's message, in `check-release-age-label.ts`, names both kinds of exception.
- **Why.** Named fields let the check see that each part is there, and let the release notes name each without reading a text apart. `recordedIn` is a text, not a path the check opens, because a change's files move when it is archived, while the record lasts at most 7 days.
- **Alternatives.** *One text for the answer and the review:* the check could not tell a missing part. *Checking that `recordedIn` names a file of the repository:* a change archived within the 7 days would fail the check, though its record holds.

#### T2. The release notes

- **Choice.** `releaseAgeSection()` in `tools/repo-checks/src/release-notes.ts` lists an answered update as the package and its version, the day of the maintainer's answer that calls for it and where it is recorded, the day of its supply-chain review and where it is recorded, and the day it turns 7 days old; its opening sentence names both kinds of exception.
- **Why.** An operator reading the notes sees why each version came early and where to read about it.

### Where the specs leave room

- The words of a record's texts and of the release notes' lines, as long as each names its answer, its review and its day.
- Where an answer and a review are recorded, such as an OpenSpec change's design.md, a task's note or a commit, as long as the record says where.

## Risks / Trade-offs

- [An answer lets a version in early for a reason other than a vulnerability] → It still needs a clean supply-chain review, recorded; a reviewed pull request with the label; and an exclusion of that one version, which ends once it is 7 days old. The release notes name it.
- [The check cannot judge a review] → It checks that the review names each of its parts; the pull request's reviewers check what it says, as they review any update.
- [Answers become a routine way past the 7 days] → Each answer is recorded where everyone can read it, and every release's notes list the exceptions it carries.

## Migration Plan

Nothing to migrate: the list holds no exception, and an advisory's record keeps its shape. This change is archived after `add-tiehall-oss-v1`, `image-os-security-updates` and `decisions-from-groups-15-28`, whose text of "Release pipeline integrity" it starts from.

## Open Questions

None.

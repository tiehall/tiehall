# Proposal: GitHub layer hardening

## Why

The builders of the GitHub layer of `add-tiehall-oss-v1` and `github-app-reachability` left seventeen notes for the maintainer where the specs are inexact, silent or contradicted by the code, and built five hardening rules the specs do not state yet. D50, the maintainer's decision of 2026-09-29, settles the notes by their recommended defaults and puts every spec change into this one change, approved before those parts are built. [design.md](design.md#decisions-this-change-rests-on) restates D50's twenty-two items, each with its reason and the alternatives that lost, and ends with a numbered list to approve.

## What Changes

- **Credentials** (D50 (1), (2)): Tiehall calls GitHub only with its App's own credentials (the App's JWT, installation tokens, and the client secret only for a sign-in's code), none for the manifest's code, and a sign-in's own token only to read who signed in. An uploaded App key is checked with `GET /app`, with no installation.
- **A GitHub or Jira failure** (D50 (3)): a new error-model row, 502 `integration-unavailable`, for the invite form and review page, the key check, the setup screen's code exchange and later the Jira check.
- **Retention and sessions** (D50 (4) to (6)): deliveries are deleted 7 days after processing (30 days unprocessed); a refused sign-in's record lasts as long as its event, which the admin view names; a web session lasts 7 days from its creation or daily extension, 30 at most.
- **Browsers** (D50 (7)): a refusal on the web UI's page routes and the sign-in callbacks is an HTML page for a browser, and problem JSON for everyone else.
- **Setup** (D50 (8), (9), (17), (18), (21), (22)): the setup screen's own sign-in callback; the company's name is bounded and fixed after setup; the App's name defaults to the company's and is bounded; the manifest's state expires after an hour and is used once; a replaced App is named.
- **Integration events** (D50 (10)): they act for a person only while that person is a member.
- **Invites** (D50 (11), (12)): the refusals as built, one pending invite per account, and a form that resolves the account before a review page that names it.
- **Bounds, limits and reads** (D50 (13), (14), (19), (20)): the bounds of a webhook secret, a private key and a review page's file; 25 MiB for a GitHub delivery; the sign-in callback's rate limit; the admin pages' internal reads.
- **Redelivery** (D50 (15)): its limits, and a given-up delivery shows a banner, emails the admins and falls back to polling unless an admin chose webhook mode.
- **Texts** (D50 (16)): earlier changes' texts are corrected to match the code.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

Twenty-two requirements, each named in its delta under `specs/`: `sign-in` (four), `agent-access` (two), `activity-log` (one), `tracker-mirrors` (five), `self-host-install` (four), `teams-and-roles` (four) and `public-api` (two).

## Impact

- **Code:** items 1, 8, 9, 13, 14 and 18 to 22, the kept rules of 11 and the parameters of 15 only catch the specs up; their tasks name or write tests. Items 2 to 7, 10, 12 and 17, one rule of 11 and the fallback of 15 change built code, tests first, with one migration; 16 edits the texts of earlier changes.
- **Public contracts:** no `/api/v1` operation changes. Web UI routes can answer 502, and answer a browser's refusal with a page.
- **Order:** archived after `add-tiehall-oss-v1`, `spec-catch-up`, `github-app-reachability` and `request-body-limit`, whose texts of the same requirements this change starts from.
- **Approval:** D50 has the maintainer approve this change before its spec-changing tasks are built.

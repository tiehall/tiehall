# Proposal: Decisions from groups 15 to 28

## Why

The builders, verifiers and fixers of `add-tiehall-oss-v1`'s groups 15 to 28 left eighty-six notes for the maintainer where the specs are inexact, silent or contradicted by the code. D55, the maintainer's decision of 2026-10-03, settles them as D50 settled the GitHub layer's: hardening inside the specs is built directly, and every point that changes a spec rule goes into this one change, written now and approved, with the maintainer's other pending steps, before any of it is built. [design.md](design.md#decisions-this-change-rests-on) restates D55's items, each with its reason and the alternatives that lost, and ends with a numbered list to approve.

## What Changes

- **Errors** (D55 (1) to (7)): a quality of 0 does not ask for HTML; a cap of 64 MiB on bodies read at once, with a new 503 `busy`; a webhook removed on GitHub moves GitHub to polling; GitHub failing a sign-in's look-up is 502.
- **Agent access** (D55 (10) to (25)): the authorization server's rate limits, scopes, default resource and client metadata bounds; the CLI's one grant; a PAT's label, no PAT while switched off, and reminder timing.
- **MCP and the CLI** (D55 (26) to (37)): `/mcp` checks `Origin`; `list_inbox` lists unfinished requests; stable tools fail CI on any removal; terminal controls are stripped; a withdrawal answers 200.
- **Request URLs** (D55 (38) to (42)): a token that negotiates HTML gets markdown; capped intake notes and a paged `directory`; required fields hold on reassignment and revisions.
- **The requester loop** (D55 (43) to (52)): a user's own events are not their updates; new readers start where the web inbox is; camelCase wait entries, with a pre-release case for the `api-breaking` label; a digest that catches up; internal raw event reads; an upgrade line.
- **Operations** (D55 (53) to (57)): Compose limits; an older image leaves unknown tables alone; GitHub Actions' OIDC host is listed.
- **Contract changes** (D55 (58) to (73)): the CI caller's order of checks and a binding without its ref; the Action fails open; hand-attached diffs need no PR; identical reruns add nothing; keys match as written and only the target side's links close.
- **Mirrors** (D55 (74) to (79)): a duplicate is not "Done"; a newer job supersedes a dead letter; a deleted issue is marked gone; a polled close acts for `closed_by`.
- **Safety, docs and the image** (D55 (80) to (86)): API names are the provider team's text; every confirmation gets a receipt; team membership changes are security events; the packet schema names `http` and `https`; the security policy; a release-age exception.
- **Texts** (D55 (3), (4), (8) to (11)): earlier designs and tasks match the code.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

Seventy-eight requirements, each named in its delta under `specs/`: `public-api` (seven), `agent-access` (thirteen), `agent-surfaces` (eleven), `requester-loop` (nine), `requests` (four), `contract-changes` (twelve), `tracker-mirrors` (six), `self-host-install` (five), `agent-safety` (four), `handoff-packet` (one), `activity-log` (three), `sign-in` (one) and `teams-and-roles` (two).

## Impact

- **Code:** about half the items only catch the specs up, and their tasks name or write tests; the rest change built code, tests first, with a few migrations; six items only edit texts.
- **Public contracts:** the error model gains `busy`; `list_inbox`, `directory`, `proposals.propose`, the wait entries, `requests.get` and the packet schema change, and `events.read` and `events.acknowledge` leave `/api/v1`, each through its capability's path.
- **Order:** archived after `add-tiehall-oss-v1`, `spec-catch-up`, `request-body-limit`, `github-app-reachability`, `github-layer-hardening` and `image-os-security-updates`, whose texts this change starts from.
- **Approval:** D55 has the maintainer approve this change before any of it is built.

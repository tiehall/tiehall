# Proposal: Tiehall open-source v1

## Why

Teams that use coding agents still pass work between teams by hand. Context gets lost, questions stall the work, and breaking API changes reach consuming teams late (D9). Tiehall gives each team an address for requests, a typed packet agents can read, a loop back to the requester's own agent, and contract-change requests (D14, D15).

D33 makes v1 an open-source product that each company installs and runs itself, instead of a multi-tenant service run by us: an install keeps each company's requests next to its own GitHub and Jira, under its own operators, and needs nothing from us. [design.md](design.md#decisions-this-change-rests-on) restates every decision this change relies on.

## What Changes

- One company per install: Docker Compose with Tiehall and Postgres, one `.env`, automatic migrations and a first-run setup screen (D35, D36).
- GitHub-only sign-in through a GitHub App each install creates with GitHub's manifest flow; the same App links PRs, closes on merge and mirrors into GitHub Issues. No passwords (D37).
- Teams with admin and member roles; team-addressed requests. A person confirms commitments in the web UI; a due date or a scope change after a claim needs one on each side (D23, D30).
- The handoff packet `tiehall.packet/v1`, labeled beta, under Apache-2.0 (D24).
- MCP, the `tiehall` CLI, a Claude Code plugin, and request URLs such as `/FE-142` on the install's host (D8).
- The requester loop: pull, a long-poll wait, Claude Code hooks, and email when SMTP is set.
- Contract-change requests from breaking OpenAPI changes found in the provider's CI (D14, D15).
- GitHub Issues and Jira Cloud mirrors, Jira through a bot's API token; webhooks or polling (D17).
- Fencing and loop limits for agents; a plain append-only activity log.
- A public REST API with OpenAPI and stability levels.
- AGPL-3.0 server, Apache-2.0 client pieces (D34). No telemetry.
- Not in v1, later additions: SSO, the client allowlist, the anchored tamper-evident audit log, several orgs per install. Passkeys may come later as an option (D35).

## Capabilities

### New Capabilities

- `self-host-install`: Compose, `.env`, setup screen, App manifest flow, operator commands, backups, upgrades.
- `teams-and-roles`: the install's org, admin and member roles, invites, removals, teams and keys.
- `sign-in`: GitHub sign-in, who may sign in, and access that follows GitHub organization membership.
- `agent-access`: OAuth for MCP clients and the CLI, personal access tokens, bot users, CI authentication.
- `requests`: lifecycle, keys, threads, provenance, proposals, receipts, undo, PR links, events.
- `handoff-packet`: the packet schema, revisions, untrusted fields, the beta label, publication.
- `agent-surfaces`: MCP tools, CLI commands, the plugin and skill, URLs, intake pages.
- `requester-loop`: pull readers, the web inbox, the long-poll wait, hooks, optional email.
- `contract-changes`: API registration, reports, the consumer map, routing, digests, closing.
- `tracker-mirrors`: the GitHub App, GitHub and Jira intake, both mirrors.
- `agent-safety`: fencing, server-only notices, the outbound fetcher, limits, the confirmation step.
- `activity-log`: domain and security events for admins, append-only storage, export.
- `public-api`: REST, OpenAPI, errors, stability levels, deprecation, client packages.

### Modified Capabilities

None.

## Impact

- **Code:** the existing monorepo; the foundation already built carries over.
- **External systems:** GitHub (a per-install App, the Action), Jira Cloud, MCP clients, optional SMTP. Nothing run by us.
- **Public contracts:** `/api/v1`, the MCP tools, the CLI, the packet schema, the Compose file and `.env` keys, the Action's inputs.
- **Earlier plan:** the hosted-service change `add-tiehall-beta` is set aside and kept out of the public repository (D33, D38).

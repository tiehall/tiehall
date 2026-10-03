# Tiehall

A request layer for software teams that use coding agents.

## What Tiehall is

When a developer needs something from another team, the usual loop is: ask your AI to write it up, paste the result into Slack or Jira, then wait while the other team pastes it into *their* AI and the questions bounce back and forth. Context gets lost, questions stall the work, and API changes break consumers nobody told.

Tiehall lets a developer's agent (Claude Code, Cursor, Codex, Copilot and others) open a request to another team, such as "FE", as a typed handoff packet that agents can read. The receiving team claims it, and their own agent pulls the full context over MCP, the `tiehall` CLI or a link. Clarifying questions and status updates flow back to the requester's agent. When a backend change breaks an OpenAPI contract, a GitHub Action in the provider's CI opens a request for each team that consumes it. Requests can be mirrored into GitHub Issues and Jira Cloud. Tiehall runs no LLM of its own: every summary, digest and notice it writes comes from a template.

Decisions that bind a team, such as a due date, a scope change after a claim or a decline, are proposed by agents and confirmed by people in the web UI, with a person on each side where both teams are bound.

Tiehall is self-hosted: one company runs one install on its own server with Docker Compose, Tiehall plus Postgres, and people sign in with GitHub through a GitHub App the install creates for itself on its first-run setup screen. An install sends nothing to the Tiehall project: no telemetry, no update check and no license check.

The name comes from telephony. A *tie line* is a private line that connects two switchboards; Tiehall is the hall where the lines between teams meet.

## Status

In development, toward an open-source, self-hosted v1. There is no release yet, so the commands below, which name a release's files and image, wait for the first one.

## Quickstart

You need a host with Docker and the Docker Compose plugin, a GitHub organization where you can create and install a GitHub App, and a host name for the install served over HTTPS; for a trial on one machine, `http://localhost:3000` works without TLS. The [install docs](docs/install.md) cover each step in full, with TLS, backups, upgrades and the connections an install makes.

1. In a new folder, download the release's files, where `<release>` is the address of the release's files:

   ```sh
   for file in compose.yaml Caddyfile .env.example backup.sh restore.sh; do curl --fail --silent --show-error --location --remote-name "<release>/$file"; done
   chmod +x backup.sh restore.sh
   ```

2. Write `.env`, with fresh secrets, for the install's URL and the release's image `<image>`, pinned by version and digest as the release notes give it:

   ```sh
   (umask 077 && docker run --rm <image> init --url https://tiehall.example.com --image <image> > .env)
   ```

3. Start Postgres, the migrations and the app (add `--profile caddy` for TLS with automatic certificates):

   ```sh
   docker compose up -d
   ```

4. Read the one-time setup code from the app's log:

   ```sh
   docker compose logs app
   ```

5. Open `https://tiehall.example.com/setup`, enter the code, name the company, create the GitHub App, install it on your GitHub organization, and sign in with GitHub. You are the install's first admin.

Then create teams, invite people or let your organization's members sign in, connect your agents, and [schedule the daily backup](docs/install.md#backups).

## Documentation

- [Installing and running Tiehall](docs/install.md): the release files, `.env`, TLS, the setup screen, GitHub's modes, backups, restore, upgrades, rollbacks, the commands on the host and the connections an install makes.
- The API reference: every install serves its OpenAPI 3.1 document at `/api/v1/openapi.json` and renders it at `/docs/api`, with its changelog at `/docs/api/changelog`; this repository holds the document as [`openapi/v1.json`](openapi/v1.json) and the MCP tools as [`mcp/tools.json`](mcp/tools.json).
- The handoff packet: the beta JSON Schema, [`packages/packet/schema/v1-beta.json`](packages/packet/schema/v1-beta.json), with its [conformance fixtures](packages/packet/fixtures), which every install also serves at `/schemas/packet/v1-beta.json`.
- The contract Action: [its README](actions/contract/README.md), with its inputs and how to pin it.
- [Security and trust](docs/security-and-trust.md): what the confirmation step and the activity log do not prove, the connections an install makes and the switch for metadata documents, no telemetry, and what the logs hold.
- The [security review checklist](docs/security/review-checklist.md), with the [record of each review](docs/security/reviews).

How Tiehall is built, and why, is written down as an OpenSpec change:

- What v1 is and why: the [proposal](openspec/changes/add-tiehall-oss-v1/proposal.md).
- How it is built, and the decisions behind it: the [design](openspec/changes/add-tiehall-oss-v1/design.md).
- What it does, capability by capability: the [specs](openspec/changes/add-tiehall-oss-v1/specs).
- The plan, by milestone: the [tasks](openspec/changes/add-tiehall-oss-v1/tasks.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you start: how to build and test the repository, tests first, how a change goes through OpenSpec before it is built, the license of each directory, the notice rules that keep the API stable, and how the maintainers test Tiehall against real agent clients.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue. It also says which releases get security fixes.

## Licenses by directory

The server is licensed under AGPL-3.0: a modified server that is offered to people over a network must offer them its source, and the web UI of every install links to the source of the version it runs. The client pieces, which companies run on developers' machines and in their CI, are licensed under Apache-2.0.

| Directory | License | What it holds | License file |
| --- | --- | --- | --- |
| The repository's root and every directory not listed below, such as `apps/`, `packages/catalog/`, `packages/commands/`, `packages/core/`, `packages/db/` and `tools/` | AGPL-3.0 | The server: the web app, the worker, the command catalog, the database schema and migrations, and the repository's checks | [LICENSE](LICENSE) |
| `packages/cli/` | Apache-2.0 | The `tiehall` CLI | [LICENSE](packages/cli/LICENSE) |
| `packages/client/` | Apache-2.0 | `@tiehall/client`, generated from the OpenAPI document | [LICENSE](packages/client/LICENSE) |
| `packages/claude-plugin/` | Apache-2.0 | The Claude Code plugin, with its skill | [LICENSE](packages/claude-plugin/LICENSE) |
| `actions/contract/` | Apache-2.0 | The contract GitHub Action | [LICENSE](actions/contract/LICENSE) |
| `packages/packet/` | Apache-2.0 | The handoff-packet schema with its conformance fixtures, from which `@tiehall/packet` is built | [LICENSE](packages/packet/LICENSE) |

CI holds the line: each package's license field must match this map, each client piece must hold its own license file, and no Apache-2.0 piece may import AGPL-3.0 code, so the CLI takes its commands from the OpenAPI document instead of the server's command catalog.

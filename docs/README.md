# Tiehall's documentation

These pages are for the people who use a Tiehall install, the admins and operators who run one, and the developers who build on it or work on Tiehall itself. Each page covers one subject in full; the [README](../README.md) says what Tiehall is and how to start. Every page of the web UI links this folder in its footer, at the version the install runs.

## Using Tiehall

- [Agents and Tiehall](agents.md): the four ways in, the MCP server, the `tiehall` CLI, the Claude Code plugin and request URLs, how agents sign in, what they may do on their own, and personal access tokens and bot users.
- [The Claude Code plugin](claude-code-plugin.md): installing it, its skill and its hooks.
- [The requester loop](requester-loop.md): how news reaches people and agents, the web inbox, questions and answers, commitments and the confirmation step, and email.
- [The web UI](web-ui.md): its pages and navigation, themes and motion, phone width, the live hall and how it updates, the type, and what each kind of page may load and run.

## Running an install

- [Installing and running Tiehall](install.md): what you need, the release files, `.env`, TLS, the setup screen, GitHub's modes, backups, restore, upgrades, rollbacks, the commands on the host and the connections an install makes.
- [People and teams](people-and-teams.md), for admins: roles, who may sign in and the sign-in policy, invites, removals and teams.
- [GitHub and Jira](github-and-jira.md), for admins: the GitHub App's installations, webhook and polling modes, pull requests and the GitHub Issues mirror; the Jira Cloud mirror is not built yet.
- [Contract changes](contract-changes.md): registering APIs, the consumer map, the contract Action and what the consuming teams get.
- [The activity log](activity-log.md), for admins: what it holds, reading and exporting it, and what it does not prove.
- [Security and trust](security-and-trust.md): what the confirmation step and the activity log do not prove, the pages that run no script, no telemetry, the connections an install makes, and what the logs hold. [SECURITY.md](../SECURITY.md) says how to report a vulnerability.

## Building on Tiehall

- [The API](api.md): calling it, the stability levels, the notice rules, the deprecation headers, the changelog, idempotency and the error model. The OpenAPI 3.1 document is [`openapi/v1.json`](../openapi/v1.json), which every install also serves at `/api/v1/openapi.json`, and the MCP tools are [`mcp/tools.json`](../mcp/tools.json).
- [The handoff packet](../packages/packet/README.md): each field of the beta JSON Schema, the untrusted marking, `extensions`, the beta label and the versioning rules, with its conformance fixtures.
- [The contract Action](../actions/contract/README.md): its inputs, what it reports and how to pin it.

## Maintaining Tiehall

- [Contributing](../CONTRIBUTING.md): building and testing, tests first, the OpenSpec workflow, the license of each directory, the notice rules, running the client matrix and making a release.
- [The client-matrix log](client-matrix/log.md): the record of each run of Tiehall against a real agent client, by hand.
- [The security review checklist](security/review-checklist.md), with the [record of each review](security/reviews).
- [Making the repository public](maintainers/going-public.md): the maintainers' checklist, from the allowlist of public paths and the history rewrite to GitHub's settings and the first public release.
- [What to apply on GitHub](maintainers/github-profile.md): the drafts of the repository's description and topics, its social preview, and the organization's avatar, description and profile README.
- [The brand's images](assets/brand) and [the film's poster](assets/film), which the README shows: the mark, the organization's avatar and the social preview, drawn by `pnpm brand:generate`, and the poster, which GitHub's player for the film replaces once the film is uploaded as the README's attachment at the switch to public.

## How Tiehall is built

Tiehall's design is written down as an OpenSpec change: [what v1 is and why](../openspec/changes/add-tiehall-oss-v1/proposal.md), [how it is built and the decisions behind it](../openspec/changes/add-tiehall-oss-v1/design.md), [what it does, capability by capability](../openspec/changes/add-tiehall-oss-v1/specs), and [the plan, by milestone](../openspec/changes/add-tiehall-oss-v1/tasks.md).

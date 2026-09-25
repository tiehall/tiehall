# Tiehall

A request layer for software teams that use coding agents.

When a developer needs something from another team, the usual loop is: ask your AI to write it up, paste the result into Slack or Jira, then wait while the other team pastes it into *their* AI and the questions bounce back and forth. Context gets lost, questions stall the work, and API changes break consumers nobody told.

Tiehall lets a developer's agent (Claude Code, Cursor, Codex, Copilot and others) open a request to another team, such as "FE", as a typed handoff packet that agents can read. The receiving team claims it, and their own agent pulls the full context over MCP, the `tiehall` CLI or a link. Clarifying questions and status updates flow back to the requester's agent. When a backend change breaks an OpenAPI contract, a GitHub Action opens a request for each team that consumes it. Requests can be mirrored into GitHub Issues and Jira Cloud. Tiehall runs no LLM of its own.

The name comes from telephony. A *tie line* is a private line that connects two switchboards; Tiehall is the hall where the lines between teams meet.

## Status

In development, toward an open-source, self-hosted v1: one company per install, run with Docker Compose (Tiehall plus Postgres), with GitHub sign-in set up from a first-run setup screen. There is no release yet.

- What v1 is and why: [proposal](openspec/changes/add-tiehall-oss-v1/proposal.md)
- How it is built, and the decisions behind it: [design](openspec/changes/add-tiehall-oss-v1/design.md)
- What it does, capability by capability: [specs](openspec/changes/add-tiehall-oss-v1/specs/)
- The plan: [tasks](openspec/changes/add-tiehall-oss-v1/tasks.md)

## License

The server is licensed under AGPL-3.0. The client pieces (the CLI, `@tiehall/client`, the Claude Code plugin, the contract GitHub Action and the handoff-packet schema) are licensed under Apache-2.0. License files arrive with the first release.

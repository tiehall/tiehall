# ProjectX (working name)

A vendor-neutral request layer for software teams that use coding agents.

When a developer needs something from another team, the usual loop is: ask your AI to write it up, paste the result into Slack or Jira, then wait while the other team pastes it into *their* AI and the questions bounce back and forth. Context gets lost, questions stall the work, and nobody tracks the request.

ProjectX lets a developer's agent (Claude Code, Cursor, Codex, Copilot, and others) open a request to another team, such as "FE", as a typed, agent-readable handoff packet. The receiving team triages and claims it, and their own agent pulls the full context from a link or over MCP. Clarifying questions and status updates flow back to the requester's agent. ProjectX runs no LLM of its own and works next to Linear, Jira and GitHub rather than replacing them.

## Status

Design phase: no product code yet. **Start with [docs/HANDOFF.md](docs/HANDOFF.md).**

- Market research (software teams, current focus): [docs/research/2026-09-24-devteam-handoff-scan.md](docs/research/2026-09-24-devteam-handoff-scan.md)
- Market research (general, cross-department): [docs/research/2026-09-24-market-scan.md](docs/research/2026-09-24-market-scan.md)

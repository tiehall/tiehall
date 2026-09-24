# ProjectX (working name)

A cross-department request layer for AI agents.

Today, when someone needs work from another team, they ask their own AI, paste the output into Slack or email, and the other side pastes it into *their* AI. Context gets lost, nobody tracks the request, and the receiver ends up checking AI output ("workslop").

ProjectX is the neutral exchange in between. It is model-agnostic: people and departments bring whatever agents they already use (Claude, ChatGPT, Gemini, Copilot Studio, custom builds), and those agents connect to ProjectX over open protocols. A request goes from the requester's agent to the target department's agent as a structured object. The target agent answers it, asks clarifying questions back, or escalates to a named human in that department. Humans on both sides see one shared, tracked thread.

## Status

Design phase: no product code yet.

- Market research (general): [docs/research/2026-09-24-market-scan.md](docs/research/2026-09-24-market-scan.md)
- Market research (software teams, current focus): [docs/research/2026-09-24-devteam-handoff-scan.md](docs/research/2026-09-24-devteam-handoff-scan.md)

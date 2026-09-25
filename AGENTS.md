# Agent instructions

**Start with [README.md](README.md), then the current OpenSpec change, [`openspec/changes/add-tiehall-oss-v1`](openspec/changes/add-tiehall-oss-v1/):** its `proposal.md` (why and what), `design.md` (the decisions the specs rest on, and how Tiehall is built), `specs/` (one behavior contract per capability) and `tasks.md` (the implementation plan, by milestone).

On the maintainer's machine there may also be a git-ignored `private/` folder with planning history. It is optional and never needed to build Tiehall; nothing in the repository may link to it.

## Working rules

- **Build from the approved plan.** Work through `openspec/changes/add-tiehall-oss-v1/tasks.md` in order, test first (TDD), and check off a task only when its stated verification passes. Anything the specs do not cover, or any change a maintainer asks for, becomes a separate OpenSpec change that the maintainer approves before it is built. Ask one question at a time.
- **Languages.** Maintainer conversations may be in Turkish; reply in the language you are addressed in. Everything in the repository (code, docs, commit messages) is in English.
- **Stack.** TypeScript full stack: Node, React/Next.js, Postgres, shipped as one Docker image and run with Docker Compose. Tiehall is model-agnostic and never runs or calls an LLM of its own.
- **Licenses.** The server is AGPL-3.0. The client pieces (the CLI, `@tiehall/client`, the Claude Code plugin, the contract Action and the packet schema) are Apache-2.0. Apache-2.0 code never imports AGPL-3.0 code.
- **Specs** live in OpenSpec, in English. Changes in progress are in `openspec/changes/`, and archived specs in `openspec/specs/`. `openspec/config.yaml` holds the writing rules. Every requirement carries a `Source:` line that points to a section of its change's `design.md`. Run `openspec validate --strict` before committing a spec change.
- **Safety on the machine you run on.** Change only files inside the repository and your own scratch space. Never modify installed applications or system configuration (for example Docker Desktop or its CLI plugins). If Docker's credential helper hangs, point `DOCKER_CONFIG` at a fresh, empty directory; never create symlinks into an application bundle.

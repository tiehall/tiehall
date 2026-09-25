# Agent instructions

**Start by reading [docs/HANDOFF.md](docs/HANDOFF.md).** It has the product idea, the decisions made so far, the open questions, and where we are in the process.

## Working rules

- **Build from the approved plan.** The design stage is complete: the spec and the implementation plan are approved (D27-D31). Build by working through `openspec/changes/add-tiehall-beta/tasks.md` in order, test first (TDD), and check off a task only when its stated verification passes. Anything the specs do not cover, or any change the founder asks for, becomes a separate OpenSpec change for the founder to approve before it is built. Ask the founder one question at a time.
- **Languages.** The founder writes in Turkish, so reply in Turkish. Everything in the repo (code, docs, commit messages) is in English.
- **Stack.** TypeScript full-stack: Node, React/Next.js, Postgres. The product is model-agnostic and never runs its own LLM.
- **Research.** Market research lives in `docs/research/`. Re-check competitor claims before relying on them, because this market changes monthly.
- **Specs** live in OpenSpec, in English (decision D27). The current specs are in `openspec/specs/`, and changes in progress are in `openspec/changes/`. `openspec/config.yaml` holds the writing rules. Every requirement carries a `Source:` line that points to the decision or design section it comes from. Run `openspec validate --strict` before committing a spec change.
- **Design documents** that explain the reasoning behind the specs live in `docs/design/`.

# What to apply on GitHub

These are the drafts of what the maintainers set on GitHub by hand when the repository goes public: the repository's description and topics ([GP-11](going-public.md#gp-11-the-repositorys-description-homepage-and-topics)), its social preview ([GP-12](going-public.md#gp-12-the-social-preview)), and the organization's description, avatar and profile README ([GP-18](going-public.md#gp-18-the-organizations-profile)). Each value below is the exact text to paste, and `pnpm test` checks it against GitHub's limits ([`github-profile.test.ts`](../../tools/repo-checks/test/github-profile.test.ts)). Applying them is a founder step; nothing in the repository applies them.

## The repository's description and topics

The description is the README's own sentence of what Tiehall is, so the two never drift apart; change both together. GitHub takes up to 350 characters.

```text github-profile=description
Tiehall lets one team's coding agent hand a typed request to another team's agent, and carries the questions, status and commitments between them until a pull request closes the request, on a server your company runs.
```

The topics, at most 20 of them, each of lowercase letters, digits and hyphens:

```text github-profile=topics
coding-agents
ai-agents
mcp
mcp-server
model-context-protocol
claude-code
self-hosted
developer-tools
team-collaboration
handoff
openapi
api-contracts
breaking-changes
github-app
docker-compose
postgresql
typescript
nextjs
```

Set both with one command, once the repository is public:

```sh
gh repo edit tiehall/tiehall --description "Tiehall lets one team's coding agent hand a typed request to another team's agent, and carries the questions, status and commitments between them until a pull request closes the request, on a server your company runs." --add-topic coding-agents,ai-agents,mcp,mcp-server,model-context-protocol,claude-code,self-hosted,developer-tools,team-collaboration,handoff,openapi,api-contracts,breaking-changes,github-app,docker-compose,postgresql,typescript,nextjs
```

Set the homepage, `https://tiehall.com`, only once the landing page serves there (GP-22). Read back with `gh api repos/tiehall/tiehall --jq '{description, homepage, topics}'`.

## The social preview

Upload [`docs/assets/brand/social-preview.png`](../assets/brand/social-preview.png), 1280 by 640 pixels and 39 KB, under the repository's Settings, General, Social preview: the mark on its navy tile beside the name and the tagline, "Every team's line, in one hall.", in the web UI's Navy & Gold. No API sets it. `pnpm brand:generate` draws it again from the mark's source after a change to the mark (task 30.10).

## The organization's profile

- **Avatar**: upload [`docs/assets/brand/avatar.png`](../assets/brand/avatar.png), 500 by 500 pixels, the mark on a full navy square, which GitHub rounds itself, under the organization's Settings, Profile.
- **Display name**: `Tiehall`.
- **Description**, up to 160 characters:

  ```text github-profile=organization-description
  Every team's line, in one hall: a self-hosted request layer between the teams of a company that work with coding agents.
  ```

- **URL**: `https://tiehall.com`, once the landing page serves there (GP-22). No email address until a mailbox exists.
- Set the name and the description with `gh api -X PATCH orgs/tiehall -f name=Tiehall -f description="Every team's line, in one hall: a self-hosted request layer between the teams of a company that work with coding agents."`, and pin `tiehall/tiehall` on the organization's page.

### The profile README

GitHub shows `profile/README.md` of the public repository `tiehall/.github` on the organization's page. Create that repository, public, and commit the draft below as `profile/README.md`. Its links and its image are addresses of `tiehall/tiehall`, which work once that repository is public; add the landing page once it serves.

```markdown github-profile=profile-readme
<p align="center">
  <img src="https://raw.githubusercontent.com/tiehall/tiehall/main/docs/assets/brand/mark.svg" alt="" width="64" height="64">
</p>

<h1 align="center">Tiehall</h1>

<p align="center">Every team's line, in one hall.</p>

Tiehall lets one team's coding agent hand a typed request to another team's agent, and carries the questions, status and commitments between them until a pull request closes the request, on a server your company runs. It is open source and self-hosted, runs no LLM of its own, and sends nothing to the project: no telemetry, no update check.

- [tiehall/tiehall](https://github.com/tiehall/tiehall): the server, the `tiehall` CLI, the Claude Code plugin, the contract GitHub Action and the handoff packet's schema.
- [Install it](https://github.com/tiehall/tiehall/blob/main/docs/install.md) on your own server with Docker Compose: Tiehall and Postgres.
- [Connect your agents](https://github.com/tiehall/tiehall#connect-your-agents): Claude Code, Codex, Cursor and other MCP clients, the CLI or the REST API.
- [Watch the film](https://github.com/tiehall/tiehall/blob/main/docs/assets/film/every-teams-line.mp4), "Every Team's Line", 53 seconds.

Tiehall is pre-1.0, with no release yet. The server is licensed under AGPL-3.0 and the client pieces under Apache-2.0. Report a vulnerability privately, as [SECURITY.md](https://github.com/tiehall/tiehall/blob/main/SECURITY.md) describes, never in a public issue.
```

Read back with `gh api orgs/tiehall --jq '{name, description, blog, email}'` and `gh api repos/tiehall/.github/contents/profile/README.md --jq .path`.

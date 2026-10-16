# Security policy

A Tiehall install runs inside a company's network with its data: its requests and their threads, who may sign in and act, and the credentials of its GitHub App and its Jira connection. This page says how to report a vulnerability in Tiehall, and which releases get its fix.

## Reporting a vulnerability

Report a vulnerability privately, through GitHub's private vulnerability reporting: on the repository's Security tab, choose "Report a vulnerability", or open [the reporting form](https://github.com/tiehall/tiehall/security/advisories/new) directly. The report becomes a draft security advisory that only you and the maintainers can read. Do not report a vulnerability in a public issue, a pull request, a discussion or anywhere else in public.

Say in the report:

- what is affected: the server, which is the image, the release's files (`compose.yaml`, the `Caddyfile`, `backup.sh` and `restore.sh`), or a client piece: the `tiehall` CLI, `@tiehall/client`, the Claude Code plugin with its skill, the contract Action or the packet schema;
- the version: the admin page of an install shows the version it runs;
- how to reproduce it, and what someone who uses it gains;
- what it needs: a signed-in member or admin, an agent's token, a CI run, a GitHub or Jira account, access to the host, or nothing at all.

Leave out real data: no company's requests, no tokens and no secrets of an install that someone uses. Test only on an install you run yourself.

## What happens after a report

The maintainers answer in the advisory, work out the impact with you, and fix the problem privately, with a failing test first, as every change to Tiehall starts. The advisory is published with the release that carries the fix, and credits you unless you ask not to be named. The maintainers' own reviews follow the [security review checklist](docs/security/review-checklist.md), and each of their findings is fixed the same way.

## Which releases get fixes

Tiehall has no release yet. Until its first release, fixes go to the `main` branch.

- A security fix comes in a new patch release of the latest release. Earlier releases are not patched: an install gets the fix by upgrading to the latest release, as the [upgrade docs](docs/install.md#upgrade) describe. Releases use semantic versions, and releases can be skipped, because the migrations run in order; the release notes name any release that must not be skipped.
- The image applies the security updates of its Debian base each time it is built, so each new release also carries the operating system's fixes published by then.
- The `tiehall` CLI gets a fix in a new version on npm. The Claude Code plugin with its skill gets one in a new version from this repository. The contract Action gets one in a new release, which a workflow takes by moving its commit SHA pin to that release; Renovate and Dependabot can propose the move. `@tiehall/client` and `@tiehall/packet`, once they are published, get a fix in a new version on npm.
- A fix that cannot wait may have to break a public API operation, an MCP tool or the packet before the usual notice has run. Its pull request carries the `api-breaking` label and adds a changelog entry, so the release notes and every install's `/docs/api/changelog` list the break.

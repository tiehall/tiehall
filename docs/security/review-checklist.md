# Security review checklist

The maintainers review Tiehall against this checklist before a release, and whenever a change touches one of the areas it lists. Each item names the requirements it checks, what a reviewer reads and tries, and the tests that hold each property, or a gap mark where no test holds it yet. A review is recorded in [`reviews/`](reviews/), one file per review named by its date, with a result for every item: `Pass`, a finding (`F` and a number), or `Gap`. Each finding names the task that fixes it, with a failing test first. What a review finds that needs a new or changed spec rule is not a finding: the record lists it as a decision for the maintainers, who open an OpenSpec change for it or decline it.

`pnpm test` checks the checklist and the latest record (`tools/repo-checks/test/security-review.test.ts`): every item has a result in the latest record; every requirement an item names is a requirement of the specs; every test an item names is a test file that holds that test's title; and every finding names a task of the plan.

## Items

### SR-1 The setup code and the setup gate

- Requirement: self-host-install: The setup code guards the setup screen
- Requirement: self-host-install: Setup names the company and makes the first admin
- Check: the code the app prints at each start while setup is incomplete carries at least 128 bits of randomness, only its hash is stored, and each start replaces it; a wrong code, or an earlier start's, gets 403 and opens no session.
- Check: the setup session's cookie is HttpOnly and host-only (`__Host-` over HTTPS), its token is stored as a hash, and completing setup ends every setup session; every step and every post needs the session, and every post needs an Origin of `TIEHALL_URL`.
- Check: before setup completes, only `/setup`, `/healthz` and, once the App's credentials are stored, `/webhooks/github` are served; every operation answers 503 `setup-required` whatever route or surface reaches it.
- Test: `packages/commands/test/setup-code.test.ts`: "prints a setup code with at least 128 bits of randomness to the log"
- Test: `packages/commands/test/setup-code.test.ts`: "stores only a hash of the code, so the database holds no code in clear"
- Test: `packages/commands/test/setup-code.test.ts`: "refuses the code of the previous start with 403, and the new code opens a session"
- Test: `packages/commands/test/setup-gate.test.ts`: "serves /webhooks/github, and still nothing else but /setup and /healthz"

### SR-2 The manifest state

- Requirement: self-host-install: The GitHub App is created with GitHub's manifest flow
- Check: the state the App step sends to GitHub is bound to the browser's setup session, lives 60 minutes and stores one App at most; a return without it, with another session's or a changed one, an expired one or a used one is refused before GitHub is asked to convert anything, and nothing is stored.
- Check: a code not in GitHub's form is refused before GitHub is asked; the App's credentials are stored encrypted in the transaction that records the state as used.
- Test: `packages/commands/test/setup-github-app.test.ts`: "refuses a state bound to another browser's setup session, one that was changed, and a return to a browser with no session"
- Test: `packages/commands/test/setup-github-app.test.ts`: "refuses a state issued more than 60 minutes ago as foreign, before asking GitHub, and stores nothing"
- Test: `packages/commands/test/setup-github-app.test.ts`: "refuses a second return with a state that stored an App already, before asking GitHub, and keeps the App"

### SR-3 The route guard of the sign-in service

- Requirement: agent-safety: The confirmation step runs only in the web UI
- Requirement: sign-in: GitHub is the only way to sign in
- Check: every route of every instance the sign-in service builds is classified as blocked, harmless or gated, with the library and its plugins pinned exactly; a route nobody classified fails CI; the routes that would hand out a web session's token, change who may do what or store a user on a device code before approval are not served.
- Test: `packages/commands/test/sign-in-routes.test.ts`: "finds every route of every instance the service builds classified"
- Test: `packages/commands/test/sign-in-routes.test.ts`: "fails on a route that nobody classified, such as one a plugin adds"
- Test: `packages/commands/test/sign-in-routes.test.ts`: "runs on the sign-in library and its plugins pinned exactly, as installed and as the lockfile resolves them"

### SR-4 The confirmation step

- Requirement: agent-safety: The confirmation step runs only in the web UI
- Requirement: agent-safety: Actions that need the confirmation step
- Requirement: agent-safety: One confirmation approves one action
- Requirement: agent-safety: The confirm URL never reaches the model
- Check: a review page's nonce is bound to the member, the web session and the digest of one action with its exact input, expires after 5 minutes, approves one action once, and is kept only as a hash; the review page's GET changes nothing and cannot be framed.
- Check: every action the spec lists runs only with its confirmation (`pnpm check:confirmations`), and no output an agent reads carries a confirm URL.
- Check: what the step does not prove: an agent that drives the person's own signed-in browser can confirm in it.
- Test: `packages/commands/test/confirmation-nonce.test.ts`: "is refused with 403 from another session of the same user, or from another user"
- Test: `packages/commands/test/confirmation-nonce.test.ts`: "is refused with 403 for the same action with different input"
- Test: `packages/commands/test/confirmation-nonce.test.ts`: "is refused with 403 once it has been used, and the second call changes nothing"
- Test: `packages/commands/test/confirm-url-scan.test.ts`: "finds a confirm URL in every kind of output agents read"
- Test: `tools/image-tests/test/image.test.ts`: "serves the review pages of the confirmation step, which send a browser without a session to sign in first and cannot be framed"
- Gap: the security docs that say what the confirmation step does not prove, with the browser-profile advice, are task 28.5.

### SR-5 The device flow

- Requirement: agent-access: The CLI signs in through a restricted device flow
- Requirement: agent-access: The device approval page cannot be prefilled
- Check: only the CLI's client id gets a device code, which expires after 10 minutes and binds to no user before approval; the token's only audience is the MCP resource; the library's own device token, verification and approval routes are not served.
- Check: the approval page ignores a code its URL carries, shows the request's address and time, and approves only with the confirmation step.
- Test: `packages/commands/test/device-flow.test.ts`: "gets unauthorized_client for a client registered through DCR, and no device code is issued"
- Test: `packages/commands/test/device-flow.test.ts`: "gets an access token whose only audience is the MCP resource"
- Test: `packages/commands/test/device-approval.test.ts`: "leaves the code field empty when its link carries a code, and does not use that code"
- Test: `packages/commands/test/device-approval.test.ts`: "without a valid confirmation gets 403, and the CLI gets no token"

### SR-6 CI OIDC

- Requirement: agent-access: CI authenticates with GitHub Actions OIDC bound to registered repositories
- Check: a CI token must be RS256-signed by a key GitHub Actions publishes, name GitHub Actions as its issuer and the install's URL as its one audience, and not be expired; its jti is recorded, so a replay is refused; a run in a repository no registered API is bound to is refused before its body is judged; a CI caller may call `contract.report` alone.
- Test: `packages/commands/test/ci-callers.test.ts`: "for another audience is refused with 401 invalid_token, and takes no report"
- Test: `packages/commands/test/ci-callers.test.ts`: "is refused with 401 invalid_token when it was seen before: a replayed token takes no report"
- Test: `packages/commands/test/ci-callers.test.ts`: "from a repository no registered API is bound to is refused with 403 before its body is judged, and its token is not recorded"
- Test: `packages/commands/test/ci-callers.test.ts`: "is refused with 403 on every operation of the real catalog but contract.report"

### SR-7 GitHub and Jira webhooks

- Requirement: tracker-mirrors: GitHub webhooks are verified, deduplicated and processed in the background
- Requirement: tracker-mirrors: Jira webhooks are hints
- Requirement: public-api: Request bodies have a size limit
- Check: a GitHub delivery is stored only when its HMAC-SHA256 signature verifies under the stored secret, compared in constant time; a repeated delivery id stores nothing new; processing reads the current state from GitHub rather than trusting the payload, so a replayed body changes nothing; a body over 25 MiB gets 413 before it is read past the limit.
- Check: a Jira webhook is a hint: Tiehall re-reads the issue with the bot's token before recording anything.
- Test: `packages/commands/test/github-webhooks.test.ts`: "answers a forged delivery with 401, and neither stores nor processes it"
- Test: `packages/commands/test/github-webhooks.test.ts`: "answers a repeated delivery id with 2xx, and sends no second job"
- Test: `packages/commands/test/github-webhooks.test.ts`: "refuses a delivery over 25 MiB with 413 before reading it past the limit, and stores nothing"
- Gap: Jira webhooks are task 25.8, which waits for the founder's Jira spikes 1.7 and 1.8.

### SR-8 The outbound fetcher

- Requirement: agent-safety: Outbound fetches refuse internal addresses
- Requirement: self-host-install: The setting that switches metadata-document fetching off
- Requirement: self-host-install: No telemetry and a documented list of outbound connections
- Check: a metadata document is fetched only over https, from a host whose every address is public, connecting only to the address checked, following no redirect, within 5 seconds and 64 KiB (the fetcher follows at most three redirects for any other use, each checked before it connects); GitHub and Jira calls go only to their own hosts; with `TIEHALL_CLIENT_METADATA_FETCH=off` nothing is fetched.
- Check: an install connects to nothing but the hosts the install docs list.
- Test: `packages/commands/test/outbound.test.ts`: "resolves each host once and connects to that answer, whatever the name resolves to later"
- Test: `packages/commands/test/outbound.test.ts`: "refuses localhost and a loopback address with the system's own resolver, before any connection"
- Test: `packages/commands/test/client-metadata-fetch.test.ts`: "fetches metadata documents when TIEHALL_CLIENT_METADATA_FETCH is unset or on, and not when it is off"
- Test: `tools/image-tests/test/install/egress.test.ts`: "made no DNS query and no connection attempt to any host but the stubs"

### SR-9 The database roles and the append-only events

- Requirement: self-host-install: Only the migrate step holds the database owner's credentials
- Requirement: activity-log: The activity log is append-only
- Check: the app connects as a role that owns nothing, cannot create, alter, drop or truncate a table, and only inserts into and reads the event tables, whose triggers refuse every update, delete and truncation, even the owner's; only the migrate step receives the owner's credentials.
- Test: `packages/db/test/database-roles.test.ts`: "owns no table, and no other object in the database"
- Test: `packages/db/test/database-roles.test.ts`: "only inserts into and reads the event tables"
- Test: `packages/db/test/append-only.test.ts`: "cannot drop, disable or replace the trigger, or switch triggers off for its session"
- Test: `tools/repo-checks/test/compose-policy.test.ts`: "fails the owner's password given to the app, under any name or as a secret file"

### SR-10 Encrypted integration secrets

- Requirement: self-host-install: Stored integration secrets are encrypted
- Check: each stored secret is sealed with AES-256-GCM under a fresh nonce, with the secret's name bound as associated data, under a key derived from `TIEHALL_SECRET_KEY`, which the database never holds; a dump restored without the key decrypts nothing.
- Test: `packages/commands/test/integration-secrets.test.ts`: "cannot be moved onto another secret's name, or changed, without failing to decrypt"
- Test: `packages/commands/test/integration-secrets.test.ts`: "cannot decrypt the stored secrets when restored without the key"
- Test: `packages/commands/test/integration-secrets.test.ts`: "never holds the key, in any encoding, nor the key derived from it"

### SR-11 Container confinement

- Requirement: self-host-install: Tiehall's containers are confined
- Requirement: self-host-install: Compose runs Tiehall and Postgres
- Check: the app and the migrate step run as a non-root user, on a read-only root filesystem with a memory-backed `/tmp`, with every capability dropped and no way to gain privileges; the image holds no package manager; Postgres publishes no port, and the app one port on 127.0.0.1.
- Test: `tools/repo-checks/test/compose-policy.test.ts`: "fails an app that keeps its capabilities, and a migrate step that runs as root, writable and able to gain privileges"
- Test: `tools/repo-checks/test/compose-policy.test.ts`: "fails a stack where the database publishes its port"
- Test: `tools/image-tests/test/image.test.ts`: "carries node but no package manager, so nothing at run time can install code"
- Test: `tools/image-tests/test/image.test.ts`: "cannot write outside /tmp"

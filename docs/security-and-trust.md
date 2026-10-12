# Security and trust

This page is for the people who run an install and for those who decide whether to trust one. It says what Tiehall's safeguards prove and where they stop: the confirmation step for decisions that bind people, the activity log, the install's outbound connections, and its logs. [Installing and running Tiehall](install.md) covers TLS, the setup code, backups and the commands on the host; the [security review checklist](security/review-checklist.md) lists what the maintainers review before a release, and [SECURITY.md](../SECURITY.md) how to report a vulnerability.

## What the confirmation step does not prove

Agents act for their people, but some decisions are left to the people themselves: the commitments an agent can only propose, such as a due date, a scope change after a claim, a decline, a reassignment, a withdrawal or marking a request done without a merged pull request; the changes to who may sign in and what agents may do: a role change, a member's removal, an invite, the sign-in policy, the rules for personal access tokens, the daily budget of agent writes, a new personal access token and the approval of an agent client; and connecting GitHub or changing its App's key or webhook secret, registering an API, confirming a contract change's requests to more than 10 teams and exporting the activity log. Each of them takes effect only when a person confirms it in the web UI, signed in with their web session, on a review page that shows, in Tiehall's own words, exactly what will happen. The page carries a single-use nonce, bound to the person, their session and that one action, which expires after 5 minutes, and the confirmation must come from the install's own origin. No agent surface offers these actions, so an agent's OAuth token or personal access token can never take one.

Not every admin action needs the step. An admin adds people to a team or takes them out of it without the confirmation step, in the web UI only, as they create, rename and set up teams and revoke invites. Who belongs to a team decides whose inboxes the team's requests reach and who may give the team's side of a commitment, so an agent that drives an admin's signed-in browser could change that without a review page.

What the step cannot tell is whether the person or an agent clicked. An agent that drives your own signed-in browser can click confirm on a review page, and can post a message from the web UI that clears a request's `needs_human` flag, which Tiehall counts as a person stepping in after agents wrote too much on a request. Tiehall records every confirmation and every web action with the actor kind `web_session` for this reason: nothing it records in this version claims that a person rather than an agent acted.

So: Do not give a browser-driving agent a browser profile that is signed in to Tiehall. Give such an agent a browser profile of its own that is signed in to nothing, and keep your Tiehall session in a profile no agent drives. On a trial install at `http://localhost`, that profile also visits no other local server, as the [install docs](install.md#start-the-install) explain.

Receipts, the undo window and keeping the confirm URL away from models reduce this risk; they do not remove it:

- Every confirmation gets a receipt in the web inbox, and by email when the install sends email: a commitment's, an undo's, and every other action's the step guards, such as a new personal access token, an approved agent client or the CLI, a role change or an invite, so anything you did not confirm shows up where you look. A receipt says in Tiehall's own words what you confirmed, as its review page said it, and never holds a secret, a key or a token's value. The confirmations other than a commitment's are also recorded as security events in the activity log, which admins read, and a new personal access token or an approved agent client is also listed on your page `/tokens`, "Connected agents and tokens", where you can revoke it.
- A due date, a scope change, a reassignment and a decline can be undone for 15 minutes after they take effect, with the same confirmation step.
- The URL of a proposal's confirm page reaches people only through the web inbox, email and the URL-mode elicitation an MCP client shows its user. It never appears in what an agent reads: tool results, CLI output, hook output, the markdown and JSON of request URLs, the wait answer, or the answer the REST API gives to a commitment. An agent that follows instructions hidden in another team's text has no confirm URL to open.

Passkeys, which would prove that a person was present, are not part of this version; a later release can add them to the same confirmations without changing their rules.

## What the activity log does not prove

The activity log holds every change to a request and every security-relevant action, such as a sign-in, a role change, an agent client's approval, a new personal access token or an export of the log. Admins read it in the web UI and export it as JSONL, with the confirmation step; members see only the changes to requests, on the request pages and in what their agents pull. The log is append-only for the app: the app's database role can only add and read events, the database refuses every change and deletion of an event, and the app never receives the database owner's credentials, which Compose gives only to the one-shot `migrate` step. A bug in the app, or someone who takes over the app, cannot rewrite the log.

The activity log is not tamper-evident: whoever holds the database owner role or controls the host can change or delete events without the change being detectable. The owner's password is in `.env`, and `backup.sh` and `restore.sh` use it on the host, so anyone who can read `.env`, run commands on the host or reach the database as its owner can rewrite history. The append-only rules only stop the app itself from rewriting history. Keep `.env` and the host as closely held as the data, and keep exports of the log you may need later where the host cannot reach them.

A tamper-evident log, with a hash chain anchored outside the install, is planned as a later addition.

## The web UI's pages

The pages where a decision is made run no script: every review page and confirmation under `/confirm/…`, the consent screen, the device approval page, the setup screen, the sign-in page and every refusal page. An agent that drives a browser finds no script there to help it click, and text that reached a page as markup can neither run nor restyle it, since no page allows inline scripts or styles. Every page loads its stylesheet, its icons and its manifest from the install alone, loads no font, and cannot be framed by another site.

The live hall, at `/hall`, which every member sees, shows the requests between teams and who is at work on them: request titles, team names, logins and agent clients' names, as text, and who caused each event about a request, with the actor kind and the client. It never shows a security event, to anyone, admins included, nor a message's or the packet's text, an email address, an IP address, a user agent or a token. Its reads take only a web session, so no agent's token can read it, and they do not keep a session alive. [The web UI](web-ui.md) says more.

## No telemetry, and what an install connects to

An install sends nothing to the Tiehall project or to any service it runs: no usage statistics, no update check, no error reports and no license check. Framework telemetry is off, at build and at run time, for the web framework and the sign-in library alike. Tiehall calls no language model and sends no data to a model vendor: every summary, digest and notice it writes comes from a template.

An install's only outbound connections are:

- GitHub: `github.com` and `api.github.com`, for sign-in, the GitHub App, pull requests and the GitHub Issues mirror, and `token.actions.githubusercontent.com`, for the published keys that check the tokens of the contract Action's runs.
- The Jira Cloud site an admin connects, `<name>.atlassian.net`, when one is connected.
- The SMTP server in `.env`, when one is set.
- The Client ID Metadata Documents of the agent clients that connect, on the hosts their client ids name. Tiehall fetches them through a fetcher that resolves each host itself and refuses loopback, private, link-local and cloud metadata addresses, and redirects to them.

Set `TIEHALL_CLIENT_METADATA_FETCH=off` in `.env`, and run `docker compose up -d`, to stop the metadata-document fetches: the install then makes none, and agent clients sign in after registering through Dynamic Client Registration instead. Write your egress rules from this list; GitHub.com must stay reachable, from the install and from people's browsers, because people sign in with GitHub. The web UI and the API reference page at `/docs/api` load nothing from other hosts: every script, style sheet, font and image comes from the install itself.

The CI of this repository runs an egress test that boots an install in a network where only stand-ins for these services are reachable, and fails on any other DNS query or connection attempt, with metadata-document fetching on and off. The host itself pulls the images and, with the `caddy` profile, reaches certificate authorities, as [the install docs](install.md#what-an-install-connects-to) list.

## What the logs hold

Tiehall's logs are one JSON object per line on standard output, which `docker compose logs app` shows: the time, the level, a message in Tiehall's own words, and ids, such as the ids of users, operations, mirrors, the GitHub App, its installations and repositories. An error is logged by its name, its code and its stack frames; its message, which can quote the data it failed on, is left out unless Tiehall wrote it.

The logs hold never the text of messages or packets, and no credential: no access tokens, refresh tokens, personal access tokens, OIDC tokens, session cookies, confirmation nonces, API tokens or App secrets, no `Authorization`, `Cookie` or `Set-Cookie` header, and no query strings of URLs. Before a line is written, the logger drops the values of fields named for a credential or a body, query strings and fragments, and anything shaped like a token, wherever it appears. The CI of this repository sends a canary text and a canary token through failing requests and failing background jobs, and fails when either reaches the logs.

The one secret the log shows is the setup code, on purpose: while setup is not complete, the app prints a one-time code at each start, and whoever reads the log, and so already controls the host, enters it on the setup screen. The code stops working once setup completes. `admin setup reopen` prints a new one, for the reopened step only.

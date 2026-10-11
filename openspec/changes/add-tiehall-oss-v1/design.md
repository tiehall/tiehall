# Design: Tiehall open-source v1

## Context

[proposal.md](proposal.md) says why v1 is an open-source, self-hosted product and what it covers. This document says how it is built, and it is self-contained: it cites no document outside this repository.

**How the specs cite this document.** Every `Source:` line in `specs/*/spec.md` names the sections of this document that the rule comes from and, where one applies, the decision numbers restated below. Its items are separated by semicolons, decisions first and sections after, for example `Source: D28 #13; design.md, Decisions this change rests on` or `Source: D23; D30 (2); design.md, Self-hosting decisions: S7`. The sections, and how they are cited, are:
- **Decisions this change rests on** (`design.md, Decisions this change rests on`): the product decisions, by number, as public rules. A decision is cited by its number, such as `D35`, `D28 #4, #48` or `D30 (2), (4)`.
- **Design rules carried from the hosted design** (`design.md, Design rules: <area>`): product rules that the earlier, hosted design settled section by section and that still hold, grouped by area.
- **Technical decisions T1–T17** (`design.md, Technical decisions: T7`): libraries and internal structure carried from the hosted design, each marked where self-hosting changes it.
- **Self-hosting decisions S1–S16** (`design.md, Self-hosting decisions: S7`): the decisions that are new in this change.

A rule that rests on a reading this document had to choose, because no decision settles it, is listed under [Readings to confirm with the founder](#readings-to-confirm-with-the-founder); the spec cites the section of this document that states the reading.

**Current state.** The foundation from the earlier plan exists and carries over: the pnpm monorepo on Node 24 with strict TypeScript and a Postgres 17 test harness; the dependency rules; the CI checks for model-vendor SDKs, pinned workflow actions, secrets in history and Renovate's 7-day release age, which the self-host-install spec now states as release pipeline rules (T13); the one image with the roles `web`, `worker`, `migrate` and `all`, with its container tests; the self-host Compose file (`deploy/compose.yaml`) with its boot test against stock Postgres 17; and the build job that pushes the image to GHCR by digest. The SaaS Compose overlay and its test belong to the hosted plan and are removed. No product code exists yet. The foundation spikes on MCP authorization, the device flow, URL-mode elicitation and the Claude Code hooks ran on throwaway branches; their corrections are folded into T7, T9 and T15.

**Constraints.**
- A small team of maintainers builds it: one framework, one deployable and one database.
- Nothing calls a model (D3).
- TypeScript full stack: Node, Next.js and Postgres.
- An install needs Docker with Compose and nothing else: no cache, no object store, no cloud-vendor SDK and no service run by us (D33, D36).
- GitHub.com is required, because it is the only sign-in (D37).

## Goals / Non-Goals

**Goals:**
- **An install in minutes.** A company downloads the release files, writes its `.env` with `init`, runs one command, and the setup screen does the rest, including the GitHub App (S2–S4).
- **One authorization path.** Every domain command runs through one `execute()`, whichever surface starts it: REST, MCP, the CLI, a negotiated URL, the web UI or the worker (T3).
- **One source for public contracts.** The REST API and its OpenAPI description, the MCP tool schemas and the packet schema are generated from one zod source, and CI checks each for breaking changes (T10, T11).
- **Binding decisions stay with people.** Commitments and changes to who may do what are confirmed in the web UI, and the confirmation is built so that passkeys can be added to it later without changing its rules (S7).
- **The company's data stays with the company.** No telemetry, and a short, documented list of outbound connections (S13).
- **Safe upgrades.** Expand-then-contract migrations, a documented backup before every upgrade, and CI tests for a fresh install, an upgrade and a backup-and-restore round trip (S11, S12, T17).
- **Room for later.** The data model keeps an org row and org ids, so a hosted version or several orgs per install can come without rewriting tables (S1).

**Non-Goals:**
- **Later additions (D35):** SSO, the agent-client allowlist, the anchored tamper-evident audit log (hash chain, public anchoring, offline verification), and several orgs per install, which includes requests between companies.
- **Passkeys** in v1. They may come later as an option (D35, S7).
- **Running a service:** hosting, managed backups, point-in-time recovery in the default install, a deploy agent, monitoring and alerting, status pages, data-processing agreements and on-call. Operators run their install.
- **Billing, plans, entitlements and seat counting.**
- **Other sign-in methods:** Google, passwords, magic links, email codes.
- **Org export, user erasure, org delete and tombstones.** Operators own the database. An admin action to erase a departed person's data is an open question.
- **High availability.** One `all` container is the supported shape, and an upgrade restarts it. Running `web` and `worker` as separate containers works, but zero-downtime upgrades are not a v1 goal.
- **Later scope:** rooms (D11), A2A and outbound webhooks (D8), Claude Code channels and a server-sent event stream, Linear and Jira Data Center (D17), GitHub Enterprise Server and GitHub Enterprise Cloud with data residency, importing tracker comments, contract formats other than OpenAPI (D14), consumer-map imports (D15), service accounts, a server-side diff mode, and a Helm chart.
- **Air-gapped installs.** GitHub.com must be reachable from the install and from users' browsers.

## Decisions

### Decisions this change rests on

The numbers are the project's own decision numbers, kept so later changes can refer to them. Numbers that are missing here are decisions about process, business or the earlier hosting plan that no spec relies on. Where a rule changed for self-hosting, it says "adapted" and names the decision below that changes it.

#### The open-source v1 (D33–D38)

- **D33. Open source and self-hosted.** Tiehall v1 is an open-source product that installs easily, that a company runs on its own servers, and that needs no service run by us. A hosted version or enterprise features may come later; the data model keeps room for them (S1).
- **D34. Licenses.** The server is licensed under AGPL-3.0. The client pieces are licensed under Apache-2.0: the `tiehall` CLI, `@tiehall/client`, the Claude Code plugin, the contract Action and the packet schema (D24). Under the AGPL, a modified server offered to users over a network must offer those users its source. S16 maps these pieces onto directories: the plugin includes its skill, and the packet schema includes its conformance fixtures and `@tiehall/packet`, which D24 publishes with it. Everything else, the command catalog included, is server code under AGPL-3.0.
- **D35. The scope of v1.** One company per install; teams and roles; team-addressed requests with the packet and its revisions; MCP, the CLI and the Claude Code plugin; the requester loop (pull, wait, hooks); the contract-change flow with the GitHub Action; PR links and close on merge; loop limits and fencing; two-sided commitments confirmed in the web UI, with passkeys optional later; the Jira Cloud and GitHub Issues mirrors. Later additions, not in v1: SSO, the agent-client allowlist, the anchored tamper-evident audit log, and several orgs per install.
- **D36. Install: Docker Compose, Tiehall plus Postgres, with one command.** A first-run setup screen creates the admin account. Settings live in one `.env` file. Upgrades pull a new image and apply migrations automatically. Adapted by S2: "one command" is read as `docker compose up -d`, which starts Postgres, the migrations and the app once `.env` exists; downloading the release files and writing `.env` with `init` come before it (Readings to confirm, R1).
- **D37. Sign-in: GitHub only, set up in one click on the setup screen.** Each install creates its own GitHub App through GitHub's manifest flow. The same App serves sign-in, PR links, close on merge and the GitHub Issues mirror, and maps PR authors to users. There are no passwords. Adapted by S4: the one click on the setup screen starts the manifest flow; GitHub's own pages then ask the operator to confirm the App, to install it and to authorize sign-in, which Tiehall cannot skip (Readings to confirm, R1).
- **D38. A public repository.** The whole repository, server and client pieces, is public.

#### Earlier product decisions that still hold

- **D3. No model.** Tiehall never calls a language model, never hosts or runs agents, and sends no data to a model vendor. Agents connect to it. Routing uses declared data, classification comes from the diff engine in the customer's CI, and every summary, digest, notice and receipt comes from templates.
- **D5. Beside the trackers.** Tiehall is its own app, with a web UI and agent integrations. It sits beside GitHub and Jira and mirrors into them; it replaces neither, and it is not a chat-app plugin.
- **D7. One messaging core.** A request is a conversation plus lifecycle data, so rooms can be added later on the same core.
- **D8. Agent surfaces.** MCP, the CLI, a Claude Code skill and plugin, and authenticated URLs come first. A2A and outbound webhooks come later. Most receiving agents are driven by a person, so pull is the default and push only makes delivery faster.
- **D9. The pains.** Passing context along, clarifying questions that block progress, and API contract drift between teams. Tracking status and ownership is left to the trackers.
- **D11. Requests only.** v1 ships requests; free-form rooms come later. Clarifying questions live in each request's own thread.
- **D12. Names.** The product is Tiehall. The CLI and the MCP server are named `tiehall`.
- **D14. Contract changes.** OpenAPI only. When a provider PR changes an OpenAPI description in a breaking way, a GitHub Action in the provider's CI finds it, and Tiehall opens a request to each team that consumes the API. The consumer's agent pulls the classified diff, questions go to the provider PR's author, and the consumer closes the request with its own PR. A developer can also attach a classified diff to a request by hand. Drift monitoring and contract testing are out.
- **D15. The consumer map.** Teams declare in Tiehall which APIs they consume. Because the map is kept by hand it can go stale, so declarations are re-confirmed. Imports from other sources come later.
- **D17. Mirrors.** Requests mirror into GitHub Issues and Jira Cloud. Linear and Jira Data Center wait.
- **D19, the parts that hold.** One app and one Postgres database, shipped as one image that runs a web role and a worker role. A documented public API whose OpenAPI description is generated from the same command catalog as every other surface, so there is no separate API service. A published packet schema. The API and the schema stay labeled beta until real use has shaped them. D19's trust layers become: people confirm in the web UI now and may add passkeys later (S7); the allowlist, the tamper-evident audit log and SSO are later additions (D35).
- **D23. Commitments need a person.** An agent acting for its own signed-in user may claim a request, start work, ask and answer questions, and link PRs. These are commitments, which an agent can only propose and a person confirms: a due date set or changed after the request was opened, a change to scope or acceptance criteria after a claim, a decline, a reassignment to another team, a withdrawal, and marking done without a merged PR. Text from another team can try to steer an agent, so binding decisions stay with people. In v1 the person confirms in the web UI (S7).
- **D24. The packet schema is open.** It is licensed under Apache-2.0 and published once v1 of the schema has settled with real use, so that others can adopt it.
- **D25. Within one company.** Requests go only between teams of the same company. Requests between companies come later. In v1 one install is one company (S1).
- **D26, the part that holds.** Published schemas get lasting URLs under `https://tiehall.com/schemas/`. Nothing else is served from there for v1: before publication, each install serves the beta schema itself (D28 #22).
- **Superseded or no longer applying.** D18 (a hosted service only) is superseded by D33, and D20 (GitHub, Google and SSO sign-in) by D37. D13 (the schedule), D21 and D22 (the hosted plan's hosting and billing) and the rest of D26 (the hosted app's domain and the passkey relying party) do not apply to v1.

#### Detail rules (D28)

D28 settled, by number, the detail points found while writing the hosted specs. The ones v1 keeps are restated here with their numbers. Not carried over: #2 (hosted operator logs), #6 and #7 (org delete and org export; the activity-log export replaces the audit export, S14), #8 (user erasure; see Open Questions), #12 (org slugs; URLs have no org part, S15), #30–#33 and #35 (passkeys), #37–#40 and #42 (SSO and identity linking), #45 (picking an org for a token; one org per install), #84–#88 (the hash chain and anchoring), #89–#93 (hosted operations, legal points and billing), and #95 (housekeeping).

*Cross-cutting*
- **#1 The error model** (adapted). One table of RFC 9457 problem types covers Tiehall's own refusals on every HTTP endpoint it serves, and the MCP tools report the same refusals as tool errors: 400 for input that fails the schema, and for a value outside what the install's settings allow; 400 with `upgrade-required` for a CLI below the minimum; 403 when the caller's role or part in the request does not allow the action, when personal access tokens are switched off, when a required web confirmation is missing or invalid (S7), when the caller has been removed, when a CI caller calls anything but `contract.report` or reports for an API outside its repository, and when a GitHub account may not sign in (S5), including a sign-in whose only way in is an expired invite; 404 for a route or operation the surface does not offer, and for a record named in the path or the input that does not exist; 409 for state conflicts, with the problem type `needs-human` for an agent write to a flagged request; 428 for a packet revision without `If-Match`; 429 with `Retry-After` for write limits, budgets and caps; 503 with `Retry-After: 0` while the app shuts down; 503 with the problem type `setup-required` before setup is complete (S3). The rows for the client policy, the SSO age and passkeys are dropped, and so is the hosted 409 for accepting an expired invite, because in v1 an invite is accepted by signing in. On `/mcp`, a refused request state (T9) and the OAuth refusals are HTTP statuses, not tool errors. The table lives in the public-api spec.
- **#3 Visibility and sides.** Every member sees every request. Members of the target team claim, start, decline, mark done and reassign. The requester side, meaning the requesting user and the members of the requesting team, withdraws, changes scope and adds packet revisions. Either side may propose a due date.
- **#4 Who may do what** (adapted by S6). Admins create invites, change roles, remove members, manage teams and who belongs to them, set the sign-in policy, connect and configure integrations (GitHub installations, Jira, team mappings), register APIs, set the PAT switch, the PAT lifetime and the write budget, and view and export the activity log. Members of a team declare and re-confirm the APIs it consumes. There is no owner role, and an install always keeps at least one admin.
- **#5 Invites** (adapted by S5). An invite names a role, `member` unless it names `admin`, is bound to one GitHub account that Tiehall resolves from the GitHub username when the invite is created, and expires after 7 days.
- **#9 IP addresses and user agents** of security events are kept apart from the events, for 90 days (S14).
- **#10 Removed members.** Their claims stay, so the target team can reassign or release them; pending proposals for which they are the accountable human are cancelled.
- **#11 Teams.** A user can belong to several teams; the requester picks the requesting team, which defaults to their only team; a team may have no members.

*Requests, the packet and the API*
- **#13 Transitions.** Decline and withdraw from any state that is not terminal; done from `claimed`, `in_progress` or `needs_info`; the claimant can release a claim back to `open` without a proposal.
- **#14** A due date in the packet a request is opened with is not a commitment; only later changes are.
- **#15** "Scope" means the need, the acceptance criteria and the contract section.
- **#16 Proposal lifecycle.** The accountable human can reject a proposal, the proposer can withdraw it, it expires after 7 days, and pending proposals are cancelled when the request reaches a terminal state.
- **#17 Several blocking questions.** The request stays in `needs_info` until every one is answered, and every answer names its question.
- **#18 Reassignment.** A reassigned request returns to `open` and unclaimed in the new team. Undo restores the old team, key and mirror, and the new key then redirects back.
- **#19** Actions taken through a web session are recorded with the actor kind `web_session`.
- **#20 Idempotency-Key**, following draft-ietf-httpapi-idempotency-key-header: optional; keys kept 24 hours per caller; a replay gets the first response; a reused key with a different body gets 422.
- **#21** Adding a packet revision requires `If-Match`; without it the answer is 428.
- **#22 Packet beta values.** The `$id` is `https://tiehall.com/schemas/packet/v1-beta.json` and `schema_version` is `"1-beta"` until publication, then `"1.0"`. Adapted: each install also serves the schema at its own `/schemas/packet/v1-beta.json`.
- **#23 Required fields and `extensions`.** The need is required, and the contract section is required on contract-change requests. `extensions` is keyed by reverse-DNS namespaces, kept as sent, marked untrusted and capped at 16 KB.
- **#24** The packet media type is only named in the published spec; the API serves `application/json`.
- **#25** "What changed since revision N" is an RFC 6902 JSON Patch plus a list of the changed fields.
- **#26** `open_request`, `tiehall open` and the web form refuse a request that lacks a field its target team requires, and list the missing fields.
- **#27** `info.version` has the form `0.N.0` while the API is beta, so the compatibility check can require a version bump.
- **#28 The changelog** (adapted). The API changelog page is `/docs/api/changelog` on every install, and each release's notes carry the same entries. The change emails to token holders are dropped: no central list of token holders exists.
- **#29** `/docs/api` needs no sign-in. The CLI and the Action are licensed under Apache-2.0.
- **#34 Undo** (adapted by S7). Undo covers only the four reversible commitments, a due date, a scope change, a reassignment and a decline; it runs 15 minutes and is confirmed in the web UI like a commitment.
- **#36** The body of the 202 answer to a commitment holds no confirm URL, because agents read it.
- **#41 Alerts** (adapted by S10). Alerts about broken integrations and similar problems appear as a banner to admins in the web UI, and go by email to admins when SMTP is set.

*Agent access and agent safety*
- **#43 Client registration** (adapted by S13). Dynamic Client Registration accepts 10 registrations per hour per IP address, and a client never used is removed after 7 days. Tiehall fetches at most 60 Client ID Metadata Documents per minute from one host. The platform-wide denylist is dropped; an operator can switch metadata-document fetching off with the `.env` setting `TIEHALL_CLIENT_METADATA_FETCH` (S2, S13).
- **#44** The admin who registers an API may bind it to one `job_workflow_ref`.
- **#46** PAT owners are reminded 14 and 3 days before a PAT expires (adapted: in the web inbox, and by email when SMTP is set).
- **#47** Each user has a "Connected agents and tokens" page that lists and revokes their grants and tokens.
- **#48 Scopes** (adapted by S7). The OAuth scopes are `requests:read`, `requests:write` and `contracts:report`. The `admin` scope is dropped, because v1 offers admin operations only in the web UI.
- **#49 Limits** (adapted). 60 writes per minute per token; 5,000 agent writes per day per install by default, which an admin may change; 20 agent-opened requests per user per hour; 50 per pair of teams per day; each answered with 429 and `Retry-After`.
- **#50**, as changed by D30: reads are never blocked, and a message posted from a web session is a human action.
- **#51 Flips.** A flip is a round trip between `in_progress` and `needs_info`, counted per UTC day and only when an agent causes it; a blocking question that would start a fourth counted flip is posted as non-blocking, with a notice.
- **#52 Fan-out** (adapted by S7). Past 10 consumer teams, the first 10 requests open at once and the rest wait for an admin to confirm in the web UI; admins are told by a banner, and by email when SMTP is set.
- **#53** The characters stripped from the agent view are U+E0000–U+E007F, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069 and U+FEFF.
- **#54** The fence preamble names the origin: same team, other team or external.

*Agent surfaces and the requester loop*
- **#55** `claim` and `set_status` are two tools.
- **#56** `whoami` returns the user and the install the connection acts for (adapted), and `list_inbox` lists the requests addressed to the caller's teams.
- **#57** The CLI's `open`, `ask` and `reply` run the operations behind `open_request` and `post_message`, and `tiehall propose` exists.
- **#58 The `whats_new` scope.** Events on the requests the user opened, claimed or is accountable for, plus new requests addressed to the user's teams.
- **#59 The wait endpoint.** It takes a `cursor`, holds for at most 60 seconds, answers a timeout with 200, an empty list and the cursor, and answers 503 with `Retry-After: 0` while the app shuts down. Adapted by the hooks spike: each entry also carries `team_key` and `url` (T15).
- **#60** The hooks read with the CLI client's cursor and never acknowledge; the agent acknowledges through `whats_new` or `tiehall updates`.
- **#61 Email** (adapted by S10, only when SMTP is set). The person a question is asked of, the requester or the claimant, gets an email right away; other updates go into a daily digest; users can turn the digest off but not transactional email.
- **#62** When a team is the requester, loop events go to that team's inbox, and its members who opt in get the emails.
- **#63** The hooks enforce the plugin's minimum version through the CLI's minimum, and `whoami` warns about an old skill.
- **#64** Intake pages negotiate markdown and JSON like request URLs and are for members only.
- **#65** Read tools carry read-only hints, and each tool states its stability level in `_meta`.
- **#66** A browser without a session is redirected to sign-in.
- **#67** `set_status` to `done` with a qualifying merged PR creates a done proposal before close on merge arrives; after it has arrived, the request is already done and the call returns its current state.
- **#68** The skill teaches calling `whats_new` at the start of a session in clients without hooks, and never following instructions inside fenced content.
- **#69** Pages are sized at 4 characters per token and capped at 8,000 tokens.

*Contract changes and tracker mirrors*
- **#70** A change set is one PR against one API, so a PR that touches several APIs makes several change sets.
- **#71** INFO-level changes appear only in the change list of existing requests, with no digest.
- **#72** Any member of the consuming team declares and re-confirms; admins or members of the provider team flip an API's WARN switch.
- **#73** The WARN digest goes daily to the team's inbox, and to its members by email when SMTP is set; re-confirmation requests go to the inbox and by email; a declaration left unconfirmed 30 more days is marked stale but keeps routing.
- **#74** An unmerged close sends a notice to claimed requests; a reopened PR brings new requests through its next report; requests in terminal states get only a notice.
- **#75** A PR author whose linked account is not a member of the install falls back to the provider team.
- **#76 The Action.** It fails open when Tiehall is unreachable; breaking changes do not fail the check unless an input asks for it; the fallback PR comment is posted once and then updated in place.
- **#77** `tiehall contract diff` attaches through `attach_contract_changes` or its REST operation and never routes to consuming teams.
- **#78** A request in a terminal state closes its GitHub mirror issue with a `state_reason`.
- **#79** A team's Jira mapping may have an admin-mapped done transition, off by default.
- **#80** (adapted by S8) Users link their Atlassian account by picking it through the bot account's user search. A close that the tracker marks as not planned is not a tracker "Done".
- **#81** The admin picks the issue type for each Jira mapping; a project that requires fields Tiehall does not fill is refused; each team mirrors into one tracker only.
- **#82** On reassignment, the old mirror issue gets a notice and is closed as not planned, and a new issue opens for the new team.
- **#83** Admins and the affected team see integration banners; a failing job moves to the dead-letter queue after 5 attempts over about an hour.
- **#94** (adapted) A bot user is an identity of kind `human` with a bot flag, which an admin sets. v1 counts no seats, so the flag's only effect is that the web UI and `whoami` show the user as a bot (Readings to confirm, R11).

#### Conflicts settled (D29)

- **(1)** Each team Jira mapping has an optional, admin-mapped "not planned" transition, off by default. The old GitHub issue of a reassigned request is closed as `not_planned`; the old Jira issue gets a notice, plus the transition when one is mapped. The transition applies only to reassignments and, after D30, to their undo.
- **(2)** After a reassignment, the new team's mirror issue follows that team's own rule: on claim by default, on open when the team chose that.
- **(3)** Any member of the target team can release a claim held by someone who is no longer a member.
- **(4)** Not carried over, because v1 has no self-erasure. The rule that an install keeps one admin is S6.
- **(5)** The web inbox's update feed uses the `whats_new` scope plus the requests whose requesting team is one of the user's teams.
- **(6)** Turning the digest off also stops the WARN digest email; the re-confirmation emails keep going out (when SMTP is set).
- **(7)** A replayed CI token gets 401 `invalid_token`.

#### Loop limit and two-sided commitments (D30)

- **(1) The loop limit.** A request is flagged `needs_human` when agents make more than 6 writes on it within 10 minutes, or 30 in total, since the last human action. Adapted by S7: a human action is a message posted from a web session or a confirmation, in the web UI, of a proposal on that request. Either clears the flag and resets both counts. The limit is aimed at runaway loops, not at an ordinary exchange of questions and answers.
- **(2) Cross-team commitments need the other side.** A due date takes effect only when a person on each side has confirmed it: the proposal's accountable human, then a member of the target team when the requester side proposed it, or the requesting user or a member of the requesting team when the target team proposed it. A scope change while the request is claimed takes effect only when the claimant also confirms it, or a member of the target team when the claimant is no longer a member. Every other commitment needs one confirmation. Adapted by S7: confirmations are given in the web UI.
- **(3) Review points kept.** (a) The packet revisions Tiehall adds from a signed contract report are system actions, not commitments, also while the request is claimed. (b) `attach_contract_changes` and its REST operation need the `contracts:report` scope. (c) Provenance has the surface `api` for every `/api/v1` call that does not come through the CLI, and requests, revisions and system messages that come from a contract report are recorded with the actor kind `system` and the surface `github`. (d) On Jira, a move into the target status of the mapped "not planned" transition is a not-planned close; with none mapped, every move into the Done category counts as Done. (e) Undoing a reassignment applies the new team's mapped "not planned" transition to its Jira issue, or only a notice when none is mapped. (f) The "not planned" transition applies only to reassignments and their undo; a decline or a withdrawal changes only the label and adds a comment. Points 7 and 8 of the review (the org-delete grace period and hosted releases) are not carried over.
- **(4) Readings kept.** The hosted specs applied these readings where D30 left a detail open; v1 keeps them, adapted by S7 where they spoke of passkeys or email:
  - *Loop limit.* The write that makes 7 within 10 minutes, or the thirtieth, is accepted and sets the flag; later agent writes get 409 `needs-human` until a human action, and refused writes are not counted. An agent write is one made with an OAuth token or a personal access token, recorded with the actor kind `agent`; writes recorded as `system`, `integration` or `web_session` are neither counted nor refused. Acknowledging events is not a write and is never refused. Rejecting a proposal, an undo and a web-UI state change are not human actions. Setting and clearing the flag are domain events, carried by the pull readers and the digest with no immediate email; every read of the request and its web page show the flag.
  - *Who confirms.* The other side's confirmation or rejection before the accountable human's gets 409, and so does the accountable human confirming again; a confirmation by someone who may not give it gets 403. The second confirmation always comes from a different person, so a member of both teams who proposes a due date needs another member of the other side. The accountable human's side is recorded when the proposal is created; who is on the other side, and who holds the claim, are decided when the second confirmation is given. While a scope-change proposal waits and nobody holds the claim, nobody can give the second confirmation until someone claims; the user who proposed it can instead withdraw it, and the requester side can then, while the request is unclaimed, make the change at once. Once the accountable human has confirmed, anyone who may give the other side's confirmation may reject.
  - *Notices and receipts.* Once the accountable human has confirmed, each person who may give the other side's confirmation finds the proposal in their standing list, and gets an email when SMTP is set; the lists follow changes in that set at once. When a team is the requester, the email asking its side goes only to members who opted in. Each confirmation gets its own event and receipt, and when the commitment takes effect both people get a receipt that says so. A proposal shows the confirmations it needs and has, and when it expires, wherever it is returned, listed or emailed.
  - *How a proposal ends.* Rejection, withdrawal, expiry and cancellation are domain events that name the ending; the ending reaches the accountable human's `whats_new` and their standing-list receipt, and is what a retried elicitation returns; no immediate email is sent. Every confirmation must come within 7 days of the proposal's creation, and nothing restarts that clock. A confirmed reassignment cancels every other pending proposal on the request. A proposed packet change is cancelled as stale as soon as the current revision moves past its base revision. Proposals cancelled by a decline or a reassignment stay cancelled when it is undone. Adapted: no operation edits a proposal's content, and a proposed packet change is cancelled as stale once its base revision is overtaken, so what a person confirms is always what they reviewed and a confirmation, once given, stays valid while the proposal waits; the hosted reading that voided confirmations when the confirm page changed has no trigger in v1 and is dropped (S7).
  - *Undo.* The 15-minute window starts when the commitment takes effect, and the undo link is in the receipt that says so; either of two people who confirmed may undo alone; an undo is recorded like a confirmation and each person who confirmed gets a receipt; undoing a due date or a scope change gets 409 once the current revision is no longer the one the commitment created.
  - *Other.* The due date in the opening packet is neither a commitment nor two-sided.

### Design rules carried from the hosted design

The hosted design was approved section by section. These rules from it still hold for v1, adapted where marked. The specs cite them as `design.md, Design rules: <area>`.

#### Teams and roles

- Teams live in Tiehall's own tables, and team membership is managed in Tiehall.
- Every call made for a user re-checks, at the time of the call, that the user is still a member, whatever session or token it carries, so a removal takes effect on the next call. A removed member gets 403.
- The user's role bounds everything done for them, through a web session or a token.
- A renamed team key stays an alias of its team and counts as in use.
- A removal ends the member's web sessions and revokes their agent grants and personal access tokens, so none of them works again if the person later rejoins (S5).

#### Requests and events

- **States.** `open`, `claimed`, `in_progress`, `needs_info`, `done`, `declined` and `withdrawn`. The last three are terminal, except that a confirmed decline can be undone within the undo window. "Claimed" means the request has a claimant at that moment; a released claim leaves it unclaimed.
- **Blocking questions.** A blocking question moves an `open`, `claimed` or `in_progress` request to `needs_info`; answering every blocking question returns it to the state it had before.
- **Keys.** A request's key is its target team's key, a hyphen and a number from a counter kept per team, such as `FE-142`; numbers are never reused. Reassignment is a commitment that the target team proposes; once confirmed, the request gets a key from the new team's counter and the old key redirects to it.
- **Messages** are append-only; an edit adds a version.
- **Provenance** on every message: the accountable human, the actor kind (`human`, `agent`, `system`, `integration` or `web_session`), the client, the surface (`web`, `mcp`, `cli`, `api`, `github` or `jira`) and the team, stamped by the server and never taken from the payload. A web action is recorded as `web_session`, because the server cannot tell a person from an agent that drives a browser. Adapted by S7: in v1 nothing is recorded with the actor kind `human`; the value stays reserved for a later passkey confirmation.
- **Proposals.** A commitment started on any surface becomes a proposal that records who proposed it (client, surface and user), the confirmations it needs and has, and when it expires. A confirmation applies the commitment only if the request's state still allows it, and the commitment and its event are recorded together or not at all.
- **The event log.** Every committed change to a request appends a domain event in the same transaction, so an event exists if and only if its change committed. Events take the next number of one sequence, and sequence order equals commit order. Events carry ids, never message or packet bodies; readers fetch content through reads. Events are in the domain class or the security class, and the pull readers and wake-ups serve only domain events the reader may see.
- **Read cursors** are kept per user and client, and move only when the reader acknowledges.
- **Close on merge.** A request moves to `done` as a system action when a PR merges that was linked to it, or mentioned its key in the title, body or branch name, before merging; that merged after the claim; and that is in a repository a connected installation covers. It applies only from `claimed`, `in_progress` or `needs_info`. Linking an already merged PR creates a done proposal instead, when a member of the target team links it and the state allows done. The provider PR never closes its own contract-change requests.
- **System actions** need no proposal: close on merge, the system withdrawal of an unclaimed contract-change request, and the revisions a signed contract report adds. A system withdrawal never touches a claimed request.

#### Handoff packet

- **Format.** `tiehall.packet/v1`, a JSON Schema (draft 2020-12). Fields: the need and the acceptance criteria; a contract section (the API; base and head ref and commit sha; the diff engine's name and version; the changes, each with the engine's id, its level and the operation; the provider PR; the provider status; migration notes; a deprecation window); code refs, links, a due date and `extensions`.
- **One definition.** The JSON Schema and the OpenAPI component are generated from one definition and used for both requests and responses.
- **Open objects, strict server.** Objects do not forbid additional properties; the server parses strictly and drops keys it does not know, except inside `extensions`.
- **Untrusted fields.** Every field a user or an agent writes is marked untrusted in the schema.
- **Revisions** are numbered and immutable; adding one uses `ETag` and `If-Match`. A proposed packet change records its base revision.
- **Breaking changes before publication** need a changelog notice at least 14 days ahead, the `api-breaking` label and a changelog entry. After publication, v1.x only adds optional fields, and a packet built against a newer v1.x validates against every older one.
- **Publication** means four things at once: the schema, a short spec, conformance fixtures and a changelog in a public location under Apache-2.0; fixed release URLs under `https://tiehall.com/schemas/` (`v1.0.json` and on, with `v1.json` for the latest v1.x; D26); `@tiehall/packet` on npm with the types, a validator and the fixtures but not the fencing renderer, built from public source with provenance; and the media type `application/vnd.tiehall.packet+json; version=1`.
- **When** (adapted by S13, because v1 has no telemetry). The schema is published once no breaking packet change has been needed for four weeks and at least three companies are known, from their own reports, to exchange packets, contract packets included. The maintainers record the decision in the changelog.

#### Agent access

- Tiehall is its own OAuth 2.1 authorization server for MCP clients and the CLI. It publishes Protected Resource Metadata (RFC 9728) and authorization server metadata that advertises Client ID Metadata Document support, and one access token is accepted by both `/mcp` and `/api/v1`.
- **Six kinds of caller:** a web session, an OAuth token, a personal access token, a CI caller with a GitHub Actions OIDC token, a system job, and a verified integration event. Internal commands run only for a web session or, in the worker, for a system job or an integration event.
- **Clients.** A client identified by a Client ID Metadata Document is preferred, and counts as identified only when the document's `client_id` equals its URL. Dynamic Client Registration stays on, limited, and every DCR client is shown as unverified.
- **Flow.** PKCE with `S256` only; the RFC 8707 `resource` parameter bound to the token's audience; `iss` in every authorization response (RFC 9207). A call without a valid token gets 401 with a challenge that points to the metadata and carries a scope hint; a token without a needed scope gets 403 `insufficient_scope`. Tokens are accepted only in the `Authorization` header.
- **The consent screen** shows the client's name, the verified host of a metadata-document client or an "unverified client" warning, the redirect URI's host, and a warning when every redirect URI is on localhost.
- **Tokens.** Access tokens live 10 minutes; refresh tokens rotate and are single-use. A token acts for one user, within its scopes and the user's role; every call re-checks membership and, for a personal access token, the PAT switch.
- **The CLI** is a pre-registered public client that signs in with the device authorization grant. The device flow accepts only the CLI's client id, and device codes expire after 10 minutes. The approval page ignores any code in its URL, shows the IP address and time of the request with "continue only if you just ran `tiehall login`", and stores nothing until approved. The CLI keeps its token in a file readable only by the user (mode 0600).
- **Personal access tokens** start with `th_pat_`, are scoped, expire within 90 days or the install's shorter maximum, and are stored only as a hash. A new install starts with personal access tokens switched on and a maximum lifetime of 90 days.
- **Machine access** is a personal access token held by a bot user, which signs in with its own GitHub account like any person. Service accounts come later.
- **CI** presents a GitHub Actions OIDC token directly. Tiehall checks the issuer, the audience, `exp`, the `repository_id` and `repository_owner_id` of a registered API's repository, the optional `job_workflow_ref` binding, and a `jti` replay cache. A CI caller can call only `contract.report`, only for its repository's APIs, and acts for no user.
- **Outbound calls** to GitHub and Jira use Tiehall's own credentials, never a token a client presented.
- **The client matrix.** Sign-in and tool listing are tested on Claude Code, Cursor, Codex and Copilot, with metadata documents and with DCR, on both MCP protocol versions. The maintainers run it by hand on a recurring schedule, because it needs real client accounts (T17).

#### Agent surfaces

- Four ways in: a remote MCP server that offers tools only (no resources and no prompts), the `tiehall` CLI, a Claude Code plugin with a skill, and authenticated request URLs.
- **One MCP endpoint** serves protocol versions 2026-07-28 and 2025-11-25 and keeps no session between calls.
- **The tools:** `whoami`, `directory`, `open_request`, `list_inbox`, `whats_new`, `get_request`, `post_message`, `claim`, `set_status`, `link_pr`, `propose` and `attach_contract_changes`. `get_request` takes a key or a URL and returns the request in sections and pages below the 10,000-token size at which Claude Code warns. Results carry structured content plus fenced markdown. Tool schemas are lowered so current clients accept them: no `$ref` or `$defs`, a root of type object with no root-level composition, JSON Schema 2020-12.
- **The CLI** is the npm package `tiehall` for Node 22 or later, with `login`, `inbox`, `updates`, `get`, `open`, `ask`, `reply`, `propose`, `status`, `claim`, `link-pr`, `--json`, `contract diff`, `contract report`, `hook session-start` and `hook wait`. Adapted by S15: `login` takes the install's URL. `audit verify` is dropped with the hash chain.
- **The plugin** holds a skill in the Agent Skills format, which also loads on its own in Codex, Cursor and Copilot, the MCP connection and the hooks. The plugin and the skill carry versions, and Tiehall keeps a minimum for each.
- **Negotiated URLs.** One URL per request serves HTML to browsers, markdown for `text/markdown` or `.md`, and JSON for `application/json` or `.json`; the JSON is the matching `/api/v1` read and the markdown is fenced. Responses send `Vary: Accept, Authorization`, `Cache-Control: private, no-store` and an `ETag`. Every representation needs authentication and there are no secret links; a request without credentials that negotiates markdown or JSON gets 401 with a body that says to use `tiehall get` or `get_request`, and one that negotiates HTML, the default, is sent to sign-in (Readings to confirm, R17).
- **Team intake pages** say how a team wants requests filed and which fields it requires, and negotiate like request URLs.
- **URL-mode elicitation.** For a 2026-07-28 client that declares `elicitation.url`, a tool call that creates a proposal returns an input-required result with a URL-mode elicitation for the confirm page. The URL carries no personal data and is not pre-authenticated; the request state is bound to the token's subject, the client and the proposal; a retry returns the proposal's outcome; accepting the elicitation is not consent.

#### Requester loop

- **Pull is the contract:** `whats_new`, `tiehall updates` and the web inbox. Push only makes delivery faster.
- **The web inbox** has an update feed, acknowledged like any pull reader, and a standing list that acknowledging does not clear: proposals waiting for the user, receipts, and each of the user's teams' WARN digests and re-confirmation requests. A team's inbox is that team's part of its members' web inboxes.
- **Long-poll.** `GET /api/v1/events/wait` is woken with ids only; the reader then pulls the content.
- **Claude Code.** A SessionStart hook prints a digest made only of server text. A Stop hook run with `asyncRewake` runs the waiter, which long-polls with a 30-minute cap and a per-session lock that the CLI itself enforces, exits with code 2 when news arrives, and is armed again after every turn. If `asyncRewake` cannot wake Claude, a plugin monitor running `tiehall watch` replaces the waiter; it is experimental and runs only in the interactive CLI.
- **Other clients pull.** No channels and no server-sent event stream in v1. A Codex SessionStart snippet ships only after it has been tested.
- **Email for people** follows #61 and S10.

#### Agent safety

- Every string shown to agents has an origin: Tiehall-generated, same team, other team or external.
- Text Tiehall did not generate is fenced with a nonce made for that response and a preamble that says it is data; closing markers inside it are escaped; invisible characters are stripped; in JSON, user text sits under objects named `untrusted`.
- The web UI renders no raw HTML and loads no remote images from request content.
- Notices that can reach a model carry only server text: hook output and email subjects carry the request key, the event type, the team and the URL; an elicitation message carries the request key and the kind of commitment.
- Tracker mirrors carry a server-written summary and a link, never the packet or thread text.
- The outbound fetcher resolves host names itself and refuses loopback, private, link-local and cloud metadata addresses, and redirects to them.
- Loop limits and write budgets are counted in Postgres, inside the writing transaction.
- One PR reaches at most 10 consumer teams without an admin.

#### Contract changes

- Diffs run only in the provider's CI, through the Action, and on developers' machines, through the CLI. Tiehall never fetches, receives or parses an OpenAPI document; `contract.report` carries the API, the provider PR, the refs and shas, the engine's name and version, and the classified change list.
- Each API is registered to one provider team and bound to one GitHub repository, and accepts reports only from CI runs in that repository.
- **The Action** runs on `pull_request` events of the types opened, synchronize, reopened and ready_for_review, and skips drafts unless told not to. It installs the pinned oasdiff, verifies its checksum, computes the breaking changes and the changelog, and reports with a pinned CLI. It uploads no documents anywhere, and its docs show pinning it by commit SHA.
- ERR-level changes open one request per consuming team, keyed by change set and team; WARN-level changes go to a daily digest unless the API's WARN switch is on; INFO-level changes only appear on existing requests.
- Reports for the same change set that arrive within 2 minutes of each other are merged into one update.
- Each update adds a packet revision and a system message to every request of the change set that is not in a terminal state; terminal ones get a notice.
- Unclaimed requests are withdrawn when the breaking changes disappear or the provider PR closes unmerged; claimed ones get a notice.
- The provider PR's merge marks the change shipped and updates the mirrors, but closes nothing; each consumer closes its own request with its own PR.
- The requester is the Tiehall user whose GitHub account authored the provider PR, with the provider team as the requesting team; otherwise the provider team is the requester, and the Action comments on the PR with the workflow's own token.

#### Tracker mirrors

- **The GitHub App** asks for narrow permissions and no Contents permission, and for everything v1 needs on the first install, so installations never have to approve a new permission. Covered repositories follow each installation's selection. Everything Tiehall writes on GitHub appears as the App's bot.
- **Intake.** A webhook is verified, stored deduplicated by its delivery id, answered with 2xx, and processed in a background job. Failed GitHub deliveries are redelivered every 10–15 minutes.
- **A mirror is a projection:** the title, a summary Tiehall writes, a link and a label for the state; on Jira, a minimal Atlassian Document Format body. It is created on claim by default, or on open when the team chooses. Each state change and each question notice adds one comment. Creates are idempotent, and echoes of Tiehall's own writes are dropped. A team maps to one intake repository or one Jira project with an issue type, never both.
- **Jira statuses** change only through the optional mapped transitions (D29, #79); labels and comments show the state.
- **Inbound changes** (close and reopen, the assignee, the Jira status category) are recorded as events and change nothing, except that a tracker "Done" by a linked member of the target team becomes a done proposal when the team has turned that setting on; otherwise it adds a notice. Tracker comments are not imported.
- **Reconciliation** runs every 15 minutes: GitHub's `since` parameter, and for Jira `project in (…) AND updated >= -20m`.
- **Failed jobs** go to a dead-letter queue, shown as a banner with a Retry button.
- **Jira rate limits:** 1–2 concurrent calls per site, honoring `Retry-After` and `RateLimit-Reason`.
- **Reassignment moves the mirror.**

#### Public API

- One definition per operation serves every surface; an operation not offered on REST answers 404 there.
- Input and output are validated against the published schemas, and responses may gain fields without breaking clients.
- A commitment over REST answers 202 with the proposal.
- The OpenAPI 3.1 document is served without authentication at `/api/v1/openapi.json`, with `x-stability-level`, RFC 9457 errors, `Idempotency-Key` on POST, `ETag` and `If-Match` on packet revisions, and the 202 answers; `/docs/api` renders it.
- The major version is in the path, `/api/v1`.
- Stability levels are `alpha`, `beta` and `stable`; `contract.report` and the CI OIDC path are `stable` from the start, because pinned Actions call them. `alpha` is only for work between releases: a published release offers no operation or tool at `alpha`, so every operation a company can build on is held to the notice rules (D19: the API stays labeled beta until real use has shaped it).
- A `beta` operation changes in three steps: add the new shape; deprecate the old one with an `x-sunset` date at least 14 days later; remove it on or after that date. A `stable` operation gets at least 180 days. CI compares the document at the merge base with the pull request's and fails on a breaking change that skips these steps. The `api-breaking` label allows a break only for an urgent security fix.
- Deprecated operations send `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers.
- After an operation is `stable`, breaking changes go to `/api/v2`, and v1 keeps serving it for at least six months. MCP tools follow the same rules, and a snapshot of their names and schemas is compared on every pull request.
- The CLI sends its version, and the server keeps a minimum; `contract.report` keeps its own floor, raised only with 180 days' notice.
- CI regenerates the OpenAPI document and fails when it differs from the committed one.
- `@tiehall/client` is generated from the document and used by the CLI; it is published at 0.x once someone asks to build on the API.
- Client pieces are built from public source and published from CI with provenance, never from a laptop, except one placeholder publish per npm name.
- **Graduation** (adapted by S13). An operation becomes `stable` only after four weeks with no breaking change and a maintainers' decision recorded in the changelog; there is no usage count.

### Technical decisions

These carry over from the hosted design. Each says what changes for self-hosting. Versions are the ones pinned when they were checked on 2026-09-25.

#### T1. One app, one database, one image

- **Choice.** Node 24 LTS, Next.js 16 with standalone output, Postgres 17. One image with these roles: `web` (the UI, `/api/v1`, `/mcp`, the OAuth server, webhooks), `worker` (jobs and crons), `migrate` (runs migrations once, then exits) and `all` (web and worker in one process).
- **Changed.** `all` is the supported shape for an install (S2). Two new roles: `init` prints a complete `.env` with fresh secrets (S2), and `admin` runs operator commands (S3). The SaaS overlay is gone.
- **Why.** One person can build it, and one container is what most companies want to run.
- **Alternatives.** A separate API service with the UI as its client; Next.js inside a custom server, which cannot use standalone output.

#### T2. Repository layout and the import rule

- **Choice.** `packages/catalog` (command definitions and their zod schemas, no database code; server code under AGPL-3.0), `packages/commands` (`execute()` and the handlers, and everything that touches the database, the queue or the network), `packages/db` (the schema and migrations), `packages/core` (pure domain rules with no I/O: the state machine, the side rules, the confirmation rules), `apps/web`, `apps/server`, `packages/cli`, `packages/client`, `packages/claude-plugin` and `actions/contract`. dependency-cruiser lets only `packages/commands` and the migrations import `packages/db`, so every command the UI runs passes the same authorization as an agent's.
- **Changed.** The whole repository is public (D38), so the earlier plan's mirror into separate public repositories is dropped. The license layout is S16: the Apache-2.0 packages import nothing from AGPL-3.0 packages, so the CLI no longer imports the catalog and takes its commands from the OpenAPI document instead (T3). The canonical-text and Merkle modules of the hash chain are not built.
- **Why.** The import rule makes the one authorization path structural rather than a convention, and the package split follows the license line.
- **Alternatives.** One package for everything, which lets UI code reach the database directly and mixes the two licenses.

#### T3. One command catalog, one `execute()`

- **A definition holds** an id (the OpenAPI `operationId`), zod input and output schemas, the method, path and scopes, two flags, `commitment` (it becomes a proposal) and `confirm` (it needs the web confirmation, S7), the surfaces it is offered on (`rest`, `mcp`, `cli`; none means internal), and a stability level with a sunset date once deprecated.
- **`execute(commandId, caller, input)`** parses the input; authorizes one of the six caller kinds; turns a commitment started for a user into a proposal that records the confirmations it needs; for a `confirm` command, checks and consumes the confirmation nonce bound to this exact action and input; runs the handler inside `withOrg()`; and validates the output.
- **Changed.** `stepUp` becomes `confirm`, and a `confirm` command is offered on no agent surface. `withOrg()` keeps its name: it opens the transaction for the install's one org, re-checks membership and, for a personal access token, the PAT switch; it no longer sets a row-level-security setting (S1).
- **The surfaces stay thin.** REST is one catch-all route handler; MCP tools come from the surface flags; the CLI calls REST through the generated client, and its request subcommands come from the OpenAPI document, in which every operation offered on the CLI carries an `x-tiehall-cli` extension that names its command, so the Apache-2.0 CLI never imports the AGPL-3.0 catalog (S16); negotiated URLs call `execute('requests.get')`, with negotiation in `proxy.ts`; the web UI calls `execute()` in-process.
- **The confirmation digest** (S7). For a proposal's confirm page, the nonce is bound to a digest of what the proposal proposes and the request it applies to; the confirmations received, the claimant and the expiry are not part of it, so a confirmation given after they change still matches. For every other review page, the digest covers the command id and its exact input.
- **Why.** REST, MCP and the CLI cannot drift apart, and every command the UI runs passes the same authorization as an agent's.
- **Alternatives.** Hand-written handlers per surface, which drift apart. A CLI that imports the catalog, which would need the catalog under Apache-2.0 and so move server code out of the AGPL (Readings to confirm, R2).

#### T4. Data layer: Drizzle, roles and migrations

- **Choice.** Drizzle for the schema and queries. SQL migrations run in the one-shot `migrate` step before the app starts, and follow expand, then contract (S12). Non-transactional steps such as `CREATE INDEX CONCURRENTLY` run apart from the transactional migrator; each migration takes an advisory lock and sets `lock_timeout`; backfills run as batched jobs, never inside migrations.
- **Database roles.** `migrate` connects as the database owner. It creates and updates the app role, whose password comes from `.env`, and grants it what the app needs: data changes on the app's tables, but only insert and select on the event tables (S14). `web`, `worker`, `all` and the `admin` role's operator commands connect as the app role, which is not the owner. Compose hands the owner's password or connection URL only to the `migrate` service; `backup.sh` and `restore.sh` run on the host and read the owner's credentials from `.env`. The bundled Postgres accepts no network connection without a password. The Compose policy check fails when the app service can read an owner secret.
- **Changed.** No row-level security, no tenant lint and no cross-tenant test suite (S1). Every table keeps its `org_id` and composite `(org_id, id)` keys. Integration secrets are encrypted with AES-256-GCM under `TIEHALL_SECRET_KEY`, and each carries a key id, so that a later release can add key rotation without re-encrypting in place (Open Questions).
- **Alternatives.** Kysely; down-migrations, which are never used, because fixes go forward.

#### T5. The event log is the outbox

- **Choice.** The sequence number comes from a counter row locked inside the writing transaction, so commit order equals sequence order and cursors never skip a late commit. The domain write, its event and its job commit together; there is no separate outbox table and no relay. Events carry ids, never bodies, and are in the domain or the security class.
- **Changed.** One counter row for the install's org. No hash columns and no keyed content digests, which existed for the chain and for erasure.
- **Why.** Cursors never skip an event that commits late, and no relay process is needed.
- **Alternatives.** Bigserial event ids, which let readers skip events that commit late. A separate outbox table with a relay, which adds a process.

#### T6. The job queue lives in Postgres

- **Choice.** pg-boss 12.x: queues, cron, retries and dead-letter queues; `send()` inside the caller's transaction (T5); `key_strict_fifo` to serialize each mirror's jobs.
- **Crons.** Polling or GitHub redelivery, depending on the mode (S9); tracker reconciliation; GitHub organization membership reconciliation (S5); digests and email when SMTP is set; PAT and Jira-token expiry reminders; consumer-map re-confirmation; proposal expiry; removal of unused DCR clients; pruning of IP and user-agent records and of stored GitHub deliveries (D50 (4)).
- **Rules.** A job whose payload shape changes gets a new queue name; the worker stops gracefully.
- **Changed.** No per-org fairness groups.
- **Why.** Postgres stays the only infrastructure an install runs, and a job commits with the write that caused it.
- **Alternatives.** Redis or another broker, which adds a service every install has to run.

#### T7. Better Auth for identity and the OAuth server

- **Plugins.** Better Auth 1.7.x with `jwt()`, `mcp()` as the OAuth 2.1 authorization server (never combined with `oauthProvider()`), `cimd()`, and `oauthDeviceAuthorization()` from `@better-auth/oauth-provider` for the CLI.
- **Corrections from the MCP spike, all required.** `mcp()` needs `jwt()`. Set `accessTokenExpiresIn: 600` (the default is 3600). Restrict `grantTypes` to `authorization_code` and `refresh_token` (the default also advertises `client_credentials`). Turn on DCR with `allowDynamicClientRegistration` and `allowUnauthenticatedClientRegistration`, behind the rate limit.
- **Corrections from the device-flow spike, all required.** The plugin's `validateClient` does not restrict the flow to the CLI: it is consulted only for unregistered client ids, so any DCR or metadata-document client could use the device grant, and an accepted unregistered id would get a first-party session token. So: a `hooks.before` guard on `/device/code` refuses every client id except the CLI's with `unauthorized_client`; `validateClient` is not set; `/device/token` is blocked by the route guard (T8); the CLI is seeded as a registered client with a fixed id; the CLI sends `resource` and does not ask for `openid`, so its token's audience is the MCP resource alone; the approval page maps `expired_token` to 409.
- **Corrections from the GitHub sign-in spike (task 1.5, passed on 2026-09-28), all required.** Better Auth 1.7.6's GitHub provider signs people in through the GitHub App's user authorization with the App's client id and secret read from the database; Better Auth's default scopes are harmless, because a GitHub App ignores them. The App issues expiring user tokens (an access token and a refresh token, each with an expiry), and Better Auth stores them in the account row unless told otherwise, so keeping no user token (S5) needs a `databaseHooks.account.create.before` and `account.update.before` pair that sets every token field and both expiries to null; an `after` hook cannot change the row, and there is no provider option for it. The hooks cover a repeat sign-in, so `updateAccountOnSignIn` stays on. The auth instance is rebuilt from the stored credentials without a restart, and the next request uses it. `emailAndPassword.enabled: false` disables the flow but leaves its routes answering 400, so the 404 the sign-in spec asks for comes from the route guard (T8). The sign-in service must be given the client address that the trusted proxies yield, or sessions and the security events of sign-ins carry no IP address.
- **Other OAuth settings.** Metadata documents preferred; PKCE S256; `resource` bound to `aud`; `iss` in authorization responses; Protected Resource Metadata; rotating refresh tokens.
- **Changed.** Sign-in uses Better Auth's GitHub provider with the client id and secret of the install's GitHub App, which exist only after setup (S4); the auth instance is built from the stored credentials at start and rebuilt when they change. Until setup is done, the app serves only the setup routes, `/healthz` and, once the App's credentials are stored, `/webhooks/github`, whose deliveries are stored and processed after setup completes (S3, S9). `account.accountLinking` stays off. Tiehall keeps no user's GitHub token after sign-in: the `databaseHooks.account.create.before` and `account.update.before` pair sets every token field and both expiries to null before the row is written (D50 (16)). Memberships, roles and invites live in Tiehall's own tables, so the organization plugin is not used. Not used: Google, the passkey plugin and the SSO plugin.
- **CI** does not go through Better Auth: the contract endpoint verifies the GitHub Actions OIDC token directly. The expected audience is the install's `TIEHALL_URL`.
- **Alternatives.** A hand-built OAuth server; an RFC 8693 token exchange for CI, which Better Auth does not ship.

#### T8. Guarding Better Auth's own routes

- **Choice.** A `hooks.before` guard refuses every Better Auth route that is not on an explicit allowlist. Routes that change who may do what are either blocked and replaced by catalog commands with `confirm: true`, or kept and gated by the confirmation nonce for that exact action; the consent approval is gated the same way. A CI test lists every route in `auth.api` and fails on any route that is neither blocked, allowlisted as harmless, nor gated. Where Better Auth owns a write, such as a session or an OAuth grant, an after-hook appends its security event (S14).
- **Why.** An agent that drives a browser could call these routes with same-origin requests and a session cookie alone.
- **Changed.** The passkey and SSO routes are gone. Because the security event of a write Better Auth owns is appended right after that write rather than in its transaction, a process that stops in between would lose the event; the hosted plan's nightly comparison catches that and does not depend on the chain, so it stays: each night Tiehall compares the current members, roles and agent-client grants with the security events and appends a `reconciled` security event for each difference (S14).

#### T9. MCP: the official TypeScript SDK on one stateless endpoint

- **Choice.** `@modelcontextprotocol/server` 2.1.x, `createMcpHandler` at `/mcp` in a route handler with its default `legacy: 'stateless'`. One endpoint with no session store serves 2026-07-28 and 2025-11-25 clients.
- **Corrections from the MCP spike.** `requireMcpAuth` checks the token, and Tiehall builds `authInfo` from the claims. Discovery lives under `/.well-known/*`, which the app routes to the auth handler. `jwksUrl` points to an internal address, so checking a token makes no outbound call. A bad token's challenge carries `error="invalid_token"` (RFC 6750).
- **URL-mode elicitation, with the spike's corrections.** `inputRequired.elicitUrl()` returns an `InputRequiredResult`, and the `requestState` is sealed with `createRequestStateCodec()` and bound to the token's `sub`, the client id and the proposal. The codec's `ttlSeconds` is 691200, the proposal's 7-day lifetime plus one day (the default is 600), so a retry after the proposal expired still returns that it expired (Readings to confirm, R13). A tampered, foreign or expired state is refused by a route pre-check with 403, because the SDK's own refusal is a JSON-RPC error inside HTTP 200. The tool returns the inbox pointer on 2025-era connections and to clients without `elicitation.url`. The state is signed, not encrypted, so it carries no personal data.
- **Schema lowering.** Tool schemas are produced apart from the OpenAPI ones, with every `$ref` inlined, a root of `type: "object"` and no root-level composition (variants become a `kind` enum plus optional fields, and `execute()` still validates with the zod union), in JSON Schema 2020-12, computed once per process. A CI lint over the tool snapshot fails on `$ref`, `$defs` or root-level composition. Claude Code silently drops tools with root-level composition, and Codex turns `$ref` parameters into strings.
- **Why.** The official SDK serves both protocol versions from one stateless endpoint, so an install needs no session store.
- **Alternatives.** Raw `z.toJSONSchema()` output for tool schemas, which current clients mishandle. MCP resources and prompts, which clients support unevenly.

#### T10. zod schemas and the OpenAPI 3.1 document

- **Choice.** zod 4.6 in the catalog is the single source. A build script walks the `rest` definitions and calls `createDocument()` from `zod-openapi` 6.0.x with `openapi: "3.1.0"`. Responses are emitted without `additionalProperties: false`. The output is committed as `openapi/v1.json` with sorted keys, and CI regenerates it and fails on a difference.
- **Serving.** Every install serves `/api/v1/openapi.json` without authentication, and `/docs/api` with `@scalar/api-reference` 1.69.x from a bundle served by the install itself, with web fonts off, a strict CSP and the test-request panel hidden; the page loads nothing from other hosts (S13). 1.69.x is the newest release that was at least 7 days old when it was pinned (T13); later ones come through Renovate after the same age. The CSP is `default-src 'none'`, with scripts only by a nonce fresh on each answer, `connect-src 'self'`, `img-src 'self' data:`, no fonts, and `base-uri`, `form-action` and `frame-ancestors` set to `'none'`; styles are allowed only inline (`style-src 'unsafe-inline'`, no host), because the bundle adds its styles at run time. The catch-all route sends `Deprecation` and `Sunset` from the same metadata.
- **Problem types.** Each row of the error model has its problem type, a URI under `https://tiehall.com/problems/`, the same on every install; where the public-api spec names a type (`setup-required`, `needs-human`, `upgrade-required`), that name ends the URI. Like the packet schema's `$id` (T11), no install fetches these URIs, and they need not resolve.
- **The client.** `@tiehall/client`, generated with openapi-typescript 7 and openapi-fetch, together with the command table the CLI builds its request subcommands from, read from each operation's `x-tiehall-cli` extension; the CLI bundles it (S16).
- **Why.** One source keeps REST, MCP, the CLI, the reference page and the compatibility check in step.
- **Alternatives and fallback.** A hand-written OpenAPI document, which drifts from the code. If `zod-openapi` stalls: `z.toJSONSchema()` plus our own path assembly, or `@asteasolutions/zod-to-openapi`.

#### T11. The packet schema from the same zod source

- **Choice.** The packet is defined once in the catalog; the JSON Schema file and the OpenAPI component are generated from it, and CI checks that they match. The schema is emitted open (input mode). Conformance fixtures exist from the start. The server parses strictly and drops unknown keys.
- **Changed.** Each install serves the schema at `/schemas/packet/v1-beta.json`, without sign-in; its `$id` stays `https://tiehall.com/schemas/packet/v1-beta.json`, which no install fetches and which need not resolve before publication. Only published releases are served from `tiehall.com` (D26). The schema and fixtures live in an Apache-2.0 directory of this repository (S16).
- **Why.** One definition keeps the schema, the API and the MCP tools in step, and fixtures from the start make compatibility testable.
- **Alternatives.** A hand-written JSON Schema kept in step with the zod types by review. Publishing `@tiehall/packet` from the start, which would freeze the model before real use shapes it.

#### T12. oasdiff: pinned, checksum-verified, never on the server

- **Choice.** oasdiff 1.32.x as a checksum-verified binary. Our CI runs `oasdiff breaking --fail-on ERR` on `openapi/v1.json` with `--deprecation-days-beta 14` and `--deprecation-days-stable 180`, with `api-version-not-bumped` raised to ERR, and `oasdiff changelog` feeds the changelog page and the release notes. The contract Action installs the same pinned binary, runs `oasdiff breaking` and `oasdiff changelog --format json`, and calls `npx tiehall@<pinned> contract report` with a GitHub OIDC token whose audience is the install's URL. `tiehall contract diff` runs oasdiff from the developer's PATH and refuses versions below the pinned one.
- **Why.** Private specs never reach the server, a diff process on the server would inherit its secrets, the App needs no Contents permission, and every place runs the same engine.
- **Changed.** The Action takes the install's URL as an input (S15).
- **Alternatives.** `oasdiff/oasdiff-action`, whose defaults fail on nothing, upload specs to a third party, send telemetry and build from a mutable image tag.

#### T13. Releases and publishing

- **Choice.** The CLI, `@tiehall/client` and later `@tiehall/packet` are published only from CI, with npm trusted publishing and provenance; the `tiehall` name and the `@tiehall` scope are reserved with one placeholder publish each. The image is built once per release by digest.
- **Changed.** Everything is built from this public repository. New for self-hosting, as the hosted design planned for this release: each image carries signed build-provenance and SBOM attestations (GitHub artifact attestations), which operators can check with `gh attestation verify`. A release publishes the image digest and version tag, `compose.yaml`, the `Caddyfile`, `.env.example`, the backup scripts and the release notes.
- **Pipeline integrity**, carried from the hosted plan's build rules, which matter more once companies run the public image: the default workflow token is read-only and each job declares only the permissions it needs; every action is pinned to a commit SHA; updates to action pins, dependencies and base images are proposed only after a 7-day minimum release age and never merged automatically; dependencies install from a frozen lockfile, and install scripts run only for an allowlist of packages; the job that builds and pushes the image runs only first-party steps; third-party scanners run in their own job, with read-only package access and no secrets. Base-image updates are proposed weekly, after the same 7-day age. The hosted plan's staging and production release credentials do not exist here.
- **Why.** A company that runs the image trusts our pipeline with its data, and the attestations only prove where an image came from, not that the pipeline was sound.
- **Alternatives.** Publishing from a laptop, which gives no provenance. Automatic dependency merges, which let a compromised release in within hours.

#### T14. One fencing renderer and one outbound fetcher

- **Choice.** One module renders everything agents see: MCP results, `.md` URLs, CLI output and hook output. Every string carries an origin; text Tiehall did not generate is fenced with a nonce per response; closing markers are escaped; invisible characters are stripped; in JSON, user text sits under `untrusted`. Push text, digests and mirror summaries are built only from server text. Loop limits and write budgets are counted in Postgres: each request keeps the times of its agent writes since its last human action, so both the 10-minute window and the 30-write total are checked in the writing transaction, and setting or clearing the flag appends its event in the same transaction.
- **The fetcher** resolves DNS itself, refuses loopback, private, link-local and metadata addresses and redirects to them, and has a CI test. It fetches Client ID Metadata Documents; webhooks later.
- **Changed.** GitHub and Jira calls do not go through the fetcher: GitHub's hosts are fixed, and the Jira site URL must match `https://<name>.atlassian.net` (S8).
- **Why.** One renderer is one place to get fencing right for every surface, and one fetcher is one place to keep outbound fetches away from internal addresses.
- **Alternatives.** Lexical prompt-injection flags, which wait until real data shows injection attempts worth flagging.

#### T15. The requester loop: long-poll plus Claude Code hooks

- **Pull.** `whats_new`, `tiehall updates` and the web inbox's update feed, with acknowledgement cursors.
- **Long-poll.** `GET /api/v1/events/wait` is woken through LISTEN/NOTIFY, whose notifications carry only ids. When the app shuts down, open waits end with 503 and `Retry-After: 0`.
- **The plugin.** A skill in the Agent Skills format, the MCP connection and hooks. `SessionStart` runs `tiehall hook session-start`, which prints a digest made of server text only. `Stop` with `asyncRewake` runs `tiehall hook wait`, a long-poll with a 30-minute cap and a per-session lock, both owned by the CLI; it exits with code 2 when news arrives and is re-armed after every turn.
- **Corrections from the hooks spike, all required.** Claude Code does enforce `timeout` on `asyncRewake` hooks (600 seconds by default), so the hook sets `timeout` above the cap, at 1900 seconds. Announcements need a local "announced" mark per user and install, shared by the SessionStart digest and the waiter; without it the same news is announced again every turn and in every new session. Each wait answer carries `team_key` and `url`. stderr stays clean, because all of it reaches Claude. A launcher in the plugin exits quietly when the CLI is missing. The waiter's lock is freed by the operating system when the process exits, a SessionEnd hook releases it, and an orphaned waiter exits.
- **Changed.** The CLI keeps one saved login per install URL (S15), and the announced mark is kept per user and install. Each wait entry's `team_key` is the request's target team, and the hooks read from the install whose URL the plugin was given.
- **Fallbacks.** The plugin monitor `tiehall watch` if the live wake-up fails its check.
- **The live check: the waiter ships.** On 2026-10-11, run 19.19 checked the live wake-up in Claude Code 2.1.296, the interactive CLI on macOS, with the plugin installed from the repository's marketplace file, against a local install built from `54d4139`; the client-matrix log, `docs/client-matrix/log.md`, holds the record. A question posted on a request the idle session's Claude had opened woke the session once, within a tenth of a second, with the waiter's reminder alone: Tiehall's line and `BE-1 request.message_posted (team BE) http://localhost:3000/BE-1`. The Stop hook was armed again after the woken turn and woke nothing more, and a new session's digest listed nothing already announced. So `asyncRewake` wakes Claude, and the Stop-hook waiter ships as the plugin's push path. `tiehall watch` stays the fallback, run by hand and not registered as a plugin monitor (task 19.20). The run did not check the waiter's cap, nor a wake late in the 30 minutes, which shows that Claude Code keeps the hook's 1900-second timeout; they stay with task 19.19, whose next run makes them, or, if the maintainer checks it off on this run, with the re-run that `findings-from-claude-code-run` plans.
- **Why.** Pull works in every client; the hooks only make Claude Code faster, with no server-side state per session.
- **Alternatives.** A server-sent event stream, which can come with outbound webhooks. Claude Code channels, which come later.

#### T16. The GitHub App and the tracker mirrors

- **Clients.** Octokit for GitHub and plain `fetch` for Jira.
- **Intake.** Webhook mode: verify the signature, store the delivery deduplicated by delivery id, answer 2xx, process in a job; a cron redelivers failed GitHub deliveries. `/webhooks/github` accepts deliveries from the moment the App's credentials are stored, before setup completes, and their jobs run once setup completes (S3). Polling mode (S9) feeds the same processing jobs with the same normalized input.
- **Record of the GitHub App spike (task 1.6, run on 2026-09-28 on a personal account; partly passed).** GitHub's new-App page accepts `default_permissions` `metadata`, `pull_requests`, `issues`, `members` and `emails` (the key is `emails`), keeps all of them, and `GET /app` with an App JWT whose `iss` is the client id reports them. The code converts within seconds; the conversion's `webhook_secret` is `null` for an App without a webhook. GitHub refused the manifest as S4 wrote it: a hook URL on `localhost` "isn't reachable over the public Internet", whether the hook is active or not; `installation` and `installation_repositories` are "unsupported" in `default_events`, because an App receives them without subscribing; and subscribing to any event needs a hook URL. A manifest with no hook and no events was accepted. The installation made right after creation is listed by `GET /app/installations`, and an installation token lists its repositories. An App without a webhook has no delivery log (`GET /app/hook/deliveries` answers 404). Installation tokens are moving to a format of about 520 characters, so no code assumes their length. Still open: the delivery GitHub sends for the installation on a reachable URL, the failed-delivery evidence, what GitHub does with a hook URL on a private network, and the organization-only checks (Members on an organization installation, the `organization` event). The change `github-app-reachability` carries the corrections into the specs.
- **The mirror module is tracker-neutral**, so Linear can reuse it later. Jobs are level-triggered: each reads the request as it is now and is skipped when the pushed hash has not changed; jobs are serialized per mirror; a create writes its link row with a marker before the API call; echoes are dropped; reconciliation runs every 15 minutes; failing jobs go to the dead-letter queue.
- **Jira.** Issue bodies are minimal ADF documents. The Tiehall marker is a label checked in code. Calls use the bot account's API token (S8).
- **Changed.** The App is created per install by the manifest flow (S4), and installations are routed by a table of connected installations instead of a tenant routing table. Jira uses an API token instead of an OAuth app, and there is one Jira site per install. Jira's Personal Data Reporting API is not used; it applies to Atlassian apps, and this is the company's own integration.
- **Why.** Level-triggered, serialized jobs make retries and echoes harmless, and a tracker-neutral module keeps the next tracker cheap.
- **Alternatives.** Edge-triggered jobs that replay each change, which break on retries and out-of-order deliveries. An Atlassian client library for Jira, which adds weight for a handful of endpoints.

#### T17. Testing

- **Kept.** Vitest; Testcontainers Postgres 17; the MCP SDK client for tool contract tests; a few Playwright flows; fence property tests; a canary test that proves message text and credentials never reach the logs; the recurring client matrix on Claude Code, Cursor, Codex and Copilot, which the maintainers run by hand because it needs real client accounts.
- **Browsers.** The Playwright flows use `playwright-core` with the installed Google Chrome (Playwright's `chrome` channel), which GitHub's runners carry, so no test downloads a browser; on a machine without Chrome, `TIEHALL_TEST_CHROME` names another Chromium-based executable.
- **New for self-hosting.**
  - A fresh-install test: the release `compose.yaml` with a `.env` from `init`, through the setup screen, against stubs of GitHub's manifest conversion, user authorization and API.
  - An upgrade test from the previous release's image with seeded data.
  - A backup-and-restore round trip: back up, restore into an empty database, boot, and find the data.
  - Polling-mode tests against GitHub and Jira stubs.
  - An egress test: the install runs in a network where only the stubs are reachable, and any other DNS query or connection attempt fails the test (S13).
  - A license-layout check (S16).
  - The Compose policy check, extended to fail when the app service can read a database owner secret (T4).
- **Dropped.** Virtual authenticators, identity-provider tenants and the cross-tenant suite.
- **Why.** The self-hosting tests cover what an operator does: install, upgrade, back up and restore, run without inbound reachability, and trust the install's outbound traffic.
- **Alternatives.** A one-off client matrix before the first release, which the recurring matrix replaces.

#### Kept as a note: the A2A mapping

The seven states map one to one onto A2A 1.0 task states, for an adapter that comes later (D8): `open` to SUBMITTED, `claimed` to SUBMITTED with `claimedBy` metadata, `in_progress` to WORKING, `needs_info` to INPUT_REQUIRED, `done` to COMPLETED, `declined` to REJECTED and `withdrawn` to CANCELED. No v1 test can check it, so it stays out of the specs.

### Self-hosting decisions

#### S1. One company per install

- **Choice.** An install serves one company. At first start the install has one org row, named on the setup screen, and every membership, team, request and setting belongs to it. There is no tenant layer: no row-level security policies, no per-org routing of integrations, no per-org queue fairness, and no org part in URLs. The data model keeps an `org_id` on every table and composite `(org_id, id)` keys, so a later hosted version, or several orgs per install, can add tenancy through migrations. Requests between companies stay out (D25).
- **Why.** Tenant isolation was the most security-critical code of the hosted plan, and a single-company install does not need it. Keeping the org ids costs little and avoids rewriting every table later.
- **Alternatives.** Keep row-level security with one org, which adds a policy lint and tests that protect nothing in v1. Drop `org_id` entirely, which makes a later multi-org version rewrite every table and key.

#### S2. Install: Compose with Tiehall and Postgres, and one `.env`

- **Choice.**
  - A release publishes `compose.yaml` and `.env.example`. Compose runs stock `postgres:17`, the one-shot `migrate` step and `app` in the `all` role; an optional `caddy` profile adds TLS with automatic certificates.
  - `.env` holds every install setting: `TIEHALL_URL` (the public base URL), `TIEHALL_IMAGE` (pinned by version and digest), the database owner and app passwords, `TIEHALL_SECRET_KEY` (encrypts stored integration secrets), `TIEHALL_AUTH_SECRET` (signs sessions and tokens), the trusted proxies, `TIEHALL_CLIENT_METADATA_FETCH` (`on` by default; `off` stops fetching Client ID Metadata Documents, S13), `TIEHALL_SOURCE_URL` (S16), and the optional SMTP settings (S10). Every secret setting also accepts a `*_FILE` form. An external Postgres 17 or later can replace the bundled one through two connection URLs, one for the owner and one for the app.
  - `docker run --rm <image> init --url https://tiehall.example.com > .env` prints a complete `.env` with fresh random secrets. After that, `docker compose up -d` is the one command that starts the install (D36, read as in Readings to confirm, R1).
  - `TIEHALL_URL` must use HTTPS, except `http://localhost`, with or without a port, for a trial on one machine (Readings to confirm, R5). TLS comes from the Caddy profile or from the operator's own reverse proxy; the app then publishes one port bound to `127.0.0.1` by default, and trusts forwarded headers only from the proxies the `.env` names.
  - Containers keep today's confinement: non-root, read-only root filesystem, memory-backed `/tmp`, all capabilities dropped, `no-new-privileges`. The database publishes no port and accepts no network connection without a password. Only the `migrate` service gets the owner's credentials (T4). The Compose policy check is updated to match.
  - The `caddy` profile and the `Caddyfile` keep their names in the specs on purpose: operators type the profile name and download the file, so both are public artifact names rather than a library choice.
  - Settings that are connections rather than install settings live in the admin UI, stored in the database and encrypted when secret: the GitHub App's credentials (S4), connected installations, the sign-in policy (S5), the Jira connection (S8), team mappings, registered APIs, and the PAT and budget settings.
- **Why.** D36: one file to edit and back up, and no installer to trust.
- **Alternatives.** A script piped from curl, which asks operators to run unreviewed code. An `install` role that writes `compose.yaml`, `.env`, the `Caddyfile` and the scripts into a mounted directory in one `docker run`, which saves the download step but writes files owned by the container's user and still leaves `docker compose up -d` as a second command (Readings to confirm, R1). A single container with Postgres inside, which hides the database from the operator's tools. Secret files only, as the foundation Compose file had; kept as the `*_FILE` option. A Helm chart, later.

#### S3. The first-run setup screen and the setup code

- **Choice.**
  - Until setup is complete, every page redirects to `/setup` and API calls get 503 with the problem type `setup-required`; `/api/v1/openapi.json` and `/docs/api` are no exception. Only `/setup`, `/healthz` and, once the App's credentials are stored, `/webhooks/github` are served; webhook deliveries are verified and stored then, and processed once setup completes, so the delivery for the installation made during setup is not lost (S9).
  - While setup is incomplete, the app prints a one-time setup code to its log at each start (`docker compose logs app`). The code carries at least 128 bits of randomness, so it cannot be guessed, and a wrong code gets 403 (Readings to confirm, R3). Only a hash is stored, and each start replaces the code. Entering it opens a setup session in that browser.
  - The setup screen checks that the browser's origin matches `TIEHALL_URL`, asks for the company's name, creates the GitHub App (S4), sends the operator to install it on their GitHub organization, and has them sign in with GitHub from the setup session. That sign-in is its own way in (S5): the person becomes the first admin, the installations they made are connected, and setup closes for good: the code stops working and `/setup` answers 404.
  - Recovery runs on the host through the image's `admin` role, which connects as the app role (T4): `admin grant <github-login>` makes a member an admin, and `setup reopen` reopens the GitHub App step and prints a new setup code. Both are recorded in the activity log with the command as the cause and no user.
  - **After `setup reopen`**, the install keeps serving members, sessions and tokens with the current App until a new App's credentials are stored. The reopened step closes when a person who is already an admin signs in with GitHub from the setup session; nobody else can close it, and it makes nobody an admin (`admin grant` does that). When a new App replaces the old one, the old App's credentials are deleted and its installations are no longer connected; the installations made during the reopened step are connected. Members, teams, roles, web sessions, agent grants and personal access tokens are unchanged, and members who joined through an organization stay, as S5 defines for an installation that is no longer connected (Readings to confirm, R4).
- **Why.** On a host that is reachable from the internet, an open setup page could be claimed by a stranger. Whoever can read the container log already controls the host.
- **Alternatives.** The first visitor becomes admin, which races on a public host. An admin GitHub login written in `.env`, which adds a step and invites typos. A setup token in `.env`, which is equivalent but one more secret to manage.

#### S4. The GitHub App from the manifest flow

- **Choice.**
  - The setup screen builds a manifest and posts it to GitHub: to the organization's new-App page when the operator names a GitHub organization as the App's owner (recommended), or to their personal page. A `state` value bound to the setup session protects the round trip.
  - The manifest sets the name (by default "Tiehall" plus the company's name, cut to 34 characters; editable, because App names are unique on GitHub), `url`, the two sign-in callback URLs, the sign-in's and the setup screen's, the redirect URL, the webhook URL `TIEHALL_URL/webhooks/github` with its webhook active, `public: false`, and the permissions and events that the tracker-mirrors spec lists (S5 adds Members and Email addresses).
  - GitHub redirects back with a code, which Tiehall exchanges within the hour at `POST /app-manifests/{code}/conversions` for the App id, slug, client id and secret, webhook secret and private key. They are stored encrypted with `TIEHALL_SECRET_KEY`.
  - The App serves sign-in (its user authorization), PR links, close on merge, the Issues mirror, PR-author mapping and organization-membership checks. Tiehall calls GitHub only with the App's own credentials: the App's JWT for the App's own endpoints, an installation token for everything done in an installation, and the App's client id and client secret only to exchange a sign-in's code for its user token; the manifest conversion carries none, and the only user token it sends is that of a sign-in in progress, to read who signed in (D50 (1)).
  - The App is private by default, so it can be installed only on its owner. A company with several GitHub organizations makes it public in GitHub's settings and installs it on each. Tiehall acts only on installations an admin has connected, with the confirmation step; the admin page lists other installations so an admin can connect or ignore them.
  - An admin can upload a new private key after rotating it in GitHub's settings; Tiehall checks it with `GET /app`, under a JWT signed with the new key, before storing it; the check needs no installation (D50 (2)).
  - **One click.** The setup screen's one button builds the manifest and posts it; the rest of the round trip happens on GitHub's own pages, which ask the operator to confirm the App, install it and authorize sign-in. Tiehall cannot skip those pages, so "one click" is read as one click on the setup screen (D37; Readings to confirm, R1).
- **Why.** D37. Each company owns its App, its permissions and its data, and no install depends on an App we run.
- **Alternatives.** One shared Tiehall App run by us, a central dependency against D33. An OAuth App for sign-in plus a separate GitHub App, which means two registrations and an OAuth App's broad scopes. A personal access token for GitHub, which is tied to one person and broad.

#### S5. Who may sign in

- **Choice.**
  - Sign-in is with GitHub only, through the App's user authorization: no passwords, magic links or other providers. A passkey is never a way to sign in.
  - A person may sign in when they are a member of a GitHub organization that has a connected installation, or when they hold a valid invite, or when they are already a member of the install, or when they sign in from the setup session while setup completes (S3). An admin can change the sign-in policy to invited people only. Anyone else is refused with 403 and told to ask an admin for an invite.
  - A new member joins with the role `member`. The person who completes setup is the first admin (S3).
  - Tiehall identifies a GitHub account by its numeric id and follows login renames, so one GitHub account is one Tiehall user.
  - **An admin removal lasts.** When an admin removes a member, Tiehall records a block on that GitHub account id. Membership of a GitHub organization does not admit a blocked account; only an invite that an admin creates after the removal does, and the sign-in that accepts it clears the block. A removal ends the person's web sessions and revokes their agent grants and personal access tokens, so a person who rejoins starts with the invite's role, in no team, with nothing from before (Readings to confirm, R7).
  - **Leaving the GitHub organization ends access.** A member who joined through organization membership is removed when GitHub, through a connected installation that is working, positively reports that the account has left an organization Tiehall has seen it in, and no working connected installation reports it a member of its organization. Tiehall checks at every sign-in, on the `organization` event for a removed member, and in a reconciliation job every 15 minutes. Such a removal records no block, because the company's GitHub organization decides, and rejoining the organization admits the person again. A failed lookup, and an installation that is suspended, deleted or disconnected, never count as leaving: the members who joined through it stay until an admin removes them or a connected installation reports that they left. Members who joined through an invite or by completing setup are not affected, and the install's only admin is not removed this way until another admin exists (Readings to confirm, R8).
  - Invites name a GitHub username, which Tiehall resolves to the account id when the invite form is submitted, before the review page (D50 (12)); the invitee signs in to accept it. Invites need no email. An admin can revoke a pending invite; revoking needs no confirmation step, because it only narrows access (Readings to confirm, R9).
  - The App therefore also asks for the organization Members permission (read), to check membership and receive `organization` events, and the account Email addresses permission (read), for the notification address and the user record.
- **Why.** Companies already manage who is in their GitHub organization. Following it makes the common case need no separate user administration, and makes offboarding in GitHub offboard Tiehall too. Invites cover contractors and people outside the organization.
- **Alternatives.** Invites only, which is more work for admins. Anyone with a GitHub account, which is open to the world on a public host. Admission by GitHub team, which is a later option (Open Questions).

#### S6. Roles: admin and member

- **Choice.** Two roles. Admins hold the rights D28 #4 lists; members hold the rest of what the specs give members. Managing teams also covers each team's intake notes and required fields, and a user's bot flag; admins also revoke pending invites and unregister APIs (Readings to confirm, R9, R10, R11, R19). v1 offers no way to delete a team: a team that is no longer used keeps its key and its requests. An install always keeps at least one admin, and a role change or removal that would leave none is refused with 409. Roles are set in Tiehall and are not taken from GitHub: a GitHub organization owner is not made an admin.
- **Why.** The hosted `owner` role existed for org delete, break-glass and granting ownership, none of which v1 has.
- **Alternatives.** Keeping `owner` with nothing to reserve for it. Making GitHub organization owners admins, which would hand a large organization's owners control of the install without anyone deciding it.

#### S7. Commitments and trust changes are confirmed in the web UI

- **Choice.**
  - Commitments (D23) become proposals, as before. A person confirms them on the proposal's confirm page in the web UI, signed in with their web session. The two-sided rule of D30 is unchanged: two different people, one on each side, each confirm on the page.
  - The same confirmation step guards changes to who may do what: role changes, removals and invites; the sign-in policy; connecting a GitHub installation, uploading an App key, and connecting or changing Jira; registering an API; the PAT switch, the PAT lifetime and the write budget; creating a personal access token; approving an agent client on the consent screen or the device approval page; confirming a fan-out above 10 teams; and exporting the activity log.
  - These actions run only from the web UI. The catalog offers them on no agent surface, so an OAuth token or a personal access token can never run them. The one exception is the operator commands on the host (S3), which run without the web UI because whoever runs them already controls the host.
  - **Mechanics.** A GET renders a review of exactly what will happen, in the server's own words, with other teams' text fenced, and never changes state. The page carries a single-use confirmation nonce of 32 random bytes that expires after 5 minutes and is bound to the user, the session and a digest of the action (T3). For a proposal, the digest covers what the proposal proposes and the request it applies to, and not the confirmations it has received, who holds the claim or when it expires, so a confirmation given after those change still matches. The POST that applies the action must carry that nonce and pass the CSRF check, an `Origin` equal to `TIEHALL_URL` and `Sec-Fetch-Site: same-origin`. Review pages send `frame-ancestors 'none'`. A nonce that is missing, used, expired or bound to another user, session or action gets 403. Because no operation edits a proposal's content (D30 (4)), there is no stale version of a proposal to confirm; a confirmation of a proposal that ended meanwhile gets 409 (Readings to confirm, R12).
  - Rejecting a proposal, and withdrawing one, end it without any effect and need no confirmation step; a rejection in the web UI is still a POST that passes the CSRF, `Origin` and `Sec-Fetch-Site` checks (Readings to confirm, R12).
  - The confirm URL reaches people only through the web inbox, the email when SMTP is set, and URL-mode elicitation. It never appears in a tool result, CLI output or a REST 202 body.
  - Each confirmation gets a receipt in the web inbox (and by email when SMTP is set). A due date, a scope change, a reassignment and a decline can be undone within 15 minutes, with the same step.
  - Confirmations and undos are recorded with the actor kind `web_session`; in v1 no action proves that a person rather than an agent acted.
  - **The documented limit.** An agent that drives the user's own signed-in browser can click confirm. The docs tell users not to give browser-driving agents a browser profile that is signed in to Tiehall. Receipts, the undo window and keeping the confirm URL away from models reduce the risk; they do not remove it.
  - **Passkeys later.** A later change can require a WebAuthn assertion, bound to the same digest, on the same POSTs. The review pages, the nonce binding, the two-sided rule and the receipts stay as they are.
- **Why.** D35 keeps two-sided human confirmation in v1 without passkeys. This keeps every property of the passkey design except proof that a person was present, so passkeys can be added without changing the rules.
- **Alternatives.** Passkeys now: enrollment, recovery and admin resets are a large part of v1 for an option D35 moved later. A fresh GitHub re-authentication: GitHub often completes it with no prompt, so it proves nothing more. No confirmation for trust changes: an agent holding a token could then change roles.

#### S8. Jira Cloud through a bot account's API token

- **Choice.**
  - An admin connects one Jira Cloud site per install in the admin UI: the site URL, which must be `https://<name>.atlassian.net`, the email address of a dedicated bot account, its API token, and the token's expiry date. Tiehall checks them with one call before storing them, encrypts the token with `TIEHALL_SECRET_KEY`, and never shows it again.
  - Every Jira call uses the bot's token. What Tiehall can do in Jira is what the company's Jira admin grants the bot: browse the mapped projects, create issues, add comments, edit labels and apply the mapped transitions.
  - Admins are reminded 14 and 3 days before the recorded expiry, and see a banner when Jira answers 401 or 403.
  - **Webhooks.** When the install is reachable, a Jira admin adds a webhook in Jira's settings with the URL Tiehall shows, which contains a random secret path segment, filtered to the mapped projects. Where Jira sends a signature, Tiehall checks it. Either way Tiehall treats a Jira webhook as a hint: it reads the issue again with the bot's token before recording anything, so a forged call changes nothing.
  - **Linking a Jira account.** A user picks their own Atlassian account from a search the bot runs, and can unlink it. One Atlassian account links to at most one Tiehall user; admins can see and remove links. A link only lets a tracker "Done" by that account become a done proposal, which the linked user must still confirm, and only for a team that turned that setting on. A wrong link grants nothing the linked user could not already propose, so linking needs no confirmation step; linking, unlinking and an admin's removal of a link are still security events, because a link decides whose tracker "Done" becomes a proposal (S14).
  - **Changing the site.** While any team maps a Jira project, changing the connection's site URL is refused with 409; an admin removes those mappings first (Readings to confirm, R20).
- **Why.** There is no Atlassian OAuth app to register, no public callback to host, and no connection tied to one person's refresh token. A bot account is how many companies already connect tools to Jira.
- **Alternatives.** An Atlassian OAuth 2.0 (3LO) app per install, which each company would register in Atlassian's developer console. Forge or Connect apps, which need an Atlassian-hosted runtime or a listing. Matching Jira users by email, which Jira often hides.

#### S9. Webhooks when reachable, polling otherwise

- **Choice.**
  - GitHub and Jira each run in webhook mode or polling mode. After the first installation, Tiehall reads the App's webhook delivery log through GitHub's API: a failed delivery marks the install as not reachable, and GitHub runs in polling mode. Only deliveries made after the App's credentials were stored count, because `/webhooks/github` accepts deliveries from then on, before setup completes (S3); the delivery for the installation made during setup is the first that counts (Readings to confirm, R6). Jira runs in webhook mode once a webhook has delivered a test event, and in polling mode otherwise. An admin can switch either mode.
  - In polling mode the worker polls every 60 seconds. On GitHub it reads the PRs linked to open requests, the PRs in covered repositories updated since the last poll (for key mentions and provider PRs), and the mirror issues, using conditional requests so unchanged answers do not use the rate limit. On Jira it runs `project in (…) AND updated >= -2m`. Changes are picked up within 2 minutes.
  - The 15-minute reconciliation runs in both modes, and GitHub redelivery runs in webhook mode. Both modes feed the same processing jobs.
  - The contract Action runs in the provider's CI and must reach the install: GitHub-hosted runners need an install reachable from the internet, and otherwise the workflow runs on a self-hosted runner inside the network. The Action fails open either way.
- **Why.** Many installs sit inside a company network that GitHub and Atlassian cannot reach, and they should still work.
- **Alternatives.** Requiring public reachability, which excludes internal installs. A relay run by us, a central dependency against D33. Asking the operator on the setup screen whether GitHub can reach the install, which operators often cannot tell; kept only as the admin's manual switch.

#### S10. Email is optional, through SMTP

- **Choice.** SMTP settings in `.env`: host, port, TLS mode, user, password and from address. With them, Tiehall sends every email the specs name: proposal notices, receipts, question notices, the daily digest, WARN digests, re-confirmation requests, PAT and Jira-token reminders, and admin alerts. Without them, Tiehall sends no email: notices stay in the web inbox and admin banners, and nothing in v1 needs email to work, since invites use GitHub accounts. The address is the GitHub account's primary verified email. The admin page shows whether email is set up and can send a test message. Email subjects carry only server text.
- **Why.** Most companies have an SMTP relay; many trial installs do not.
- **Alternatives.** An email API vendor, which is another dependency. Required email, which blocks trials.

#### S11. Backups

- **Choice.**
  - A release ships `backup.sh` and `restore.sh` next to `compose.yaml`. `backup.sh` runs `pg_dump` inside the Postgres container and writes a timestamped custom-format dump, readable only by its owner, into a backups directory; then it records the time of the finished backup in the database. `restore.sh <file>` stops the app, restores the dump into the database and starts the app again, whose `migrate` step brings an older dump up to the running release.
  - The admin page shows when the last backup finished and warns when none has run, or none in the last 7 days.
  - The docs tell operators to run the backup daily (with a cron example) and before every upgrade, to copy dumps off the host, and to back up `.env` separately and keep it secret: a dump alone cannot use the stored integration secrets, because `TIEHALL_SECRET_KEY` is not in it.
  - Operators who need point-in-time recovery use their own Postgres tooling, or a managed Postgres through the connection URLs.
  - CI runs a backup-and-restore round trip (T17).
- **Why.** Running `pg_dump` in the Postgres container always matches the server's major version, and one dump file is easy to understand and move.
- **Alternatives.** Managed backups run by us, a service. WAL archiving in the default install, too much for small teams. `pg_dump` in the Tiehall image, which would need a matching client inside it.

#### S12. Upgrades

- **Choice.**
  - The operator backs up, sets the new `TIEHALL_IMAGE` in `.env`, and runs `docker compose pull && docker compose up -d`. The `migrate` step runs every pending migration before the app starts; if it fails, the app does not start on the new image and the log says why.
  - `migrate` refuses to run an image that is older than the database's schema can serve, meaning an image from before a release whose contract step has run on this database, with a clear message. Before any contract step has run, the previous image still starts, which is what makes the rollback below work.
  - Migrations expand, then contract: a release only adds, and contract steps ship at least one release later and are flagged in the release notes. Going back to the previous image works until a contract step has run; after that, the way back is the backup taken before the upgrade.
  - Releases use semantic versions. Skipping releases works, because migrations run in order; the release notes name any release that must not be skipped, and CI tests upgrades from the previous release.
  - An upgrade restarts the one container. Open waits end with 503 and `Retry-After: 0`, and the clients retry.
  - The admin page shows the running version; operators follow the release feed. The web UI links to the source of the running version (S16).
- **Why.** D36, with a rollback path that operators can understand.
- **Alternatives.** An in-app updater, which needs the Docker socket and a call home. Down-migrations, which are unsafe with real data.

#### S13. No telemetry and no calls home

- **Choice.** An install sends nothing to us: no usage statistics, no update check, no error-reporting service and no license check. Framework telemetry is off at build and run time. The only outbound connections are to GitHub (its API and web), the configured Jira site, the SMTP server when set, and the Client ID Metadata Documents of agent clients that connect, fetched through the guarded fetcher. An operator can switch metadata-document fetching off with `TIEHALL_CLIENT_METADATA_FETCH=off` in `.env`, which leaves Dynamic Client Registration. The docs list these hosts for egress rules. The API reference page and the web UI load nothing from other hosts. Logs are JSON on stdout with ids, never message text and never credentials: no tokens, secrets, `Authorization` or cookie headers, and no query strings; the setup code is the one secret the log shows, by design (S3). `/healthz` answers only "up" or "down". The egress test (T17) enforces this.
- **Why.** An install runs inside a company's network with its data, and unexpected outbound traffic is a reason not to adopt it. It also means v1 has no usage counts, which is why the packet publication and API graduation tests are adapted.
- **Alternatives.** Opt-in anonymous usage counts: possible later, off by default, and only through a new decision. An update check: operators can follow releases instead.

#### S14. The activity log: plain and append-only

- **Choice.**
  - The event log (T5) is also the activity log, with domain events and security events.
  - Security events cover: sign-ins and refused sign-ins, including the sign-in that clears an admin removal's block; role changes, removals (by an admin, with the block it records, or by leaving the GitHub organization), invites and invite revocations; the sign-in policy; agent-client approvals and grant revocations; personal access tokens created and revoked; integrations connected, changed and disconnected, and App keys uploaded; Atlassian accounts linked and unlinked, and an admin's removal of a link; API registrations and unregistrations; fan-out confirmations; the PAT and budget settings; operator commands, which name the command and no user; activity-log exports; `reconciled` events; and the completion of setup.
  - Team changes (creating and renaming teams, who belongs to them, intake settings), team mappings and the bot flag are not security events in v1 (Readings to confirm, R21).
  - The app's database role may only insert and read events, and a trigger refuses updates and deletes, so neither a bug nor a compromised app can rewrite history. This holds only because the app never gets the owner's credentials (T4).
  - Each night, Tiehall compares the current members, roles and agent-client grants with the security events and appends a `reconciled` security event for each difference, which catches an event lost between a write the sign-in service owns and its event (T8).
  - The IP address and user agent of each security event sit in a side table and are removed after 90 days. The admin view shows them next to the event while they are kept; the export leaves them out (Readings to confirm, R21).
  - Admins view the log in the web UI, filtered by time, actor, request and event type, and export it as JSONL with the confirmation step; the export is itself a security event. Only admins see security events. Members see requests' domain events through the request pages and the loop.
  - The docs state what the log does not prove: whoever holds the database owner role or the host can change it. A tamper-evident chain with outside anchoring is a later addition (D35).
- **Why.** Admins need a record of who did what. Evidence against the database's own operator matters most when a vendor runs the database, which v1 does not do.
- **Alternatives.** The hash chain now, which D35 moves later. No activity log, which leaves admins unable to answer who changed a role.

#### S15. URLs on the install's own host

- **Choice.**
  - A request's URL is `https://<install>/<KEY>`, for example `https://tiehall.example.com/FE-142`, with `.md` and `.json` variants. A team's intake page is `https://<install>/<TEAM>`, for example `/FE`.
  - Team keys are 2 to 10 characters of uppercase letters and digits and start with a letter. Every app path is lowercase (`/api/v1`, `/mcp`, `/docs/api`, `/confirm/…`, `/setup`, `/webhooks/…`, `/schemas/…`, `/.well-known/…`), so a key never shadows an app path.
  - Clients learn the install's URL once: `tiehall login <url>`, the plugin's MCP connection, and the contract Action's input. The CLI keeps one saved login per install URL. With one saved login, every command uses it; with several, a command names its install with `--install <url>`, a full request URL picks the install by its origin, the hooks use the install the plugin was given, and a command that cannot tell which install is meant refuses and lists the saved installs (Readings to confirm, R18). `get_request` and `tiehall get` accept a full URL only when its origin is the install's own.
  - Moving an install to a new host means changing `TIEHALL_URL` and the GitHub App's URLs; old links stop working unless the operator redirects them.
- **Why.** With one company per install there is no org part to put in the path.
- **Alternatives.** A prefix such as `/r/FE-142`, which is safe but less readable. Keeping `/<org>/<KEY>` for a later multi-org version, which can add an org part then and redirect.

#### S16. The license layout

- **Choice.** The repository's root license is AGPL-3.0. These directories are Apache-2.0, each with its own `LICENSE` file and a matching `license` field, and they are exactly the five client pieces of D34: `packages/cli`, `packages/client`, `packages/claude-plugin` (with its skill), `actions/contract`, and the packet schema directory with its fixtures, from which `@tiehall/packet` is built. `packages/catalog` and every other package are AGPL-3.0. A CI check fails when a package's license does not match this map, and a dependency rule stops an Apache-2.0 package from importing an AGPL-3.0 package. So the CLI does not import the catalog: its request subcommands come from the OpenAPI document, where each operation offered on the CLI carries an `x-tiehall-cli` extension, through `@tiehall/client` (T3, T10; Readings to confirm, R2). The web UI's footer and the admin page show the running version with a link to its source; an operator who runs a modified server sets `TIEHALL_SOURCE_URL` to their own source.
- **Why.** D34, and the AGPL's rule that network users of a modified server are offered its source. The line is drawn at D34's list, so no server code moves to Apache-2.0 without a decision; a license, once published, cannot be taken back.
- **Alternatives.** Separate repositories per license, which the public monorepo no longer needs. Putting the catalog, or its public definitions, under Apache-2.0 so the CLI can import it, which moves server code out of the AGPL.

### Where the specs leave room

- **Fallbacks behind a fixed contract:** `z.toJSONSchema()` in place of `zod-openapi`; the plugin monitor in place of the `asyncRewake` waiter; personal access tokens for clients that fail OAuth interop.
- **How the plugin reaches the install's MCP endpoint:** environment-variable expansion in the plugin's MCP configuration, or a `tiehall` command that registers the server with Claude Code, whichever passes its check (Open Questions). Either way the user gives the URL once.
- **Internal names:** tables, packages, queue names and cron timings no spec names. Command ids are public `operationId`s.
- **The expected revision off REST:** how `propose` and `attach_contract_changes` carry the revision they expect, as long as a stale or missing value is refused the same way as on REST.
- **Two API versions** (settled by task 22.4, before `contract.report` became the first `stable` operation). One catalog definition describes its operation's current shape, at a path under the major version the operation now lives in, such as `/api/v2/…`, and keeps an earlier shape for each earlier major version that still serves it: that version's method and path, input and output schemas, stability level, deprecation and CLI commands, with two functions, one that carries an input of the earlier shape to the current shape and one that carries the current output back. The handler runs only the current shape: `execute()` parses a call made in an earlier shape with that shape's input schema, refusing input that fails it as any other, carries it to the current shape, and returns the output carried back only when it passes the earlier output schema. The REST route answers the paths of every major version, so `/api/v1` keeps answering as before while `/api/v2` answers the new shape. Each major version has its own document, generated from the shapes it serves, committed as `openapi/vN.json`, checked for drift like `openapi/v1.json` and served at `/api/vN/openapi.json`. Moving an operation to `/api/v2` leaves the `/api/v1` document byte for byte what it was, since that document is generated from the earlier shape; the only change it then gets is the earlier shape's deprecation under the notice rules, which marks the operation deprecated and adds its `x-sunset` date, never earlier than six months after the release that adds `/api/v2`. When the first operation moves, the compatibility check compares each major version's document on its own; the operation's MCP tool serves its current shape under a new tool name while the earlier shape keeps the old name for at least six months; and the CLI keeps calling the major version whose document it was built from until a CLI release moves it. An operation with `If-Match` or an `ETag` takes no earlier shape until one needs it, which then settles how those headers carry over.
- **Polling details:** which GitHub and Jira endpoints the poller uses, within the 2-minute bound and the rate limits.
- **The admin UI's layout.**

## Risks / Trade-offs

- [An agent that drives the user's signed-in browser can click confirm, and can post a web message that clears `needs_human`] → The confirm URL never reaches a model through Tiehall; review pages show the server's own words; receipts and the undo window; the docs name the limit and the browser-profile advice; passkeys can be added to the same POSTs later.
- [The activity log is not tamper-evident: the database owner or the host can change it] → Append-only grants and a trigger stop the app itself from rewriting it; the docs say so plainly; the hash chain is a later addition.
- [Operators skip backups] → Shipped scripts, a daily cron example, an admin-page warning after 7 days without a backup, and the upgrade docs that start with a backup.
- [An upgrade past a contract step cannot be rolled back by switching images] → Contract steps ship a release after their expand step and are flagged in the release notes; the pre-upgrade backup is the way back; CI tests upgrades.
- [The install is not reachable from GitHub, Atlassian or GitHub-hosted runners] → Polling mode for GitHub and Jira; self-hosted runners for the Action; the Action fails open; the docs say what each setup gives.
- [A stranger claims an install that is reachable from the internet before its operator does] → The setup code from the container log; setup closes after the first admin signs in.
- [The GitHub App's credentials leak or the App is deleted] → Credentials are encrypted with a key that is not in the database or its dumps; admins can upload a rotated private key; `setup reopen` recreates the App.
- [A Jira bot token expires or loses access] → Expiry reminders, a banner on 401 or 403, and reconciliation after reconnecting.
- [Forged Jira webhooks] → A secret path segment, a signature check where Jira sends one, and a re-read of the issue with the bot's token before anything is recorded.
- [Better Auth is built from credentials that exist only after setup, and its defaults are weaker than we need] → The auth instance is built at start and rebuilt on change; pinned versions; the route test; a test for each setting the specs rely on; the spike corrections in T7 and T9.
- [Everyone in a large GitHub organization can sign in] → They join as members only; the sign-in policy can require invites; leaving the organization ends access; an admin removal blocks rejoining through the organization.
- [A GitHub outage, a suspended installation or a disconnect looks like everyone left the organization] → Only a positive report from a working, connected installation removes anyone; failures and disconnects keep members.
- [A claimant who is also on the requester side cannot get a second confirmation for their own scope change] → The proposal waits until it ends; they can withdraw it, release the claim and change the request while it is unclaimed (D30 (4)).
- [Version skew between CLIs, Actions and installs on different releases] → The CLI sends its version and the server keeps a minimum; `contract.report` is stable with its own floor; deprecation windows are enforced in CI; the CLI can read an install's OpenAPI document to see what it offers.
- [Agent clients reject an install's TLS certificate from an internal CA] → The docs recommend a publicly trusted certificate, and explain how to add a company CA to Node-based clients.
- [Client ID Metadata Documents need outbound internet access] → Operators can switch fetching off and rely on DCR; the client matrix covers both.
- [The AGPL makes some legal teams hesitate] → The client pieces that customers embed or run in CI are Apache-2.0; the license map is enforced in CI; the source link is shown in the app.
- [Without telemetry we cannot see adoption, so the packet publication and API graduation tests rely on reports and maintainers' judgment] → Both tests are written down and recorded in the changelog.
- [Prompt injection between teams is reduced, not removed] → Fencing, ids-only push, commitments that need a person, cross-team commitments that need a person on each side, and the loop limit.
- [The server trusts the diff the provider's CI computed] → The OIDC claims and the engine version are recorded, and reports are bound to the registered repository.
- [Push relies on Claude Code hook behavior that is new and partly undocumented] → Pull is the contract and push is never required; the monitor fallback.

## Migration Plan

This is the first release. There is no earlier Tiehall install, and no data, user or integration to migrate; every spec in this change is ADDED.

**Relation to earlier work.**
- The hosted-service change `add-tiehall-beta` is set aside (D33) and kept out of the public repository (D38). Its finished foundation tasks carry over; the task list of this change, written after these specs, marks which of them carry over and which are dropped.
- Dropped from the foundation: the SaaS Compose overlay and its test, and the hosting, backup-provider and monitoring work.
- Changed: the Compose file moves to `.env` with `*_FILE` fallbacks and a loopback-bound app port, and its policy check follows; the image gains the `init` and `admin` roles.

**Installing (operator steps, as the docs will show them).**
1. Download `compose.yaml`, the `Caddyfile` and the backup scripts from a release.
2. Run `docker run --rm <image> init --url https://tiehall.example.com > .env`, review it, and add SMTP settings if wanted.
3. Run `docker compose up -d`, or `docker compose --profile caddy up -d` for TLS through Caddy.
4. Read the setup code from `docker compose logs app`, open the URL and enter it.
5. Create the GitHub App, install it on the GitHub organization, and sign in; that person becomes the first admin.
6. Create teams, invite people or let the organization's members sign in, connect Jira and map teams, register APIs, and schedule the daily backup.

**Upgrading.** Back up; set the new `TIEHALL_IMAGE`; run `docker compose pull && docker compose up -d`; check `/healthz` and the version on the admin page.

**Rollback.** Before a flagged contract step, set the previous image and run `docker compose up -d`. After one, restore the pre-upgrade backup with the previous image.

**Our release process.** A version tag builds the image once, by digest, with provenance and SBOM attestations; CI runs the fresh-install, upgrade, backup-and-restore, polling and egress tests; the release publishes the image, the Compose file, `.env.example`, the scripts, the notes and the API changelog. npm packages are published from CI with provenance once the npm names are reserved.

**Public contracts after a release.** Breaking API changes are never rolled back: they go through the deprecation path, and the `api-breaking` label is only for urgent security fixes.

## Open Questions

Each of these can be answered later without changing the specs, the approach or the task breakdown.

- **Real-client checks,** done by hand on the maintainers' own accounts:
  - the client matrix on Claude Code, Cursor, Codex and Copilot: sign-in with metadata documents and with DCR, on both protocol versions, and how many tools each client shows. The fallback for a failing client is DCR or a personal access token;
  - URL-mode elicitation in real clients. The fallback is the inbox, plus email when SMTP is set;
  - the live `asyncRewake` wake-up in a real Claude Code session. The fallback is `tiehall watch`. Passed in run 19.19 on 2026-10-11, so the waiter ships (T15).
- **Foundation checks for self-hosting,** each with a named fallback:
  - Better Auth's GitHub provider with a GitHub App's user authorization, built from credentials stored at run time. Fallback: Better Auth's generic OAuth plugin with GitHub's endpoints. Passed in spike 1.5; its corrections are in T7;
  - the manifest details: the Email addresses and Members permissions in `default_permissions`, and which delivery GitHub sends for the installation made during setup, which the reachability check reads (S9). Fallback: an admin sets the mode by hand. The permissions passed in spike 1.6 (T16); the delivery questions and GitHub's answer to a hook URL on a private network are still open;
  - whether Jira Cloud admin webhooks send a signature for a secret, and whether registering one through the API needs Jira admin rights for the bot. Fallback: the admin adds the webhook in Jira's settings, and Tiehall relies on the secret URL and the re-read;
  - whether Atlassian's scoped API tokens work against the site URL, or need Atlassian's API gateway URL. Fallback: classic API tokens;
  - how the Claude Code plugin's MCP connection points at an install URL (environment-variable expansion in the plugin, or a registration command). Fallback: the documented `claude mcp add --transport http tiehall <url>/mcp`.
- **The Codex SessionStart snippet** ships only after it passes testing.
- **Erasure.** Whether a v1.x release adds an admin action that erases a departed person's personal data, or leaves that to operators at the database level.
- **Rotating `TIEHALL_SECRET_KEY`.** Stored secrets carry a key id (T4), but v1 defines no rotation procedure; until one exists, an operator who must change the key reconnects the GitHub App key and Jira after changing it. A later release can add a previous-key setting and a re-encryption command.
- **Admission by GitHub team,** as a finer sign-in policy than organization membership.
- **GitHub Enterprise Server and GitHub Enterprise Cloud with data residency.**
- **Separate `web` and `worker` containers** for zero-downtime upgrades, if operators ask for them.

## Readings to confirm with the founder

No decision restated here, and nothing in the hosted design, settles the points below. The specs apply the narrowest reading of each, and each can change in review without changing the approach.

- **R1. "One command" and "one click"** (D36, D37; S2, S4). Reading: the one command is `docker compose up -d` once the release files are downloaded and `.env` is written with `init`; the one click is the setup screen's button that starts GitHub's manifest flow, after which GitHub's own pages ask to confirm, install and authorize. The alternative that comes closer to D36 is an `install` role that writes every file in one `docker run` (S2, Alternatives). Specs: self-host-install.
- **R2. The license line for the CLI** (D34; S16, T3). Reading: the command catalog stays AGPL-3.0 server code, and the Apache-2.0 CLI takes its request subcommands from the OpenAPI document's `x-tiehall-cli` extensions through `@tiehall/client`. Specs: public-api.
- **R3. The setup code and what runs before setup** (S3). Reading: the code carries at least 128 bits of randomness and a wrong code gets 403; before setup only `/setup`, `/healthz` and, once the App exists, `/webhooks/github` are served, so `/api/v1/openapi.json` answers 503 `setup-required` and `/docs/api` leads to `/setup`. Specs: self-host-install.
- **R4. `setup reopen`** (S3). Reading: the install keeps serving with the current App until a new App's credentials are stored; only a person who is already an admin can close the reopened step, and it makes nobody an admin; a new App's installations replace the old App's; members, sessions and tokens are unchanged. Specs: self-host-install, sign-in.
- **R5. Trial URLs** (S2). Reading: `http://localhost` is accepted with or without a port, `http://127.0.0.1` is not. Specs: self-host-install.
- **R6. Webhook reachability** (S9). Reading: only deliveries made after the App's credentials were stored count, and deliveries that arrive before setup completes are stored and processed once it does. Specs: self-host-install, tracker-mirrors.
- **R7. An admin removal lasts** (S5). Reading: an admin removal blocks the GitHub account from rejoining through organization membership until an admin invites it again; leaving the organization records no block; a removal revokes the person's agent grants and personal access tokens, which answer 403 while the person is not a member and 401 after they rejoin; a returning member starts with the invite's role and in no team. Specs: sign-in, teams-and-roles, activity-log.
- **R8. Leaving the organization needs a positive report** (S5). Reading: only a working, connected installation's report that the account left an organization Tiehall saw it in removes a member; failed lookups, suspended, deleted and disconnected installations never do, so a disconnect needs no confirmation step; the install's only admin is not removed until another admin exists, and the first admin, who joined through setup, is treated like an invited member. Specs: sign-in, tracker-mirrors.
- **R9. Invites** (D28 #1, #5; S5, S6). Reading: a GitHub username that names no account is refused with 404, as a record that does not exist; so is a login that names a GitHub organization; an invite for a member gets 409, as does an invite while no installation is connected; a new invite for an account with a pending invite revokes and replaces it; revoking an accepted invite gets 409, and revoking a revoked one changes nothing (D50 (11)); an admin can revoke a pending invite without the confirmation step, as a security event; v1 has no way to delete a team. Specs: teams-and-roles, public-api.
- **R10. Intake settings** (D28 #4, #26; S6). Reading: admins set a team's intake notes and required fields in the web UI; a team may require the acceptance criteria, code refs, links or a due date; required fields apply to requests people and agents open, not to requests a contract report opens; intake notes are user text and are fenced for agents. Specs: agent-surfaces, teams-and-roles.
- **R11. The bot flag** (D28 #94). Reading: with no seat counting, the flag's only effect is that the web UI and `whoami` show the user as a bot. Specs: teams-and-roles.
- **R12. Confirmations and rejections** (D30 (4); S7). Reading: a proposal's confirmation digest covers what it proposes and the request it applies to, not its confirmations, claimant or expiry; the hosted rule that voided confirmations when the confirm page changed has no trigger and is dropped; rejecting and withdrawing need no confirmation step. Specs: agent-safety, requests, public-api.
- **R13. The retry state outlives the proposal by a day** (D30 (4); T9). Reading: a `requestState` stays valid 8 days, so a retry after the proposal expired returns "expired" instead of 403. Specs: agent-surfaces.
- **R14. The requesting team and who may post** (D28 #3, #11). Reading: a user in several teams who names none is refused with 400 and told which teams to pick from; a user in no team cannot open a request (403); only the requester side and the target team's members may post comments, questions and answers on a request (403 for others). Specs: requests, agent-surfaces.
- **R15. Limits** (D28 #49, #51, #52). Reading: the per-token limit counts writes within any 60-second window; the daily budget runs per UTC day; a counted flip is a round trip from `in_progress` to `needs_info` and back whose blocking question was posted with the actor kind `agent`, whoever answers it, counted on the UTC day the question was posted, and a blocking question on an `open` or `claimed` request is no flip; past 10 consumer teams, the first 10 are those whose declarations of the API are oldest, then by team key. Specs: agent-safety.
- **R16. Email details** (D28 #61, #62). Reading: a question the requester side posts on an unclaimed request emails nobody right away; the daily digest goes out once per UTC day, after the day it covers ends; each member opts in to a requesting team's emails per team in their email settings, off by default; "the team" in hook output, wait entries and email subjects is the request's target team. Specs: requester-loop, agent-safety.
- **R17. Request URLs without credentials** (D28 #66; S15). Reading: a request that negotiates HTML, which is the default and covers `Accept: */*`, is sent to sign-in; one that negotiates markdown or JSON gets 401. Specs: agent-surfaces.
- **R18. Several saved logins in the CLI** (S15). Reading: `--install <url>` picks the install; a request URL picks it by origin; the hooks use the plugin's install; a command that cannot tell refuses and lists the saved installs. Specs: agent-surfaces.
- **R19. Contract changes** (D14, D15, D28 #76). Reading: registering an API is refused with 409 unless a connected installation covers its repository; an admin can unregister an API without the confirmation step, as a security event, and its requests stay; any member of a consuming team can remove the team's declaration; reports for a change set are merged over a 2-minute window that starts with the first report of a burst; with the fail-on-breaking input set, the Action still fails the check for breaking changes when the install is unreachable, because that failure comes from the diff, not from Tiehall. Specs: contract-changes.
- **R20. Jira and mirror jobs** (D28 #83; S8). Reading: changing the Jira site URL while a team maps a Jira project is refused with 409; a failing mirror job's fifth attempt comes 50 to 70 minutes after its first. Specs: tracker-mirrors.
- **R21. The activity log** (D28 #9; S14). Reading: team changes, team mappings, intake settings and the bot flag are not security events in v1, though recording them would help admins answer who changed a team; the admin view shows a security event's IP address and user agent while they are kept, and the export leaves them out. Specs: activity-log.
- **R22. The beta packet schema** (D28 #22; Design rules: Handoff packet). Reading: each install serves `/schemas/packet/v1-beta.json` without sign-in, because it holds no data of the install; a breaking packet change "takes effect" when a release first contains it, so no release contains it until 14 days after its changelog notice. Specs: handoff-packet.

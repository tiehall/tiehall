# Design: Decisions from groups 15 to 28

## Context

[proposal.md](proposal.md) says why the notes of the main change's groups 15 to 28 need a change of their own. This document restates the decision the deltas rest on, D55, and each of its eighty-six items as a public rule with its reason and the alternatives that lost, numbered so that the maintainer can approve each one or change it. It then says how the items are built, which texts of earlier changes they correct, and what stays open. It cites nothing outside this repository.

**Where the items come from.** The main change's groups 15 (agent access), 16 (MCP), 17 (the CLI, the client and the plugin), 18 (the web app, request URLs and intake pages), 19 (the requester loop), 20 (the activity log), 21 (operator commands, backups and the install docs), 22 to 24 (contract changes, close on merge and the GitHub Issues mirror), 26 (hardening and the security review) and 28 (licenses and public docs) were built with two verifiers and a fixer each, and `image-os-security-updates` beside them. Those builders, verifiers and fixers left notes for the maintainer wherever the code had to choose something the specs did not say, said differently, or said in a way the code could not keep. Each item below settles one note, by the default the note recommended unless the item says where it narrows it, and names the note by its label in brackets.

**Current state.** Built and pushed: groups 15, 16, 18, 20 and 22, and groups 17, 19, 21, 23, 24, 26 and 28 except their tasks that wait for the maintainer's own accounts, for group 25 (Jira) or for the release; `github-layer-hardening`, `image-os-security-updates`, `init-image-flag`, `request-body-limit` and `spec-catch-up`; and the in-spec hardening that D55 has built directly. Not built: group 25 (Jira), group 27 (the client matrix), groups 29 and 30 (the release pipeline, publication and going public), and anything in this change.

**How the specs cite this document.** Every `Source:` line in `specs/*/spec.md` keeps the decision numbers its requirement cited before this change, adds the items of D55 it rests on, such as `D55 (12)`, and names the sections of this document: `design.md, Decisions this change rests on`, where D55 and its items are, and `design.md, Rules carried from earlier changes`, which says where the unchanged parts of each requirement keep their sources.

**Constraints.**
- A MODIFIED requirement repeats its heading exactly and keeps every scenario it had. Where `spec-catch-up`, `github-app-reachability`, `request-body-limit`, `github-layer-hardening` or `image-os-security-updates` already modify or add a requirement, this change starts from their text, the latest one where several do.
- Nothing new calls a model, and nothing new calls a service outside the documented list of outbound connections; item (57) only names in that list a host the install already calls.
- Every public contract that changes, an `/api/v1` operation, an MCP tool or the packet schema, changes through the paths the public-api and handoff-packet capabilities define; items (37), (47) and (50) use the path item (47) states for breaks before the first release, and items (63) and (83) the packet's own path before publication.
- D55 has the maintainer approve this change before any of it is built; until then the code keeps the readings the items describe as built.

## Goals / Non-Goals

**Goals:**
- Every note the builders, verifiers and fixers of groups 15 to 28 left for the maintainer is settled in one place, with its reason and its alternatives.
- The specs say what the built code does where the item keeps it, and where an item changes the code, the tasks change it, tests first.
- Each rule is concrete enough to test, and each task names the tests that cover it or writes them.

**Non-Goals:**
- Hardening that stays inside what the specs already say. D55 has it built directly, outside this change.
- The Jira half of any rule (group 25), the client matrix (group 27), and publishing anything (groups 29 and 30), beyond the cases an item adds to them.
- New settings in `.env` for any number named here (Open Questions).
- The notes of group 25 and later groups, which a later triage settles.

## Decisions

### Decisions this change rests on

- **D55. The notes of groups 15 to 28 are settled like D50, and the maintainer's own decisions wait.** Taken by the maintainer on 2026-10-03. As public rules:
  - The technical notes that the builders, verifiers and fixers of the main change's groups 15 to 28 left for the maintainer are triaged as D50 triaged the GitHub layer's: hardening that stays inside what the specs already say is built directly.
  - Every point that would change a spec rule, or add one, goes into this one change, `decisions-from-groups-15-28`, which states each point with its rationale and alternatives and ends with a numbered list to approve. The change is written now and not built, and nobody is asked about it now.
  - The maintainer reviews that list later, together with the other steps that wait for them: the Jira site, the real-client checks, npm and making the repository public.
  - **Why.** The notes are many and small, and each has a clear default; deciding them one at a time would stall the remaining work for no better result. Keeping the spec-changing ones in one change keeps the specs the contract: nothing in it is built before it is approved, and once it is built nothing the code does differs from them.
  - **Alternatives that lost.** *Asking about each note now:* eighty-six questions for points that each have a clear default. *Building the recommended defaults at once, specs after:* the code would run ahead of the contract the maintainer approves. *One change per capability:* thirteen changes, several of which would modify the same requirements, such as the error model, and each other's text.

Each item below states its rule, why it wins, the alternatives that lost, and whether the spec catches up with the code, the code and the spec change, or only a text changes. An item whose rule the code already follows also says where the code and its tests are. Its label in brackets names the note it settles.

#### Errors and request bodies

- **D55 (1). A media range with quality 0 does not ask for HTML** [ERR-01]. *The code and the spec change.*
  - **Rule.** On the page routes that `github-layer-hardening`'s D50 (7) names, other than request URLs and intake pages, a request asks for HTML only when its `Accept` header names `text/html` in a media range whose quality is above 0. A range such as `text/html;q=0` says that HTML is not acceptable (RFC 9110, section 12.4.2), so that request gets the RFC 9457 problem, not the page. Request URLs and intake pages keep their own negotiation, which already weighs qualities.
  - **Why.** The spec's "names `text/html`" was meant as "asks for HTML"; a client that names HTML only to refuse it should not get a page, and the request URLs' negotiation already reads the header this way.
  - **Alternatives.** *Any range that names `text/html`, as built (`namesHtml` in `packages/commands/src/html.ts`):* gives a page to a client that refused one. *Full negotiation by quality on every page route:* more rules for routes that browsers alone ask for pages; the one case that matters is quality 0.
- **D55 (2). A browser's form over the body limit gets a page** [ERR-02]. *The spec catches up.*
  - **Rule.** The public-api scenario "A web form over the limit" says what the code does: a browser, whose `Accept` header names `text/html`, gets the 413 as the refusal page, and any other caller gets the RFC 9457 problem with the problem type `payload-too-large`.
  - **Why.** D50 (7)'s exception sentence covers scenarios in other capabilities, but this scenario is in the same requirement set and names the problem outright, so it contradicted the code.
  - **Alternatives.** *Leaving the scenario to the exception sentence:* the scenario's own words still say the opposite.
  - **Code.** `apps/server/src/request-guard.ts` answers through the refusal renderer of `packages/commands/src/html.ts`; tested in `apps/server/test/web-role.test.ts`.
- **D55 (3). `github-layer-hardening`'s T5 names every user of the refusal renderer** [ERR-06]. *Text only.*
  - **Rule.** T5's list of the modules that answer refusals through the renderer gains `apps/server/src/request-guard.ts`, which answers a body over its limit, and `packages/commands/src/page-routes.ts`, which decides which routes are page routes.
  - **Why.** The design is the source of truth and must name what the code uses.
  - **Alternatives.** *Leaving T5 as it is:* a reader looking for every page refusal would miss two.
- **D55 (4). `request-body-limit` names only the Jira webhook as open** [ERR-07]. *Text only.*
  - **Rule.** The sentences in `request-body-limit`'s Goals and Non-Goals that call "the webhook paths" and "webhook deliveries" an open question name only the Jira webhook, because D50 (19) settled `/webhooks/github` at 25 MiB.
  - **Why.** D50 (16) corrected that change's R1, Risks and Open Questions but left these two sentences.
  - **Alternatives.** *Leaving them:* the change would contradict itself.
- **D55 (5). Request bodies being read at once are capped per process** [ERR-08]. *The code and the spec change.*
  - **Rule.** One web process holds at most 64 MiB (67,108,864 bytes) of request bodies being received at once, across every route that reads a body before it knows who calls: `/api/v1`, `/mcp`, `/webhooks/github`, the web UI's forms and the sign-in service's routes. A body counts its bytes as they arrive, whether its request declares its length or sends it in chunks, so a request that declares a length and sends nothing holds none of the cap. A request whose body's bytes, as they arrive, would take the bytes in flight past the cap is answered at once with 503, the new problem type `busy` and `Retry-After: 5`, and its body is read no further; it runs nothing, changes nothing and appends no event. A body over its own limit still gets 413 first, because waiting would not help it, and a request that declares a length over its limit gets it before any byte of its body is read; `busy` comes before every other refusal, as 413 does. A body's bytes are released when it has been read, refused or abandoned, or when the web server's request timeout ends its call. On `/mcp`, `busy` is an HTTP status, not a tool error. A GitHub delivery refused this way is a failed delivery, which redelivery asks GitHub for again. That a declared body counts its bytes as they arrive, and not its declared length from when its head arrives, is the maintainer's answer of 2026-10-12 to the question that building this item raised (Risks).
  - **Why.** Bodies are read before authentication, up to 25 MiB for a GitHub delivery, 16 MiB for `contract.report` and 2 MiB elsewhere, and nothing caps how many are read at once; parsing a 16 MiB report takes about 300 MiB of heap, so a few callers at once can exhaust the web role's memory (the security review of 2026-10-03, D-2). 64 MiB holds the largest delivery twice with room for ordinary calls, and stays well below the app's 2 GiB memory limit of item (55). Counting the bytes that have arrived, of every body, means the cap counts only memory that a body takes, and a client that would hold the cap has to send its bytes.
  - **Alternatives.** *No cap, as built:* memory is bounded only by the number of connections. *A cap on the number of requests:* bounds nothing when each body is large. *A cap per client address:* GitHub delivers from a few addresses, and an attacker uses many. *Lower body limits:* would refuse deliveries GitHub may send. *Leaving it to the reverse proxy:* the proxy is optional, and Caddy's default sets no such cap. *Reserving a declared length when its head arrives, as first built:* a client that sends a head and then nothing holds its reservation until the web server's 300-second request timeout, so three connections that declare 25, 25 and 14 MiB to `/webhooks/github` and send nothing get every other body 503 `busy` for as long as they reconnect. *A deadline for a declared body to arrive:* such a client only reconnects sooner. *A lowest rate at which a body must keep arriving:* one more number, which a slow honest client may fall under.
  - **Code.** `apps/server/src/request-guard.ts`, with the counter in `packages/commands/src/body-limit.ts`; tested in `apps/server/test/web-role.test.ts` and `request-guard.test.ts`.
- **D55 (6). A webhook removed on GitHub moves GitHub to polling** [GH-03]. *The code and the spec change.*
  - **Rule.** While GitHub runs in webhook mode and a webhook secret is stored, a 404 from GitHub for the App's delivery log means that GitHub holds no webhook for the App any more, as when someone removed it in the App's settings. Tiehall then moves GitHub to polling mode, records a `github.mode_changed` security event that names no user, with the new cause `webhook_removed`, and shows the banner about GitHub's webhook and emails the admins once, as for a given-up delivery (D50 (15)). It does so whoever last set the mode, because no delivery can arrive while GitHub holds no webhook. The banner clears as D50 (15)'s does: when an admin next switches GitHub's mode, or when a delivery that reaches the install afterwards is verified. A 404 stays "no failed delivery", changing nothing and alerting no one, only while no webhook secret is stored, as for an App created without a webhook.
  - **Why.** D50 (15) exists because a webhook that breaks after the first check silently loses changes, and with them close on merge; a removed webhook is the clearest such break, and today it reads as "nothing failed" for ever. An admin's switch to webhook mode is kept by D50 (15) so that Tiehall does not undo an admin who is fixing a failing webhook; with no webhook at all there is nothing to wait for, and the admin switches back with one click once it is restored.
  - **Alternatives.** *A 404 as no failure, as built:* changes are lost until someone notices. *A banner without the switch:* changes are lost until an admin acts. *Keeping an admin's switch to webhook mode, as D50 (15) does for a given-up delivery:* nothing can arrive, so the install would poll nothing and miss everything. *Reading the App's webhook configuration instead:* one more call each run, while the delivery log is read every 10 minutes already.
- **D55 (7). GitHub failing the membership look-up at sign-in is 502** [GH-04]. *The code and the spec change.*
  - **Rule.** When a person could be admitted only through membership of an organization with a connected installation, and a membership look-up through a working installation fails, with an error GitHub gives no answer of its own for or with no answer within 10 seconds, while no other look-up reports the account a member, the sign-in is answered 502 with the problem type `integration-unavailable` and a detail that says GitHub could not be reached and to try again. It admits no one, creates no session, user or membership, and records no `sign_in.refused` event; Tiehall logs a warning. A browser gets it as the refusal page, with a link back to the sign-in page (D50 (7)). A look-up through a suspended or deleted installation still admits no one, and when nothing else admits the person the sign-in is refused with 403 as before.
  - **Why.** D50 (3) made an unavailable GitHub a 502 everywhere else; a 403 that tells a member-to-be to ask for an invite when GitHub was down misleads them, and fills the activity log with refusals that no rule made.
  - **Alternatives.** *403 and a refusal event, as the spec said:* wrong advice and a false record. *503:* says that Tiehall itself is down. *502 with a refusal event:* the event would name a refusal that did not happen.

#### GitHub texts

- **D55 (8). `github-layer-hardening`'s T8 names every column its migration adds** [GH-05]. *Text only.*
  - **Rule.** T8 and that change's Migration Plan name `github_redeliveries.given_up_at` beside `github_app.webhook_given_up_at` and `mode_set_by`, as the migration adds all three.
  - **Why.** The design must match the migration that was built.
  - **Alternatives.** *Leaving it:* the column has no design text.
- **D55 (9). Task 21.10's banners have the audience 24.11 gives** [GH-06]. *Text only.*
  - **Rule.** The main change's task 21.10 says that the admin page's integration state shows to admins, and that each banner shows to the audience D28 #83, D50 (15) and task 24.11 give it: the admins and the members of each team whose mirrors go through the integration, and no one else.
  - **Why.** "To admins only" contradicted D50 (15) and 24.11, which the code follows.
  - **Alternatives.** *Leaving 21.10's words:* the plan would contradict the spec.

#### Agent access

- **D55 (10). Approvals and revocations record their events in the same transaction** [AUTH-01]. *The spec catches up, and texts are corrected.*
  - **Rule.** The commands that Tiehall runs in place of the sign-in service's routes, approving an agent client on the consent screen or the CLI on the device approval page and revoking a grant, write the grant or the revocation and its security event in one transaction. Only writes that the sign-in service still makes itself, such as the web session a sign-in stores, record their event right after the write, which the nightly reconciliation backs up. The main change's tasks 15.10 and 20.3 and its T8 say so instead of "through after-hooks".
  - **Why.** One transaction is stronger than an after-hook: no stop between the write and its event can lose the event.
  - **Alternatives.** *After-hooks, as T8 planned:* an event can be lost until the night's reconciliation.
  - **Code.** `packages/commands/src/agent-grants.ts`; tested in `packages/commands/test/agent-client-approval.test.ts`, `device-approval.test.ts` and `agent-grant-revocation.test.ts`.
- **D55 (11). A token check reads the signing keys in the same process** [AUTH-02]. *Text only.*
  - **Rule.** Checking an access token reads the install's public signing keys from its own store in the same process, with no HTTP call at all, not even to the install's own JWKS endpoint. The main change's T9 and task 15.2 say so instead of "an internal `jwksUrl`".
  - **Why.** No call is stronger than an internal call, and it is what the agent-access rule that a token check makes no outbound call asks for.
  - **Alternatives.** *An internal `jwksUrl`, as T9 planned:* a call to the install itself, which fails when the install cannot reach its own URL.
  - **Code.** `packages/commands/src/agent-tokens.ts`.
- **D55 (12). `offline_access` is accepted and ignored** [AUTH-04]. *The code and the spec change.*
  - **Rule.** An authorization request whose `scope` names `offline_access` is not refused for it: Tiehall ignores it. It is never listed in `scopes_supported`, never shown on the consent screen and never among a token's scopes, and every grant still gets a refresh token whether or not the client asked for one. Any other scope Tiehall does not offer is still refused with `invalid_scope`.
  - **Why.** Clients built for OpenID-style servers ask for `offline_access` to get refresh tokens; refusing them turns real MCP clients away for a scope whose effect Tiehall gives every grant anyway.
  - **Alternatives.** *`invalid_scope`, as built:* turns such clients away. *Listing it in `scopes_supported`:* it would read as a fourth scope, against "exactly three".
- **D55 (13). A request that names no scope gets read and write** [AUTH-05]. *The spec catches up.*
  - **Rule.** An authorization request that names no scope, or only `offline_access` (item (12)), is granted `requests:read` and `requests:write`, which the consent screen shows before the person approves. `contracts:report` is never granted unless the request names it.
  - **Why.** RFC 6749 lets a server define a default; a client that names no scope needs to read and write requests to be of any use, while attaching contract diffs is a narrower use that a client should ask for.
  - **Alternatives.** *Refusing a request with no scope:* turns away clients that rely on the server's default. *All three scopes by default:* grants attaching diffs to a client that never asked.
  - **Code.** `DEFAULT_SCOPES` in `packages/commands/src/authorization-server.ts`; tested in `packages/commands/test/oauth-scopes.test.ts`.
- **D55 (14). The authorization server's endpoints have rate limits** [AUTH-06]. *The spec catches up.*
  - **Rule.** From one client address, the token endpoint takes at most 20 calls in any minute besides the CLI's polls, the authorization endpoint 30 and the revocation endpoint 30; the CLI's polls of the token endpoint with its device code have a limit of their own, 60 from one address in any minute, whatever device codes they carry. Each limit counts the calls it took from the address in the past minute, so calls older than a minute never count, however steadily the address calls. The next call over a limit gets 429 with the problem type `rate-limited` and a `Retry-After` header, changes nothing and is not counted. A token call is one of the CLI's polls only when its body is a form, sent with the media type `application/x-www-form-urlencoded` exactly, parameters aside, that names the device code grant and the client id `tiehall-cli`, each once; a body the token endpoint reads as JSON is never a poll, whatever text it holds. Registration keeps its own limit of 10 an hour (agent-access), and the sign-in callback its 100 calls in 10 seconds (D50 (20)), counted over the past 10 seconds the same way. The client address is the one the web role's request guard yields.
  - **Why.** These endpoints take calls before any user is known; the limits are far above what a client needs, which refreshes its token about every 10 minutes, and their numbers are the sign-in library's own, kept on in every environment as D50 (20) keeps the callback's. Tiehall counts them itself, over the past minute: the library lets the number of calls in a row from one address through, in a run that ends only once a minute passes without one, so an address whose clients refresh their tokens once every 50 seconds between them, fewer than 2 calls a minute, would be refused at its 21st call; on an install on one machine, as a trial URL's is, or behind an office's NAT, every client there comes from one address. The CLI's polls are the exception: `tiehall login` polls every 5 seconds for as long as its code waits, up to 10 minutes, 12 polls a minute, so two sign-ins at once from one address would pass the 20, and so would one beside more than 8 other token calls from there in that minute. 60 lets five sign-ins at once from one address finish, and codes no one was issued cannot be tried without a limit, each a read of the database. Only an exact form is a poll because the token endpoint takes a media type that merely contains a form's and reads one that names JSON first, or ends in `+json`, as JSON: a body whose text held a poll's fields could otherwise carry a refresh token or an authorization code past the limit.
  - **Alternatives.** *The library's runs, as first built:* an address whose clients make fewer than 2 token calls a minute between them is refused at its 21st call, and a login that waits more than about 100 seconds for its approval fails at its 21st poll. *Counting the CLI's polls toward the 20:* two sign-ins at once from one address fail. *No limit on the CLI's polls:* device codes could be tried from one address without a limit. *Leaving every call that names the device code grant out of the 20, whatever its client:* any client could try codes past the limit.
  - **Code.** The rate limit of `packages/commands/src/sign-in.ts`, which keeps the library's limits on in every environment, counts each over the past window in `packages/commands/src/rolling-limits.ts` and leaves the CLI's polls out of the token endpoint's, and the limit on the CLI's polls in `packages/commands/src/device-flow.ts`; `packages/commands/test/device-flow.test.ts` tests the CLI's polls past the token endpoint's limit, their own limit, the 21st other token call within a minute, a JSON body that holds a poll's fields included, a call once the first of the 20 is a minute old, and an address that calls once every 50 seconds; `packages/commands/test/sign-in.test.ts` tests the callback's 10 seconds the same way. No test names the authorization and revocation endpoints' limits yet, and task 1.3 writes them.
- **D55 (15). A registration of only local redirect URIs is a native client's** [AUTH-07]. *The spec catches up.*
  - **Rule.** A Dynamic Client Registration that names no `application_type` and whose every redirect URI is an `http` URI on `localhost`, `127.0.0.1` or `[::1]`, or a URI with a native app's private scheme (a scheme that holds a dot, such as `com.example.app:`), is taken as a native public client's (RFC 8252), so its loopback redirect URIs are accepted. Any other registration keeps the type it names, or the web type.
  - **Why.** The sign-in library refuses loopback redirect URIs for a web client, and native MCP clients often register without naming a type; their redirect URIs show what they are.
  - **Alternatives.** *Requiring `application_type: native`:* turns real clients away. *Accepting loopback URIs for every client:* RFC 8252 reserves them for native apps.
  - **Code.** `packages/commands/src/agent-clients.ts`; tested in `packages/commands/test/client-registrations.test.ts`.
- **D55 (16). Every registration attempt counts toward the limit** [AUTH-08]. *The spec catches up.*
  - **Rule.** Each registration request that reaches the registration endpoint counts toward the 10 an hour of its address, including one refused for its metadata, such as a redirect URI the server does not take, a NUL character or a field over its bound (item (25)).
  - **Why.** Counting only successes would let a prober try metadata without limit.
  - **Alternatives.** *Counting only issued client ids:* unlimited probing.
  - **Code.** `packages/commands/src/agent-clients.ts`; the limit is tested in `apps/server/test/client-registration-limit.test.ts`, and task 1.4 writes the test of a refused registration that counts.
- **D55 (17). `/api/v1` shares the `/mcp` resource** [AUTH-11]. *The spec catches up.*
  - **Rule.** The install has one protected resource, `TIEHALL_URL/mcp`, whose metadata is served at `/.well-known/oauth-protected-resource/mcp`. A 401 challenge from `/api/v1` points to that same metadata, and a token whose audience is that resource is accepted on both endpoints.
  - **Why.** One access token serves both endpoints (the main change's Design rules: Agent access); two resources would need two tokens.
  - **Alternatives.** *A second resource for `/api/v1`, with its own metadata:* a client would have to sign in twice.
  - **Code.** `packages/commands/src/agent-tokens.ts` and `rest.ts`; the challenge of `/mcp` is tested in `packages/commands/test/mcp-route.test.ts`, and task 1.5 writes the one of `/api/v1`.
- **D55 (18). A personal access token's label is bounded** [AUTH-13]. *The spec catches up, and the code tightens.*
  - **Rule.** Each personal access token carries a label its owner writes, of 1 to 100 characters with no control character; a label outside these bounds gets 400 and creates no token. The label is the owner's own text: pages show it quoted and escaped, and no reminder, in the web inbox or by email, ever names it.
  - **Why.** Every text a person writes is bounded, as D45 (2) records the others; a control character can garble a page or a terminal, and the label is not server text, so it stays out of notices.
  - **Alternatives.** *Only a NUL character refused, as built:* other control characters pass. *No label:* owners could not tell their tokens apart.
- **D55 (19). No personal access token is created while the switch is off** [AUTH-14]. *The code and the spec change.*
  - **Rule.** While an admin has switched personal access tokens off, creating one is refused with 403 and the problem type `personal-access-tokens-off`, and creates nothing; the Connected agents and tokens page then offers no form to create one and says that an admin has switched them off.
  - **Why.** The switch should mean "no personal access tokens here"; a token created while it is off works for nothing until the day an admin turns the switch on, when it starts working without that admin knowing it exists.
  - **Alternatives.** *Creating it with a warning, as built:* a dormant credential waits for the switch.
- **D55 (20). How the reminders of personal access tokens are timed** [AUTH-15]. *The spec catches up.*
  - **Rule.** Reminders fall on UTC days: 14 days and 3 days before the UTC day the token expires. A reminder whose day has come and that the token has not had yet is made at the reminder job's next run, so a stopped worker catches up. A token created after a reminder's day gets no such reminder. Only a token whose owner is a member is reminded. A reminder stays in its owner's standing list until the token expires or is revoked.
  - **Why.** The install has no time zone per user, and a reminder missed while the worker was down should still come.
  - **Alternatives.** *Local days:* v1 keeps no time zone per user. *Skipping a missed reminder:* a stopped worker would silently drop it. *Reminding about a token created inside its window:* its owner has just chosen its expiry.
  - **Code.** `packages/commands/src/personal-access-token-reminders.ts`; tested in `packages/commands/test/personal-access-token-reminders.test.ts`.
- **D55 (21). Each member has one grant for the CLI** [AUTH-18]. *The spec catches up, and the page says so.*
  - **Rule.** Every `tiehall login` a member approves, on any machine, updates that member's one grant for the CLI. Revoking it on the Connected agents and tokens page signs the CLI out on every machine: the refresh tokens stop at once and the access tokens within 10 minutes. The page says so beside the CLI's grant.
  - **Why.** Grants are kept one per client and member, and the CLI has one fixed client id; a person revoking the CLI should know that it is all of their machines.
  - **Alternatives.** *A grant per machine:* needs a machine name the person types and a list to manage, which can come later.
  - **Code.** `packages/commands/src/agent-grants.ts`; tested in `packages/commands/test/device-approval.test.ts` and `agent-grant-revocation.test.ts`.
- **D55 (22). The CLI approval's review page and typed codes** [AUTH-19]. *The spec catches up.*
  - **Rule.** The review page of the CLI's approval is reached only from the device approval page: a request for that review page's own URL, input included, is sent to the device approval page, which asks for the code. A code typed there is taken in lower or upper case, with or without its dash, and with any spaces removed.
  - **Why.** The approval page must not be prefilled from a link, and a review page reachable with its input in a link would be exactly that; forgiving typing helps people without weakening the rule.
  - **Alternatives.** *Serving the review page from its own URL:* a link could carry the code. *Taking only the exact form:* people retype codes for no gain.
  - **Code.** `packages/commands/src/device-approval.ts`; tested in `packages/commands/test/device-approval.test.ts`.
- **D55 (23). A missing `resource` means the install's one resource** [AUTH-21]. *The code and the spec change.*
  - **Rule.** An authorization request, and the token request that follows it, that carries no `resource` parameter is taken as naming `TIEHALL_URL/mcp`, so the access token's audience is that resource and both `/mcp` and `/api/v1` accept it. The device flow already defaults to it.
  - **Why.** Today such a request yields an opaque token that `/api/v1` refuses with 401: a sign-in that seems to work and fails at the first call.
  - **Alternatives.** *Refusing a request without `resource`:* turns away clients that predate resource indicators, though the install has one resource to give them. *The opaque token, as built:* the failure shows up only later.
- **D55 (24). An IPv6 client is counted by its /64 for registrations** [AUTH-23]. *The code and the spec change.*
  - **Rule.** The registration limit counts an IPv4 client by its address and an IPv6 client by its /64 prefix, so every address in one /64 shares the 10 registrations an hour.
  - **Why.** One host commonly holds a whole /64, so counting each address apart leaves such a client effectively unlimited.
  - **Alternatives.** *Each address apart, as built:* no limit for IPv6. *A /48:* would count a whole site, and its many people, as one client.
- **D55 (25). An agent client's metadata is bounded** [AUTH-24]. *The code and the spec change.*
  - **Rule.** A `client_id` that is a metadata document's URL has at most 1,024 characters; a client's name has 1 to 100 characters; a client has at most 10 redirect URIs of at most 2,048 characters each. A registration outside a bound is refused with 400 and the OAuth error `invalid_client_metadata`, and counts toward the limit (item (16)); an authorization request whose `client_id` URL is too long, or whose document breaks a bound, is refused with `invalid_client`. Neither is ever answered with a 500.
  - **Why.** Registration took a name of 100,000 characters, and a long `client_id` failed later writes with 500 on the database's own bounds (the bound of a token's write record of 2,200 characters, a read cursor's reader of 2,048, and the idempotency index).
  - **Alternatives.** *Cutting long values:* stores a name the client did not send. *Raising the database bounds:* still unbounded input.

#### MCP

- **D55 (26). `/mcp` refuses a foreign `Origin`** [MCP-01]. *The code and the spec change.*
  - **Rule.** A request to `/mcp` whose `Origin` header is present and is not the install's own origin (the scheme, host and port of `TIEHALL_URL`) is refused with 403 and the problem type `forbidden`, as an HTTP status, before its token is checked and before any tool runs. A request with no `Origin` header, as MCP clients outside a browser send, is not refused for it.
  - **Why.** MCP's transport rules ask servers to check `Origin` against DNS rebinding; bearer-only authentication keeps the risk low (the security review of 2026-10-03, D-1), and the check costs nothing.
  - **Alternatives.** *No check, as built:* departs from the transport rules. *A list of allowed origins:* no browser client of `/mcp` exists to allow.
- **D55 (27). A page of `get_request` counts both of its forms** [MCP-02]. *The spec catches up.*
  - **Rule.** The 32,000 characters that cap a page of `get_request` count the fenced markdown and the structured content of the result together, so each holds about half, some 15,000 characters of request text a page.
  - **Why.** Clients' limits on tool output count the whole result; counting one form alone would let a page pass the 10,000 tokens at which Claude Code warns.
  - **Alternatives.** *Counting the markdown alone:* the result can double past the cap.
  - **Code.** `packages/commands/src/request-pages.ts`; tested in `packages/commands/test/mcp-get-request.test.ts`.
- **D55 (28). `list_inbox` lists what is not finished by default** [MCP-03]. *The code and the spec change.*
  - **Rule.** `list_inbox`, its REST operation and `tiehall inbox` return by default the requests addressed to the caller's teams that are not in a terminal state (`done`, `declined` or `withdrawn`), newest first, 20 a call and at most 50; the `state` filter asks for one state, a terminal one included.
  - **Why.** An inbox is what waits for someone; finished requests push the open ones off the page.
  - **Alternatives.** *Every state, as built:* the newest 20 can all be finished. *A separate flag for finished requests:* the `state` filter already reaches them.
- **D55 (29). A tool that moves a read cursor is not read-only** [MCP-05]. *The spec catches up.*
  - **Rule.** `whats_new`, which acknowledges updates when asked and so moves a read cursor, carries no read-only hint; the hint goes only on tools that change nothing, read cursors included.
  - **Why.** A client may run a read-only tool without asking; an acknowledgement changes what every later read returns.
  - **Alternatives.** *The hint, because the tool reads unless asked to acknowledge:* a client could acknowledge without its person seeing it.
  - **Code.** `packages/commands/src/mcp.ts`; tested in `packages/commands/test/mcp-tools.test.ts`.
- **D55 (30). Any removal from a stable operation or tool fails CI** [MCP-07]. *The code and the spec change.*
  - **Rule.** For an operation at `stable` and its MCP tool, the compatibility checks fail on a finding that removes something even when the diff engine rates it a warning, such as an optional input property or a property of the response, on REST (`check:api-compat`) and on MCP (`check:tool-compat`) alike; operations at `beta` keep failing on error-level findings. A breaking change to a stable tool ships under a new tool name, which the main change's task 29.15 checks.
  - **Why.** The public-api capability says a stable tool "SHALL only gain things"; `contract.report` is stable from the start, and pinned Actions call it.
  - **Alternatives.** *Error-level findings only, as built:* a stable tool can lose an optional argument with no failure.
- **D55 (31). A request state is bound to the call that made the proposal** [MCP-08]. *The spec catches up.*
  - **Rule.** Besides the user, the client and the proposal, a `requestState` is bound to the tool and the arguments of the call that created the proposal; a retry with the same state and other arguments is refused with 403, like a foreign state.
  - **Why.** A state replayed with other arguments would answer a call with the outcome of a proposal that call did not make.
  - **Alternatives.** *Binding to the proposal alone:* the wrong outcome reaches the agent as if it were its own.
  - **Code.** `packages/commands/src/mcp-elicitation.ts`; tested in `packages/commands/test/mcp-elicitation.test.ts`.
- **D55 (32). A removed member's MCP connection still lists tools** [MCP-11]. *The spec catches up.*
  - **Rule.** With a token that has not expired, a removed member's `initialize` and `tools/list` still answer, because they return nothing of the install's data, and every tool call returns the removed member's tool error.
  - **Why.** The tool error tells the agent why it can do nothing; refusing the protocol's own calls would show only a broken connection.
  - **Alternatives.** *HTTP 403 for every request of a removed member:* clients show a connection failure with no reason.
  - **Code.** `packages/commands/src/mcp.ts`; tested in `packages/commands/test/mcp-route.test.ts`.
- **D55 (33). Removal is checked before a request state** [MCP-12]. *The spec catches up.*
  - **Rule.** A removed member's retry with a request state that would be refused gets the removed member's refusal, on `/mcp` the tool error, and not 403 with `request-state-refused`.
  - **Why.** The removal is checked before anything else, so a removed member learns nothing more, not even whether a state is valid.
  - **Alternatives.** *The request state first:* tells a removed member whether a state holds.
  - **Code.** `packages/commands/src/mcp.ts`; tested in `packages/commands/test/mcp-elicitation.test.ts`.

#### The CLI

- **D55 (34). Every CLI command calls a public REST operation** [CLI-02]. *The spec catches up.*
  - **Rule.** Each CLI command that calls the install calls a public `/api/v1` operation at `beta`, or at `stable` for `contract report`. The operations built for the CLI and its pages stay public at `beta`: `GET /api/v1/inbox`, `GET /api/v1/requests/{request}/pages`, `POST /api/v1/proposals`, `GET /api/v1/whoami`, which now names the user's teams, and `GET /api/v1/teams/{key}`. The web UI's lists of the requests a user opened (`requests.list_opened`) and of a request's proposals (`proposals.list`) stay internal commands that no agent surface offers.
  - **Why.** The CLI calls the REST API and is built from its document, so each command needs a public operation; the two web reads have no agent use yet, and making them public would hold them to the notice rules for nothing.
  - **Alternatives.** *Internal commands for the CLI:* the CLI cannot call them. *Making the two web reads public too:* contracts nobody asked for.
  - **Code.** `packages/catalog/src/requests.ts`, `request-pages.ts`, `propose.ts`, `directory.ts` and `proposals.ts`; `openapi/v1.json`; tested in `packages/commands/test/cli-requests.test.ts` and `packages/catalog/test/openapi.test.ts`.
- **D55 (35). The CLI's version is checked on `/api/v1`** [CLI-05]. *The spec catches up.*
  - **Rule.** The minimum CLI version is checked on calls to `/api/v1`. `tiehall login` goes through the authorization server's device flow, which does not check it, so a CLI older than the minimum can sign in and is told to upgrade at its first command.
  - **Why.** The device flow is the OAuth server's own protocol, whose errors are OAuth's; the first command after sign-in says what to do.
  - **Alternatives.** *Checking on the device flow:* OAuth endpoints would answer with Tiehall's own problem type.
  - **Code.** `packages/commands/src/rest.ts`; tested in `packages/commands/test/cli-version.test.ts`.
- **D55 (36). Terminal control characters are stripped from the agent view and the CLI's output** [CLI-06]. *The code and the spec change.*
  - **Rule.** Besides the invisible characters D28 #53 lists, every string in the agent view and in the CLI's output, in markdown and in JSON, loses the C0 control characters except tab (U+0009) and line feed (U+000A), DEL (U+007F) and the C1 control characters (U+0080 to U+009F). So escape sequences, carriage returns and operating-system commands such as OSC 52, from text Tiehall did not generate, never reach a terminal or a model. The stored text is unchanged, and the web UI escapes it as before.
  - **Why.** Such characters stay inside the fence but can move the cursor, overwrite the fence on screen or write the clipboard of the terminal that shows the CLI's output.
  - **Alternatives.** *Showing them escaped, such as `\x1b`:* keeps a trace, but every reader must handle the escape. *Stripping in the CLI alone:* MCP results reach terminals through clients too.
- **D55 (37). Withdrawing a proposal over REST answers 200** [CLI-07]. *The code and the spec change.*
  - **Rule.** `POST /api/v1/proposals` with the kind `withdraw_proposal` makes no commitment, so it answers 200 with the ended proposal, as `{ "proposal": … }`, and the 200 answer of `proposals.propose` allows that body; a commitment proposed through the same operation still answers 202. The MCP tool's answer does not change. The change is made before the first release, on the path item (47) states.
  - **Why.** A 202 says that the call waits for people to confirm it; a withdrawal takes effect at once.
  - **Alternatives.** *202, as built:* tells the client to wait for a confirmation that never comes. *A separate withdrawal operation:* one more endpoint for one kind.

#### Request URLs and intake pages

- **D55 (38). A token that negotiates HTML gets markdown** [URL-01]. *The code and the spec change.*
  - **Rule.** A request to a request URL or an intake page that carries an `Authorization` header and negotiates HTML, by naming `text/html`, by sending `*/*` or by sending no `Accept` header, gets the markdown representation. HTML goes only to a request without an `Authorization` header, which is served with a web session or, without one, sent to sign-in as before.
  - **Why.** A caller that sends a token is a program, such as `curl` or an agent's fetch tool, which cannot use a sign-in page; today it gets a 303 to one.
  - **Alternatives.** *The redirect to sign-in, as built:* the program gets nothing it can read. *406:* refuses a call that a representation Tiehall serves can answer.
- **D55 (39). Intake notes are capped, and `directory` is paged** [URL-04]. *The code and the spec change.*
  - **Rule.** A team's intake notes have at most 4,000 characters; an admin's longer text is refused with 400 and changes nothing. `directory` answers in pages, ordered by team key and then by API name: a page holds at most 50 teams and at most 50 registered APIs, never more than the 32,000 characters that cap a page of `get_request`, and names a cursor for the next page while more remain.
  - **Why.** Notes of up to 20,000 characters, listed for every team at once, pass what MCP clients take as tool output. The page's character cap makes the bound hold whatever the notes hold; it narrows the note's recommendation of 50 teams a page, which alone would still allow 200,000 characters.
  - **Alternatives.** *20,000 characters and one page, as built:* a large install's directory cannot be read. *Omitting the notes from `directory`:* an agent would need one more call per team to learn how to file.
- **D55 (40). Intake pages under an old key, and their 401** [URL-07]. *The spec catches up.*
  - **Rule.** An intake page asked for under a team's earlier key answers 307 to the page under its current key. A request without credentials that negotiates markdown or JSON from an intake page gets 401 with a body that tells the agent to use the MCP tool `directory`.
  - **Why.** A renamed key stays an alias of its team (the main change's Design rules: Teams and roles), and a 401 should name what works for a team, which is `directory`, not `get_request`.
  - **Alternatives.** *404 for an old key:* breaks links to a renamed team. *The request URLs' 401 text:* names a tool that reads requests.
  - **Code.** `packages/commands/src/request-urls.ts`; tested in `packages/commands/test/intake-pages.test.ts`.
- **D55 (41). A team's required fields hold on reassignment and on revisions** [URL-08]. *The code and the spec change.*
  - **Rule.** A team's required fields are checked when a request is opened to it, when a reassignment into it is proposed, and when a packet revision is added to, or proposed for, a request addressed to it. A reassignment proposal into a team whose required fields the current packet lacks, and a revision that drops a required field the current revision has, are refused with 400, listing the missing fields, and create nothing. An empty list, such as no acceptance criteria, counts as missing. Requests a contract report opened, and the revisions a report adds, stay exempt.
  - **Why.** Today a team's requirement can be bypassed by opening a request to another team and reassigning it, and a later revision can drop a field the team requires.
  - **Alternatives.** *Checking only at opening, as built:* both bypasses stay. *Checking at the reassignment's confirmation:* a person would confirm a commitment that then fails. *Refusing every revision of a request opened before the team added a requirement:* blocks old requests for a rule they predate.
- **D55 (42). Request URLs: methods and encoded paths** [URL-11]. *The spec catches up.*
  - **Rule.** On a request URL, `GET` and `HEAD` read the request, and `POST` serves the forms of the request's page and is negotiated as the page is; any other method gets 404 with the problem type `route-not-found`, the error model's row for a route the surface does not offer, with no 405 row. A request URL under an earlier key answers 307, which keeps a `POST` a `POST`. The answer to a `POST` carries an `ETag` of that answer alone, which no later read matches. A path with percent-encoded letters, digits, `-` or `.` names the same URL as the decoded path, so `/FE%2D142` is `/FE-142`.
  - **Why.** One answer for every method no route offers keeps the error model's rows few; decoding unreserved characters is what RFC 3986 says such paths mean.
  - **Alternatives.** *405 with `Allow`:* a new row for a case no client relies on. *403:* says the caller lacks a right, when no route exists.
  - **Code.** `packages/commands/src/request-urls.ts` and `negotiation.ts`; tested in `packages/commands/test/request-urls.test.ts`.

#### The requester loop

- **D55 (43). A user's own events are not their updates** [LOOP-01]. *The code and the spec change.*
  - **Rule.** `whats_new`, `tiehall updates`, the wait endpoint, the Claude Code hooks and the email digest leave out every event whose accountable human is the user themself, what they or their agents did; the request stays in their scope, so other people's events on it still reach them. The web inbox's update feed, which uses the same scope, leaves them out too.
  - **Why.** Today the Stop-hook waiter wakes Claude for its own writes, and the digest lists what the reader did; neither is news to them.
  - **Alternatives.** *Including them, as built:* every write of an agent wakes its own session. *Leaving the web inbox's feed as it is:* two scopes for one family of readers.
- **D55 (44). A new reader starts where the web inbox is, and the hooks follow the furthest reader** [LOOP-02]. *The code and the spec change.*
  - **Rule.** A reader that has no cursor yet, such as a new MCP client of the user or the CLI's first login, starts at the user's web inbox cursor, not at 0. The hooks read the user's updates after the furthest of the cursors of the user's CLI and MCP clients on that install, so an acknowledgement through `whats_new` also quiets them; they still acknowledge nothing.
  - **Why.** Today a first install and each login replay the user's whole history, 50 at a time, and acknowledgements made through `whats_new` never reach the hooks, which keep announcing what the agent has handled.
  - **Alternatives.** *Starting at the newest event:* updates the user has seen nowhere would be skipped. *One cursor for all of a user's readers:* D28 #60 and the read cursors keep one per client, so that each reader keeps its place.
- **D55 (45). "Accountable for" means having acted on the request** [LOOP-03]. *The spec catches up.*
  - **Rule.** A request stays in a user's updates for good once they opened it, claimed it, are the accountable human of a proposal on it, or are the accountable human of any event on it, such as a message they or their agent posted or a PR they linked, much as GitHub's "participating" works. Item (43) still keeps their own events out.
  - **Why.** A person who has taken part in a request expects to hear how it goes on.
  - **Alternatives.** *Only current claims and pending proposals:* a person drops out of a request they asked a question on as soon as it is answered.
  - **Code.** `packages/commands/src/updates.ts`; tested in `packages/commands/test/pull-reader-scope.test.ts`.
- **D55 (46). A new request to a user's team reaches them once** [LOOP-04]. *The spec catches up.*
  - **Rule.** Of a request addressed to one of the user's teams, only its opening and its reassignment into that team reach the user's updates through the team; its later events reach them only once the request is theirs by another rule, such as a claim.
  - **Why.** Every event of every request to a team would bury each member's updates; the team's requests are listed by `list_inbox` and the web UI.
  - **Alternatives.** *Every event of the team's requests:* the updates become the team's feed.
  - **Code.** `packages/commands/src/updates.ts`; tested in `packages/commands/test/pull-reader-scope.test.ts`.
- **D55 (47). The wait answer uses the API's names, and breaks before the first release use the label** [LOOP-05]. *The code and the spec change.*
  - **Rule.** Each entry of the wait endpoint's answer carries `seq`, `type`, `requestKey`, `teamKey` and `url`, named as the rest of the API names its fields. The change is made before Tiehall's first release under the `api-breaking` label with a changelog entry and a version bump. To allow that, the label's rule gains one case: before the first release, a pull request may also make a breaking change to a `beta` operation without the notice period when an approved OpenSpec change names that break, since no released install serves the old shape. Items (37) and (50) use the same case.
  - **Why.** One naming style across the API; after the first release a rename costs a deprecation cycle, before it costs nothing to anyone.
  - **Alternatives.** *Keeping `request_key` and `team_key`:* one operation unlike every other, for ever. *The three-step notice:* fourteen days of two names for fields no released client reads. *Using the label without amending its rule:* the label is reserved for urgent security fixes.
- **D55 (48). The digest catches up, and notices may hold Tiehall's fixed words** [LOOP-06]. *The code and the spec change.*
  - **Rule.** The daily digest covers every UTC day that ended since the last digest the user was sent, at most the 7 latest, in one email, sent at most once per UTC day; its subject names the days it covers. The rule on notices becomes: push notices, which are the Claude Code hooks' output, email subjects and the message of a URL-mode elicitation, carry only identifiers, such as the request key, the event type, the team's key, the request URL, dates and counts, and Tiehall's fixed words, never text a person or an agent wrote.
  - **Why.** A worker that was down over a day skips that day's digest today. The hooks' headings and the digest's subject are Tiehall's own fixed words, which the rule's list of four items did not allow, though they carry nothing anyone wrote.
  - **Alternatives.** *One email per missed day:* a flood after an outage. *No cap:* an install down for a month would mail a month. *Listing every fixed sentence in the spec:* the spec would change with every wording.
- **D55 (49). Who gets a question's email** [LOOP-07]. *The spec catches up.*
  - **Rule.** The immediate email about a question never goes to the person who posted it, and it is transactional: it is sent even when the person it is asked of has turned the digest off.
  - **Why.** Nobody needs an email about their own question, and a question that blocks a request is the loop's most urgent notice, like a proposal notice.
  - **Alternatives.** *The question email under the digest switch:* turning the digest off would also silence the questions that block work.
  - **Code.** `packages/commands/src/question-emails.ts`; tested in `packages/commands/test/question-emails.test.ts`.
- **D55 (50). The raw event reads become internal** [LOOP-08]. *The code and the spec change.*
  - **Rule.** `events.read` and `events.acknowledge`, which return every domain event of the install outside the scope of `whats_new` and share each client's cursor with it, become internal commands offered on no agent surface, before the first release, on the path item (47) states. `whats_new` (with `tiehall updates`) and the wait endpoint are the readers' API.
  - **Why.** Reading through one moves the other's cursor, and the raw read serves events outside what the requester loop gives a reader.
  - **Alternatives.** *A cursor of their own:* two cursors per client to explain. *Narrowing them to the scope of `whats_new`:* they would duplicate it.
- **D55 (51). The hooks as built** [LOOP-10]. *The spec catches up.*
  - **Rule.** The CLI has a third hook command, `tiehall hook session-end`, which the SessionEnd hook runs to release the session's lock. `tiehall watch` shares the announced mark with the hooks, and exits with code 1 when the install refuses it. An entry of the wait's answer that the CLI cannot read is skipped. The SessionStart digest lists at most 50 updates, then, when more wait, one line that says so. `TIEHALL_HOOK_WAIT_CAP_SECONDS` may lower the waiter's 30-minute cap, never raise it.
  - **Why.** The spike's corrections (the main change's T15) and the hooks' tests need each of these; the spec should name them.
  - **Alternatives.** *Leaving them out of the spec:* behavior a user meets would rest on no rule.
  - **Code.** `packages/cli/src/hooks.ts` and `watch.ts`; tested in `packages/cli/test/hook-session-start.test.ts`, `hook-wait.test.ts` and `watch.test.ts`.
- **D55 (52). An old CLI's digest asks for an upgrade** [LOOP-13]. *The code and the spec change.*
  - **Rule.** When the install answers the hooks' call with `upgrade-required`, the SessionStart digest prints one fixed line that asks the user to run `npm install --global tiehall@latest`, and nothing else; the waiter stays silent.
  - **Why.** Today the hooks fall silent and the user never learns why updates stopped arriving.
  - **Alternatives.** *The waiter waking Claude with the line:* it would wake on every turn until the upgrade. *Printing the problem's detail:* server text too, but its wording can change with each release.

#### Operations

- **D55 (53). `admin grant` before setup records nothing** [OPS-01]. *The spec catches up.*
  - **Rule.** Before setup completes, no org and no member exist: `admin grant` then changes nothing, says that setup is not complete, and records nothing. Every run after setup is a security event, as before.
  - **Why.** The activity log takes no event before setup completes, as the setup screen's refused sign-ins record nothing either.
  - **Alternatives.** *An event before setup:* no org exists to hold it.
  - **Code.** `packages/commands/src/operator-commands.ts`; tested in `packages/commands/test/operator-commands.test.ts` and `apps/server/test/admin-role.test.ts`.
- **D55 (54). An older image leaves the rights on tables it does not know** [OPS-04]. *The code and the spec change.*
  - **Rule.** The migrate step sets the app role's rights only on the tables its own image's migrations know; a table it does not know, which a newer image created, keeps the rights the newer image gave it.
  - **Why.** After a rollback to an older image, its migrate step today grants full rights on every table it finds, so the app role could write the read-only backups table.
  - **Alternatives.** *Revoking every right on unknown tables:* during a rollout with `web` and `worker` on different images, it would break the newer process. *Refusing to run when unknown tables exist:* blocks the rollback that an operator needs most.
- **D55 (55). Compose limits the memory and processes of Tiehall's containers** [OPS-10]. *The code and the spec change.*
  - **Rule.** The release `compose.yaml` sets a memory limit of 2 GiB and a process limit of 512 on the app, and a memory limit of 512 MiB and a process limit of 128 on the migrate step. The install docs say that an operator may change them, and the Compose check fails a change that removes them.
  - **Why.** Without limits a runaway process can take the host's memory (the security review of 2026-10-03, D-3); 2 GiB is several times what the app uses, and the cap on bodies of item (5) keeps the reading of bodies far below it.
  - **Alternatives.** *No limits, as built:* the host is the limit. *Limits as `.env` settings:* every operator would meet two more settings for a rare need.
- **D55 (56). Registering a name again keeps the API only when nothing moved** [CON-01]. *The code and the spec change.*
  - **Rule.** Registering an API under the name of an unregistered one reuses that API, with its earlier declarations, only when its repository and its provider team are the same as before. Otherwise it is a new API: the earlier declarations do not carry over, and consuming teams declare it again.
  - **Why.** Teams declared that they consume an API served from one repository by one team; a registration that moves the name elsewhere would route another codebase's changes to them.
  - **Alternatives.** *Always reusing, as built:* declarations follow a name to code nobody declared. *Never reusing:* an admin who unregistered by mistake loses every declaration.
- **D55 (57). GitHub Actions' OIDC host is a documented outbound connection** [CON-02]. *The spec catches up.*
  - **Rule.** The list of outbound connections names `token.actions.githubusercontent.com`, from which Tiehall reads the keys that sign GitHub Actions' OIDC tokens, to check a CI caller.
  - **Why.** The install calls it, and the docs already list it; the spec's "GitHub (its API and web)" did not cover it.
  - **Alternatives.** *Reading it as part of "GitHub":* operators write egress rules by host.
  - **Code.** `GITHUB_ACTIONS_JWKS_URL` in `packages/commands/src/ci-tokens.ts`; the egress list in `docs/install.md`.

#### Contract changes

- **D55 (58). The order of a CI caller's checks** [CON-03]. *The spec catches up, and one case changes.*
  - **Rule.** A call to `/api/v1` with a GitHub Actions OIDC token is checked in this order, after the body's size. A path that serves no operation answers 404. An operation other than `contract.report` gets 403 with `ci-caller-refused` before GitHub Actions' keys are read, so it can never get a 502. For `contract.report`, the token is checked first: its signature, issuer, audience and expiry (401 `invalid_token`, or 502 `integration-unavailable` when the keys cannot be read). Then a token whose repository has no registered API gets 403 with `ci-caller-refused`, and its `jti` is not recorded, so the same token gets 403 again, not 401. Then a `jti` already recorded gets 401 `invalid_token`; otherwise the `jti` is recorded, and spent, before the report itself is checked, so a report refused after that point, for its input, its API or its workflow, has still spent its token.
  - **Why.** The identity is proved before any answer depends on the repository, so an unauthenticated caller cannot learn which repositories have registered APIs; spending the `jti` on acceptance makes a token good for one try, whatever the try's result.
  - **Alternatives.** *Reading the keys before refusing another operation, as built:* such a call can get an undocumented 502. *Judging the repository before the signature:* a forged token would learn which repositories are registered. *Spending the `jti` only on a taken report:* a token could retry a refused report.
  - **Code.** `packages/commands/src/ci-tokens.ts`; tested in `packages/commands/test/ci-callers.test.ts`.
- **D55 (59). `contract.report`'s input** [CON-04]. *The spec catches up.*
  - **Rule.** `contract.report` refuses, with 400, a field it does not define at any level of its input; takes at most 1,000 changes; names the provider PR by its number alone, the repository being the API's; and names an API by a name of 1 to 100 characters of lower-case letters, digits, `.`, `_` and `-` that starts with a lower-case letter or a digit, the form in which APIs are registered. The rule on the first character is the maintainer's answer of 2026-10-12: the code kept it already, and the OpenAPI document and the MCP tool snapshot publish it.
  - **Why.** The operation is `stable` from the start, so its input is the contract pinned Actions keep to; a strict input makes a mistaken field visible at once.
  - **Alternatives.** *An open input that drops unknown fields, as the packet does:* a misspelled field would vanish silently from a stable contract. *Any of the name's characters first:* would change the published pattern for names such as `-payments`, which nobody needs.
  - **Code.** `API_NAME` in `packages/catalog/src/schemas.ts`, which registration and `packages/catalog/src/contract.ts` share; tested in `packages/commands/test/contract-reports.test.ts` and `api-registrations.test.ts`.
- **D55 (60). Changes to the consumer map are recorded as domain events** [CON-06]. *The code and the spec change.*
  - **Rule.** Declaring that a team consumes an API, removing that declaration and re-confirming it each append a domain event in the same transaction, naming the team, the API and who acted, which the activity log shows. No reader of the requester loop serves these events, because they concern no request, and the declarations stay in the web UI, on no agent surface.
  - **Why.** Contract changes route by the map, so who changed it, and when, should be answerable.
  - **Alternatives.** *No event, as built:* nobody can say why a team stopped getting requests. *Security events:* they change nothing about who may do what, as R21 reads team changes.
- **D55 (61). A workflow binding names the workflow file, and a PR run reports its own PR** [CON-09]. *The code and the spec change.*
  - **Rule.** The binding an admin gives an API names a repository and a workflow file's path, such as `acme/payments/.github/workflows/contract.yml`, and is compared with the token's `job_workflow_ref` without the `@` and the ref that follow it. When the token's `ref` claim is `refs/pull/<n>/merge`, as on a run for a pull request, the report must name PR `n`; a report that names another PR is refused with 403 and `ci-caller-refused`. The test issuer that the tests use issues the pairs of `ref` and `job_workflow_ref` that GitHub issues.
  - **Why.** On a `pull_request` run, `job_workflow_ref` ends in `@refs/pull/<n>/merge`, so an API bound to `…@refs/heads/main`, the spec's own example, refused every report from a PR, and the check of a report's PR number against the run it came from was missing.
  - **Alternatives.** *Matching the whole ref, as built:* every PR's report is refused. *Binding to a branch as well:* the Action runs on PRs from any branch.
- **D55 (62). The Action fails open on every failure but a checksum mismatch** [CON-10]. *The code and the spec change.*
  - **Rule.** When the download of the diff engine is blocked, the OpenAPI document holds external `$ref`s the Action does not follow, the PR deletes the document, or the install refuses the report with 400 (over 1,000 changes) or 413 (over 16 MiB), the Action's job succeeds with a warning annotation and a job summary that say what happened. Only a downloaded engine whose checksum does not match fails the step. With the input that asks to fail on breaking changes, the check still fails for breaking changes the Action computed; when it could compute none, it does not fail for that.
  - **Why.** D28 #76 has the Action fail open; an infrastructure fault should not block a merge, and the PR's author should learn why no report went. A checksum mismatch may mean a tampered binary, which must not run.
  - **Alternatives.** *Failing closed on the four cases, as built:* merges blocked by faults outside the PR. *Failing open silently on a 400 or a 413, as built:* the author never learns that no team was told. This settles `request-body-limit`'s Open Question on the Action's 413.
- **D55 (63). A contract section attached by hand may name no provider PR** [CON-12]. *The code and the spec change.*
  - **Rule.** In a contract section a developer attaches by hand, with `tiehall contract diff` and `attach_contract_changes` or its REST operation, the provider PR and the provider status are optional. A contract-change request that a report opens always carries both. The schema changes before publication through the packet's path for breaking changes: a changelog notice 14 days ahead, the `api-breaking` label and a changelog entry.
  - **Why.** A developer who diffs two refs on their machine often has no PR yet; today they must name one to attach anything.
  - **Alternatives.** *Requiring a PR, as built:* people invent one. *A separate section for hand-attached diffs:* two shapes for the same data.
- **D55 (64). A report whose changes did not change adds nothing** [CON-13]. *The code and the spec change.*
  - **Rule.** An update to a change set whose classified changes, each change's id, level and operation, equal the last update's adds no packet revision, no system message and no notice to any of its requests.
  - **Why.** A rerun of the same workflow, or a push that leaves the API alone, adds noise to every consumer's thread and cancels their pending packet proposals as stale.
  - **Alternatives.** *A revision whenever the head commit changed:* every push to the PR would add one. *A revision for every report, as built:* the noise stays.
- **D55 (65). Team-requested updates reach opted-in members' digests** [CON-15]. *The code and the spec change.*
  - **Rule.** A member who opted in to a team's emails as a requester also gets, in their daily digest, the updates on the requests whose requester is that team, besides the question and proposal notices they already get.
  - **Why.** The opt-in reads as "send me this team's requester emails"; today the digest leaves those requests out, so opted-in members never hear of a status change.
  - **Alternatives.** *Question and proposal notices only, as built:* an opted-in member misses most of the loop.
- **D55 (66). Request keys are matched as written** [CON-17]. *The code and the spec change.*
  - **Rule.** A PR's title, body or branch name mentions a request only by its key as written: the team key in upper case, a hyphen and the number, such as `FE-142`, not inside a longer word or number. So a branch such as `renovate/node-22`, or text such as `utf-8`, mentions no request.
  - **Why.** Matching without regard to case let such words close claimed requests `NODE-22` and `UTF-8` with no confirmation.
  - **Alternatives.** *Any case, as built:* false closes. *Requiring a keyword such as "Closes FE-142":* a habit nobody has with Tiehall's keys.
- **D55 (67). Only the target side's links close on merge** [CON-18]. *The code and the spec change.*
  - **Rule.** A PR link counts for close on merge only when the request's claimant or a member of its target team made it; a link by anyone else is recorded and shown on the request, but its merge closes nothing. Mentions in the PR's own title, body or branch name count as before.
  - **Why.** Any member, the requester side included, could link a PR to another team's claimed request and close it by merging, without the target team.
  - **Alternatives.** *Any member's link, as built:* a closing path around the target team. *A confirmation for others' links:* a step for links that rarely matter.
- **D55 (68). Breaking changes that come back after a system withdrawal open a new request** [CON-19]. *The code and the spec change.*
  - **Rule.** When a later update for a change set again holds changes that open requests, after Tiehall withdrew a team's request for it as a system withdrawal because the breaking changes had disappeared, Tiehall opens a new request for that team; the withdrawn one stays withdrawn.
  - **Why.** Today the team gets only a notice on its withdrawn request, which no inbox lists as open work.
  - **Alternatives.** *A notice on the withdrawn request, as built:* the change goes unhandled. *Reopening the withdrawn request:* a terminal state would become reversible outside the undo window.
- **D55 (69). WARN digests leave the standing list** [CON-20]. *The code and the spec change.*
  - **Rule.** A team's WARN digest stays in a member's standing list until that member dismisses it, or 7 days after it was produced, whichever comes first.
  - **Why.** Today they stay for ever, and the standing list is for things that still need someone.
  - **Alternatives.** *For ever, as built:* the list grows without end. *One member's dismissal for the whole team:* the others never see it.
- **D55 (70). The WARN digest gives counts, the API and the PR** [CON-21]. *The spec changes, and the email follows.*
  - **Rule.** The WARN digest, in the inbox and by email, gives for each API the number of WARN-level changes, the API's name and a link to each provider PR, and never the changes' text; the scenario that says it "lists the change" says so.
  - **Why.** Digests carry only server text (the main change's T14), and the changes' texts come from the provider's CI.
  - **Alternatives.** *Listing each change's text:* text from outside Tiehall in an email. *Counts alone:* the reader cannot tell which API or PR to look at.
- **D55 (71). The provider PR's merge adds a system message** [CON-22]. *The code and the spec change.*
  - **Rule.** The packet keeps the provider status the last report gave; the request shows the provider change as shipped from the merge on; and each request of the change set that is not in a terminal state gets one system message, in Tiehall's words, that the provider PR merged and the change shipped.
  - **Why.** The consumer reads the thread, and the merge is the moment their deadline becomes real; packet revisions stay the record of what reports said.
  - **Alternatives.** *A packet revision with the status merged:* a revision no report made, which would cancel pending packet proposals as stale. *No message, as built:* the merge shows only on the request's page.
- **D55 (72). Close on merge as built** [CON-23]. *The spec catches up.*
  - **Rule.** A claim or a link recorded in the same second as the merge counts as made before it. After a provider PR is reopened, the first of its later reports whose changes open requests opens a new request for each team whose request the close withdrew. A close on merge is a system action, attributed as D50 (10) attributes integration events. A PR in a repository that no connected installation covers can be linked, and its merge closes nothing.
  - **Why.** GitHub's times have whole seconds; "the next report" would miss a reopened PR whose next report had no breaking change.
  - **Alternatives.** *A claim in the same second as the merge counting as after it:* the order inside a second is unknown, and the claim was meant for that PR.
  - **Code.** `packages/commands/src/close-on-merge.ts` and `contract-routing.ts`; tested in `packages/commands/test/close-on-merge.test.ts` and `contract-provider-close.test.ts`.
- **D55 (73). "Before it merged" means a read while the PR was open** [CON-24]. *The spec catches up.*
  - **Rule.** A key in a PR's title or body counts as mentioned before the merge only when Tiehall read it, from a delivery or a poll, while the PR was open: in polling mode, a key written and merged within one poll is missed, and a key read during an earlier open period still counts after a reopen. The head branch's name cannot change, so a key in it counts even when Tiehall reads it only after the merge.
  - **Why.** A key added to a merged PR's body must not close a claimed request, which a read after the merge could not tell from one written before it.
  - **Alternatives.** *Reading the PR's text at the merge:* anyone with write access could close a claimed request by editing a merged PR.
  - **Code.** `packages/commands/src/close-on-merge.ts` with the table `pull_request_mentions`; tested in `packages/commands/test/close-on-merge.test.ts`.

#### Tracker mirrors

- **D55 (74). A close as a duplicate is not a tracker "Done"** [MIR-01]. *The code and the spec change.*
  - **Rule.** A GitHub mirror issue closed with the `state_reason` `duplicate` counts as a close marked not planned: Tiehall records it and adds a notice, and creates no done proposal.
  - **Why.** A duplicate is not work done; reading it as "Done" could propose closing a request whose work is elsewhere.
  - **Alternatives.** *Counting it as Done, as built:* a proposal to close unfinished work.
- **D55 (75). Mappings and the issues they made** [MIR-02]. *The spec catches up, and the code follows it.*
  - **Rule.** Removing a team's mapping stops every write to the mirror issues it made; a new mapping, to the same tracker or another, mirrors from then on, opening new issues as requests reach the point the team mirrors at. No issue is made for a request claimed, or ended, before its team's mapping existed.
  - **Why.** A mirror is a projection kept from a point on; filling a tracker with past requests would surprise the team that maps it.
  - **Alternatives.** *Backfilling every open request:* a burst of issues on the day of the mapping.
  - **Code.** `packages/commands/src/mirrors.ts` and `tracker-mappings.ts` (T17); tested in `packages/commands/test/tracker-mappings.test.ts`, `mirrors.test.ts` and `github-mirror-done.test.ts`. The rule was read as one the code kept already, but the code found a request's issue by its team's place and counted any claim, or the opening, whenever it was; once the rule was approved, the code was made to follow it.
- **D55 (76). A newer mirror job supersedes a dead-lettered one** [MIR-03]. *The code and the spec change.*
  - **Rule.** A mirror job of a request in the dead-letter queue does not hold back the request's later mirror jobs. A newer job runs, projects the request as it is now, catching up the comments the failed job missed, and when it succeeds the dead-lettered job is cleared with its banner.
  - **Why.** Mirror jobs are level-triggered and idempotent (the main change's T16), so the newer job does everything the older one would have; today one failure freezes the request's mirror until someone presses Retry.
  - **Alternatives.** *Holding later jobs, as built:* one failure stops the mirror. *Dropping the dead-lettered job silently:* the banner would vanish without a success.
- **D55 (77). A polled change acts for the account GitHub names** [MIR-04]. *The code and the spec change of D50 (10).*
  - **Rule.** D50 (10) is amended: a change Tiehall reads by polling or reconciliation acts for the Tiehall user of the account that GitHub's read names as having made it, where it names one, such as the `closed_by` of a closed issue, while that user is a member; otherwise it acts for no user.
  - **Why.** `closed_by` is GitHub's own record of who closed the issue, the same account a delivery's sender would name; without it, a tracker "Done" in polling mode could never become a proposal.
  - **Alternatives.** *No user for every polled change, as D50 (10) says:* polling installs would lose the tracker "Done" setting.
  - **Code.** `packages/commands/src/github-issue-processing.ts`; tested in `packages/commands/test/github-issues.test.ts` and `github-mirror-reconciliation.test.ts`.
- **D55 (78). A reassignment undone before its mirror job runs writes nothing** [MIR-05]. *The spec changes.*
  - **Rule.** Mirror jobs project the request as it is when they run; when a reassignment and its undo both land before the mirror job runs, the job sees no move and writes nothing: no notice on the old issue and no new issue.
  - **Why.** Level-triggered jobs (the main change's T16) see states, not the steps between them, which is what makes retries and echoes harmless.
  - **Alternatives.** *Replaying each step to post both notices:* edge-triggered jobs, which T16 rejected.
  - **Code.** `packages/commands/src/mirrors.ts`; tested in `packages/commands/test/github-mirror-reassignment.test.ts`.
- **D55 (79). A mirror issue gone from GitHub is marked gone** [MIR-06]. *The code and the spec change.*
  - **Rule.** When GitHub answers a write to a mirror issue with 404 or 410, as for an issue deleted or moved out of reach, Tiehall marks that mirror gone, stops writing to it, adds one notice to the request, and clears the job's dead letter and banner. It does not open the issue again.
  - **Why.** Today such a job fails every attempt and every Retry for good, and its banner can never go.
  - **Alternatives.** *Opening a new issue:* someone deleted or moved the old one on purpose. *Failing for good, as built:* a banner nobody can clear.

#### Agent safety and docs

- **D55 (80). An API's name is its provider team's text** [SAFE-06]. *The code and the spec change.*
  - **Rule.** An API's name, which an admin wrote, has the origin of the API's provider team wherever agents read it: fenced in markdown, as `directory` already fences it, the provider change's line of `get_request` included, and, in JSON, under `untrusted`: the provider change of `requests.get` gains `untrusted.api`, and its `providerChange.api` is deprecated on the `beta` path and removed after its sunset. A repository's full name stays outside the fence, as an identifier whose form GitHub closes, as a GitHub login does.
  - **Why.** The same name was fenced in one place and printed as Tiehall's own text in another; one origin per string is the rule.
  - **Alternatives.** *Tiehall's text everywhere:* an admin's words would read as Tiehall's. *Removing `providerChange.api` at once:* a break without notice.
- **D55 (81). Every confirmation gets a receipt** [DOC-01]. *The code changes, and the spec says so.*
  - **Rule.** Every action confirmed with the confirmation step, not only proposals, gives the person who confirmed it a receipt in their standing list, and by email when SMTP is set, that says in Tiehall's words what they confirmed, never a secret or a token's value: creating a personal access token, approving an agent client or the CLI, a role change, a removal, an invite, the sign-in policy, the PAT settings and the write budget, an installation, the App's key and webhook secret, the Jira connection, an API's registration, a fan-out and an export. The docs then say "every confirmation" again.
  - **Why.** A receipt is how a person notices a confirmation they did not mean, such as one an agent driving their browser made; trust changes matter most.
  - **Alternatives.** *Receipts for commitments only, as built, with the spec narrowed:* the most sensitive confirmations go without one.
- **D55 (82). Team membership changes are security events** [DOC-02]. *The code and the spec change.*
  - **Rule.** Adding a person to a team and removing one from a team are security events that name the admin, the person and the team. They need no confirmation step. R21's reading changes for team membership; other team changes, mappings, intake settings and the bot flag stay out. The rule is stated in teams-and-roles; activity-log's list of security events gains its bullet in the commit that builds it, together with `tools/repo-checks/security-events.json`, because the coverage check reads the newest change's wording of that list at once (T15).
  - **Why.** Membership decides who may claim, who confirms the other side of a cross-team commitment, and who may release a claim; who changed it must be answerable from the log and its export.
  - **Alternatives.** *Not recorded, as built:* nobody can say who gave a person a team's rights. *A confirmation step too:* slows routine team work, while a removal from the install already has one.
- **D55 (83). The published packet schema names `http` and `https`** [DOC-03]. *The code and the spec change.*
  - **Rule.** Every URL field of the packet schema, a link's URL and the provider PR's URL, carries a pattern that admits only `http` and `https` URLs, so a validator that skips formats refuses another scheme, as the server does. The schema changes before publication through the packet's path for breaking changes, and the package README's caveat goes.
  - **Why.** The schema is the contract others validate packets against (D24); one that admits `javascript:` and `data:` URLs misleads every tool that renders a link.
  - **Alternatives.** *The `uri` format alone, as built:* validators need not check formats, and the package's own does not.
- **D55 (84). The security policy's terms** [DOC-05]. *Recorded; one step waits for the maintainer.*
  - **Rule.** `SECURITY.md` keeps the terms it was written with: reports go only through GitHub's private vulnerability reporting on the public repository; fixes go to the latest release, in a patch release, and to `main` before the first release; the advisory credits the reporter unless they ask not to be named; and the policy promises no response times. A fallback contact, an address of the project's own organization, is added once the project has one, with the steps of making the repository public.
  - **Why.** One private channel that the maintainers watch, and no promise a small team cannot keep.
  - **Alternatives.** *A personal email address now:* ties the project to one person's inbox. *Response times:* a promise that would be broken. *Fixes for older releases:* v1 has no long-term releases, and skipping releases works.
- **D55 (85). Debian's signed archives for the base image's release** [IMG-01]. *The spec catches up.*
  - **Rule.** The rule on the operating system's patches says what the build does: they come from Debian's signed archives for the base image's release, its security archive and its stable updates, as `image-os-security-updates`'s R1 reads D53.
  - **Why.** A security update can depend on a version that only the stable updates carry, and both archives are signed with the same keyring.
  - **Alternatives.** *The security archive alone:* would hold such an update back.
  - **Code.** `Dockerfile`; tested in `tools/repo-checks/test/image-os-updates.test.ts`.
- **D55 (86). A reviewed exception for a fixable finding outside Debian** [IMG-02]. *The spec changes.*
  - **Rule.** When the image scan reports a fixable HIGH or CRITICAL finding in Node's binary or an npm package, and the fixed version is younger than the 7-day release age, a reviewed pull request may take exactly the version the advisory names as fixed: never automatically, with the label `release-age-exception`, with a changelog entry that names the advisory, and with an exclusion from the release age that names that one version and is removed once it is 7 days old. Every other update keeps the 7-day age.
  - **Why.** Otherwise the Build stays red for up to a week on a known, fixed vulnerability, and every release in that time ships it. D53 rejected an urgent exception for the base image because Debian's own fix was at hand without a new base image; for Node or npm no such path exists.
  - **Alternatives.** *Waiting, as D53 left it:* a known vulnerability ships for a week. *Ignoring the finding with an end date:* D53 rejected it, because the image still ships the vulnerability.

Carried, restated where they are and not repeated here: in the main change's design.md, D3, D8, D9, D14, D15, D17, D19, D23, D24, D28, D29, D30, D33, D35, D36, D37 and D38 (Decisions this change rests on there); in `spec-catch-up`'s design.md, D45; in `request-body-limit`'s design.md, D43; in `github-app-reachability`'s design.md, D49; in `github-layer-hardening`'s design.md, D50; in `image-os-security-updates`'s design.md, D53.

### Rules carried from earlier changes

The MODIFIED requirements keep every sentence and scenario they had, except where an item of D55 changes them, and add their new sentences and scenarios. Kept scenarios whose body changes with their rule: public-api "A web form over the limit" (item (2)); agent-access "A bound API accepts only its workflow" (item (61)); contract-changes "A report from another workflow of a bound API" (item (61)) and "WARN-level changes reach the digest only" (item (70)); agent-surfaces "The hook commands are listed" (item (51)); requester-loop "A question arrives during a wait" (item (47)); and requests "A qualifying PR merges", which now says that Bob is a member of the target team (item (67)). contract-changes "Breaking changes open one request per consuming team" is modified only to name the exception item (68) adds. The unchanged parts rest on the sources their earlier `Source:` lines cite, which stay restated where they were:
- in the main change's design.md: the decisions listed above; the design rules for teams and roles, requests and events, the handoff packet, agent access, agent surfaces, the requester loop, agent safety, contract changes, tracker mirrors and the public API; T3 to T5, T7 to T10, T12 to T17 under "Technical decisions"; and S2 to S10 and S12 to S15 under "Self-hosting decisions";
- in `spec-catch-up`'s design.md: D45 (1) and (2), for "Packet fields" and "Teams";
- in `request-body-limit`'s design.md: D43 and its design rules, for "Request bodies have a size limit", "One error model for Tiehall's own refusals" and "One report operation that never takes a whole spec";
- in `github-layer-hardening`'s design.md: D50 and its items, for "Request bodies have a size limit", "One error model for Tiehall's own refusals", "Six kinds of caller", "Who may sign in", "GitHub and Jira each run in webhook mode or polling mode" and "Broken integrations are surfaced";
- in `image-os-security-updates`'s design.md: D53 and its design rules, for "Release pipeline integrity".

### Text corrections to earlier changes

Applied by this change's task 1.60, once the maintainer approves this change; each is a text edit, with no effect on any spec.

- **The main change's design.md, Decisions this change rests on.**
  - D28 #26: after "list the missing fields" add "; they also refuse a reassignment proposal into a team whose required fields the packet lacks, and a packet revision that drops one (decisions-from-groups-15-28, D55 (41))".
  - D28 #43: "accepts 10 registrations per hour per IP address" becomes "accepts 10 registrations per hour per IP address, an IPv6 client counted by its /64 (decisions-from-groups-15-28, D55 (24))".
  - D28 #53: at its end add "; so are the C0 control characters but tab and line feed, DEL and the C1 control characters (decisions-from-groups-15-28, D55 (36))".
  - D28 #58: at its end add "; the user's own events are left out, and a new request reaches the members of its team by its opening and a reassignment into the team (decisions-from-groups-15-28, D55 (43), (46))".
  - D28 #59: "each entry also carries `team_key` and `url` (T15)" becomes "each entry also carries `teamKey` and `url` (T15; decisions-from-groups-15-28, D55 (47))".
  - D28 #60: "The hooks read with the CLI client's cursor and never acknowledge" becomes "The hooks read after the furthest cursor of the user's CLI and MCP clients and never acknowledge (decisions-from-groups-15-28, D55 (44))".
  - D28 #80: "A close that the tracker marks as not planned is not a tracker "Done"." becomes "A close that the tracker marks as not planned, or on GitHub as a duplicate, is not a tracker "Done" (decisions-from-groups-15-28, D55 (74))."
- **The main change's design.md, Design rules.**
  - Requests and events, "Close on merge": "that was linked to it, or mentioned its key in the title, body or branch name, before merging" becomes "that was linked to it by its claimant or a member of its target team, or mentioned its key, as written, in the title, body or branch name, before merging (decisions-from-groups-15-28, D55 (66), (67))".
  - Agent surfaces, "Negotiated URLs": "and one that negotiates HTML, the default, is sent to sign-in (Readings to confirm, R17)" becomes "one that negotiates HTML, the default, is sent to sign-in, and one with a token that negotiates HTML gets markdown (Readings to confirm, R17; decisions-from-groups-15-28, D55 (38))".
  - Agent safety: "hook output and email subjects carry the request key, the event type, the team and the URL;" becomes "hook output and email subjects carry only identifiers, such as the request key, the event type, the team and the URL, and Tiehall's fixed words (decisions-from-groups-15-28, D55 (48));".
  - Contract changes: "Each update adds a packet revision" becomes "Each update whose classified changes differ from the last one's adds a packet revision (decisions-from-groups-15-28, D55 (64))".
- **The main change's design.md, Technical decisions.**
  - T8: "Where Better Auth owns a write, such as a session or an OAuth grant, an after-hook appends its security event (S14)." becomes "Where Better Auth owns a write, such as a session, an after-hook appends its security event (S14); the commands that replace its routes, such as approving an agent client and revoking a grant, write their security events in the same transaction (decisions-from-groups-15-28, D55 (10))."
  - T9: "`jwksUrl` points to an internal address, so checking a token makes no outbound call." becomes "Checking a token reads the install's signing keys in the same process, with no HTTP call at all (decisions-from-groups-15-28, D55 (11))."
  - T15: "Each wait answer carries `team_key` and `url`." becomes "Each wait answer carries `teamKey` and `url`."; and "Each wait entry's `team_key` is the request's target team" becomes "Each wait entry's `teamKey` is the request's target team" (D55 (47)).
- **The main change's design.md, Self-hosting decisions.**
  - S13: "the configured Jira site," becomes "GitHub Actions' OIDC keys at `token.actions.githubusercontent.com`, the configured Jira site," (D55 (57)).
  - S14: in the list of security events, "role changes, removals" becomes "role changes, team membership changes, removals"; and "Team changes (creating and renaming teams, who belongs to them, intake settings), team mappings and the bot flag are not security events in v1" becomes "Other team changes (creating and renaming teams, intake settings), team mappings and the bot flag are not security events in v1" (D55 (82)).
- **The main change's design.md, Readings to confirm.**
  - R17: at its end, before "Specs:", add "A request with a token that negotiates HTML gets markdown (decisions-from-groups-15-28, D55 (38))."
  - R21: "team changes, team mappings, intake settings and the bot flag are not security events in v1" becomes "team membership changes are security events (decisions-from-groups-15-28, D55 (82)); other team changes, team mappings, intake settings and the bot flag are not, in v1".
- **The main change's tasks.md**, keeping every checkbox.
  - 15.2: "an internal `jwksUrl`" becomes "token checks that read the signing keys in the same process (decisions-from-groups-15-28, D55 (11))".
  - 15.10: "the approval and a later revocation are security events through after-hooks" becomes "the approval and a later revocation are security events, written in the same transaction as the grant and the revocation (decisions-from-groups-15-28, D55 (10))".
  - 20.3: "Check that every write the sign-in service owns (sessions, grants, grant revocations) appends its security event right after it" becomes "Check that every write the sign-in service owns (sessions) appends its security event right after it, and that grants and grant revocations, which Tiehall's own commands write, append theirs in the same transaction (decisions-from-groups-15-28, D55 (10))".
  - 21.10: "a fixture banner appear to admins only" becomes "a fixture banner appear to the audience that D28 #83, `github-layer-hardening`'s D50 (15) and task 24.11 give each banner: the admins, and the members of each team whose mirrors go through the integration (decisions-from-groups-15-28, D55 (9))".
- **`github-layer-hardening`'s design.md.**
  - D50 (10)'s rule: "A change the poll of GitHub reads names no account that made it, so it acts for no user." becomes "A change the poll of GitHub reads acts for the user of the account that GitHub's read names as having made it, where it names one, such as the `closed_by` of a closed issue, while that user is a member, and for no user otherwise (decisions-from-groups-15-28, D55 (77))."
  - T5: after "`home-route.ts`" add "`apps/server/src/request-guard.ts`, `page-routes.ts`" (D55 (3)).
  - T8: "One migration adds `webhook_given_up_at` and `mode_set_by` to `github_app`" becomes "One migration adds `webhook_given_up_at` and `mode_set_by` to `github_app` and `given_up_at` to `github_redeliveries`"; and in the Migration Plan, "who last set GitHub's mode and when a delivery was given up (T8)" becomes "who last set GitHub's mode and when a delivery was given up, and to each redelivery row when it was given up (T8)" (D55 (8)).
- **`request-body-limit`'s design.md.**
  - Goals: "the webhook paths are an open question" becomes "`/webhooks/github` has its own 25 MiB limit (`github-layer-hardening`, D50 (19)), and the Jira webhook's is an open question".
  - Non-Goals: "or on webhook deliveries (Open Questions)" becomes "or on the Jira webhook's deliveries (Open Questions)" (D55 (4)).
  - The Open Question "The contract Action on a 413" becomes "settled by `decisions-from-groups-15-28`'s D55 (62): the Action fails open with a warning annotation and a job summary on a 400 or a 413" (D55 (62)).
  - T2: "and passes on a body that declares a length within it, which cannot carry more than it declares. A body sent in chunks, with no declared length, it holds, counting its bytes, until the body is complete or passes the limit:" becomes "and holds every other body, whether it declares its length or is sent in chunks, counting its bytes, until the body is complete or passes the limit, so that the cap on bodies being received at once counts the bytes that have arrived (decisions-from-groups-15-28, D55 (5)):"; and "so a shutdown waits for a body still arriving in chunks as for any call in flight" becomes "so a shutdown waits for a body still arriving as for any call in flight" (D55 (5)).
- **`image-os-security-updates`'s design.md.**
  - R1's last sentence, "The spec states the rule as D53 words it.", becomes "`decisions-from-groups-15-28`'s D55 (85) words the spec as this reading."
  - The Open Question "Fixable findings outside Debian's archives" becomes "settled by `decisions-from-groups-15-28`'s D55 (86): a reviewed exception to the release age for exactly the advisory's fixed version, labelled and recorded in the changelog".

### Technical decisions

#### T1. The cap on bodies in flight

- **Choice.** A process-wide counter beside the body limits of `packages/commands/src/body-limit.ts`, which the web role's request guard (`apps/server/src/request-guard.ts`) consults as a body arrives: the guard holds every body until it is complete, whether its request declares its length or sends it in chunks, as `request-body-limit`'s T2 holds a chunked body; it reserves each chunk as it arrives, answers 503 `busy` at a chunk that the cap cannot hold, and passes a complete body on whole; and every path out of the read (done, refused, aborted, or ended by Node's request timeout) releases what it reserved. `packages/core/src/error-model.ts` gains the row `busy` (503, title "Too busy", `Retry-After: 5`), and the OpenAPI document lists 503 `busy` for every operation that takes a body. A declared body now reaches the app once it has arrived whole, as a chunked one does, so a call that the app would refuse without reading its body, such as the setup gate's 503, is answered once its body has arrived.
- **Why.** The guard already refuses bodies before they are read, so the cap sits in the one place every route passes; holding a declared body as a chunked one is held keeps the guard able to answer 503 at the chunk that passes the cap, since the app has not been handed the call.
- **Alternatives.** A semaphore on the count of requests, which bounds nothing about their size. Counting a declared body's bytes while it is passed on to the app as they arrive: the app would hold the call when the cap is reached, and the guard could no longer answer it.

#### T2. A removed webhook

- **Choice.** `readDeliveryLog` in `packages/commands/src/github-delivery-log.ts` tells a 404 apart from an empty log; `redeliverFailedDeliveries` in `github-redelivery.ts` and the mode check in `github-mode.ts` move GitHub to polling, in the write that sets `webhook_given_up_at`, when a webhook secret is stored, with the cause `webhook_removed` added to `packages/core/src/event-types.ts`. The banner and the email are D50 (15)'s, shown and sent as for a given-up delivery, except for the sentences that say what happened and what to do: D50 (15)'s say that Tiehall gave a delivery up after asking GitHub 5 times, which would be untrue here, so these say that GitHub holds no webhook for the App any more and that an admin adds it again in the App's settings, with the secret Tiehall stores, before switching back to webhook mode. A column the migration `0096_record_a_removed_github_webhook.sql` adds, `github_app.webhook_removed`, records which of the two raised the banner: the write that moves GitHub to polling sets it, and every write that sets or clears `webhook_given_up_at` otherwise clears it. These sentences and the column were written while item (6) was built, after the approval below, which saw "The banner and the email are D50 (15)'s" here, so they wait for the maintainer's approval (Open Questions).
- **Why.** The redelivery job reads the log every 10 minutes in webhook mode already.

#### T3. The sign-in's look-up failure

- **Choice.** `decideAdmission` in `packages/commands/src/sign-in-admission.ts` returns an "unavailable" outcome when a look-up's report is unknown and none is a member; `sign-in.ts` answers it with the refusal of `integration-unavailable` through the renderer, writes no refusal record and logs a warning.
- **Why.** The admission already knows each look-up's outcome; only its answer changes.

#### T4. Authorization requests and registrations

- **Choice.** In `packages/commands/src/authorization-server.ts`, the step that completes each request before the server reads it drops `offline_access` from the asked scopes before checking them, and sets `resource` to `TIEHALL_URL/mcp` when it is missing, for the authorization and the token requests alike. The grant itself keeps `offline_access`, since the sign-in library issues a refresh token only for a grant that carries it, and the library writes every scope of the grant into the access token's `scope` claim; so the step that rewrites the token endpoint's answer leaves the scope out of the answer's `scope` and signs the access token again without it, with the key that signed it and every other claim kept. In `agent-clients.ts`, the registration limit's key is the address for IPv4 and its /64 for IPv6, and the metadata bounds are checked, as a refusal that still counts, beside the NUL check; the metadata document's fetch checks the same bounds, and the URL's length before it fetches, with the URL written in printable ASCII with no space, as RFC 3986 writes a URL, so that its 1,024 characters are at most 1,024 bytes of the database's bounds on what a client's id is written into.
- **Why.** The step and the checks exist; each rule adds a line to them.

#### T5. Control characters

- **Choice.** The stripping step of the one renderer (`packages/packet/src/render.ts`, the main change's T14) removes the C0 controls but tab and line feed, DEL and the C1 controls with the invisible characters, for markdown and for every string of the JSON agents read; the CLI prints only what that step returns.
- **Why.** One renderer is one place to get it right for every surface.

#### T6. Updates and cursors

- **Choice.** The scope query of `packages/commands/src/updates.ts` leaves out events whose actor is the user; the wait's wake-ups use the same scope. A reader's cursor row is created, when first needed, at the value of the user's web inbox cursor. `updates.read` and `events.wait` gain an optional input that reads after the furthest cursor of the user's CLI and MCP clients instead of the caller's own; the hooks pass it, and it acknowledges nothing.
- **Why.** The hooks call public operations; an optional input changes no other caller.

#### T7. The digest's days

- **Choice.** Each user's row records the last UTC day a digest covered; the digest job covers each ended day after it, at most the 7 latest, in one email whose subject names the first and last day.
- **Why.** One stored day makes the job idempotent and lets it catch up.

#### T8. The CI caller and the workflow binding

- **Choice.** `packages/commands/src/ci-tokens.ts` refuses a GitHub Actions token on any operation but `contract.report` before it reads the keys. `apis.ts` stores the binding without its ref, and compares it with `job_workflow_ref` cut at its `@`; a migration cuts the ref from stored bindings. `contract.report` compares the report's PR number with the `ref` claim's when it is `refs/pull/<n>/merge`. The test issuer in `packages/testing/src/oidc.ts` issues GitHub's pairs of `ref` and `job_workflow_ref` for push and pull request runs.
- **Why.** The binding's purpose is the workflow file; the ref of a PR run says which PR it ran for.

#### T9. Close on merge

- **Choice.** The key pattern of `packages/commands/src/close-on-merge.ts` becomes case-sensitive and bounded by characters that cannot be part of a key; a PR link records whether its linker was the claimant or a member of the target team when it was made, and only such links count.
- **Why.** The side is decided when the link is made, as who confirms a commitment is decided when they confirm it.

#### T10. Mirror jobs

- **Choice.** `packages/commands/src/mirror-jobs.ts` sends a request's next mirror job under a key that no dead-lettered job holds, and its success clears the request's dead letter. `github-issues.ts` turns a 404 or 410 on a mirror issue into a mirror state `gone`, kept on the mirror's row by a migration, which every later job skips.
- **Why.** Jobs are level-triggered, so the newest one is the only one that matters.

#### T11. Receipts for every confirmation

- **Choice.** A migration lets a receipt name either a proposal or a confirmed action, by its action id and the subject its review page named. `packages/commands/src/confirmation-step.ts` appends the receipt in the confirmed action's transaction, from the review page's own words, and the receipt email follows the proposal receipts' template.
- **Why.** The review page already states in Tiehall's words what is confirmed, and never a secret.

#### T12. The Compose limits

- **Choice.** `deploy/compose.yaml` sets `mem_limit` and `pids_limit` on `app` and `migrate`; the Compose check in `tools/repo-checks` requires both, and `docs/install.md` names them as editable.
- **Why.** Compose's own keys, which every Compose version applies without a swarm.

#### T13. Rights on tables an image does not know

- **Choice.** `packages/db/src/database-roles.ts` takes its list of tables from the image's own schema rather than from the database, and leaves every other table's rights alone.
- **Why.** The image knows which tables its code uses.

#### T14. The contract Action's failures

- **Choice.** `actions/contract/src/action.ts` turns each of the five cases into a warning annotation and a job summary, and keeps the checksum check as the one failure.
- **Why.** The Action already fails open on an unreachable install; the cases join that path.

#### T15. The list of security events joins with its first action

- **Choice.** The coverage checks read a requirement's list as the newest change in progress that modifies it words it (`planFor` in `tools/repo-checks/src/plan.ts`), so a change that adds a bullet to activity-log's list of security events fails `pnpm check:security-events` until `tools/repo-checks/security-events.json` names it. This change therefore states D55 (82) in teams-and-roles' "Teams", and the task that builds it adds the bullet to this change's activity-log delta and the item to the committed list in the same commit, with the events' tests.
- **Why.** The specs and the committed list never disagree on `main`.
- **Alternatives.** Adding the bullet now, which would fail the check until the events are built.

#### T16. Exceptions to the release age

- **Choice.** A committed list in `tools/repo-checks` records each exception: the package, the exact version, the advisory and the day the version turns 7 days old. A check fails when `pnpm-workspace.yaml` excludes from the release age a version the list does not record, or one whose day has passed; the API-compatibility workflow's label step requires `release-age-exception` on a pull request that adds an exception; the release notes of the main change's 29.2 list the exceptions a release carries.
- **Why.** The exclusion that pnpm needs becomes reviewable, dated and temporary.
- **Alternatives.** An exclusion with no record, which would outlive its reason.

#### T17. Mirrors and the mappings that made them

- **Choice.** Each tracker mapping has an id of its own, which the column's default gives every new mapping, and each mirror row keeps the id of the mapping that made it (D55 (75)). The mirror job of `packages/commands/src/mirrors.ts` writes only to the mirrors whose mapping holds: the request's issue is the one its target team's mapping made, a reassignment's notice goes only to an issue whose mapping holds, and a later mapping of the team, even to the same place, makes issues of its own. It makes a new issue only for a request that reached its team's point after the mapping was made: a claim there, which the request holds now or which came after its last reassignment, or, for a team that mirrors on open, its opening or its last reassignment, which moved it into the team. "After" is by commit, not by time: a mapping records the number of the org's last event when it is made, read once its row is inserted while it holds the event counter until it commits (the main change's T5), and an event of the request counts as after the mapping when its number is greater. A write whose event is numbered at or below that number committed before the mapping and could not see it, so it sent no mirror job; one whose event is numbered above it waited for the mapping to commit, then saw it and sent the job; so the job counts each write as the write's own wake-up did, wherever the write's transaction began. Times could not do this: an event's time is when its transaction began, which says nothing of whether its write saw the mapping. Before each write to an issue, the job checks that the mapping holds, so a mapping removed while a job runs stops its writes after the one under way. A tracker "Done" proposes only for an issue whose mapping holds (`tracker-changes.ts`). Existing data: a mapping made before the id has none, and a mirror made before keeps none; such a mirror belongs to its team's mapping of the same place made before it, which holds for every mirror an install made, while a later mapping, made after the mirror, does not take it over. A mapping made before the event number has none either, and the job compares the request's events' times with its `created_at` instead. The migrations only add the three columns and move the mirror's unique key to include the mapping, so the previous image still runs, and no data is changed.
- **Why.** The mapping is what the team set up; tying each issue to it is what makes a removal stop the writes and a new mapping start afresh, which a place cannot tell apart.
- **Alternatives.** *Matching by place, as built:* a new mapping to the same place took the old issues over, and a reassignment's notice reached a removed mapping's issue. *Comparing times:* a claim whose transaction began before the mapping but committed after it saw the mapping and sent the job, which then counted the claim as before the mapping, so the request never got its issue. *A foreign key that clears a removed mapping's mirrors:* a cleared tie could not be told from a mirror made before the tie. *Backfilling the ids of existing mirrors:* a data change that a migration never makes, for mirrors the time rule already places.

### Where the specs leave room

- The wording of fixed lines and pages: the sentences of the webhook banner and email that name a removed webhook in item (6) (T2), the refusal page of item (7), the hooks' upgrade line of item (52), the system message of item (71) and the receipts of item (81), as long as each says what its rule names.
- The order of a `directory` page beyond team key and API name, and how its cursor is encoded.
- How a member dismisses a WARN digest in the web UI.
- The title of the `busy` row and its `Retry-After` value, which T1 sets at 5 seconds.

## Risks / Trade-offs

- [The cap of item (5) refuses honest large bodies in a burst] → A GitHub delivery refused this way is redelivered, the Action fails open, and an agent retries after the `Retry-After`.
- [Slow clients hold the cap of item (5) with the bytes they send] → A body holds only its bytes that have arrived, as item (5) says since the maintainer's answer of 2026-10-12, so a request that declares a length and sends nothing holds none of the cap; a client that sends 64 MiB of bodies and then stops holds them until the web server's own request timeout, 300 seconds in Node, ends its calls, and it has to send those bytes again to hold them again.
- [An admin switches back to webhook mode before restoring the webhook] → The next run moves GitHub to polling again, records it and shows the banner again.
- [Keys matched as written miss a lower-case mention] → People write keys as Tiehall shows them, and a link always works.
- [Only the target side's links close a request] → The requester side's link is still shown, and the target team can link the same PR.
- [Required fields on reassignment block a proposal] → The refusal lists the missing fields, and the proposer adds them first.
- [A new reader starting at the web inbox's cursor skips old history] → The history stays readable on every request; only what counts as new changes.
- [The amended label rule is stretched] → It applies only before the first release, and only to a break that an approved OpenSpec change names.
- [The release-age exception lets a hurried version in] → It covers exactly the advisory's fixed version, after review, with a label, a changelog entry and an exclusion that is removed after 7 days.
- [The Compose memory limit is too low for a large install] → It is several times the app's use, and the docs say how to raise it.

## Migration Plan

No install exists yet, so no data is migrated in place. The code changes are in tasks.md, with migrations for whether the banner about GitHub's webhook was raised by a removed webhook (T2), receipts of confirmed actions (T11), a mirror's gone state (T10), the mapping each mirror keeps and the event number each mapping keeps (T17), workflow bindings without their ref (T8), the last day a digest covered (T7), and the bounds of a token's label, a team's intake notes and agent clients' metadata. Public contracts change: the error model gains `busy`; `/mcp` refuses a foreign `Origin`; `list_inbox` changes its default; `proposals.propose` answers a withdrawal with 200; the wait entry's fields are renamed; `events.read` and `events.acknowledge` leave `/api/v1`; `requests.get` gains `untrusted.api` and deprecates `providerChange.api`; the packet schema gains URL patterns and optional provider fields. Each regenerates the OpenAPI document, the MCP tool snapshot or the packet schema, with its changelog entry.

This change is archived after `add-tiehall-oss-v1`, whose requirements it modifies, and after `spec-catch-up`, `request-body-limit`, `github-app-reachability`, `github-layer-hardening` and `image-os-security-updates`, whose texts of the same requirements it starts from. Archiving in that order keeps every change's sentences.

## Open Questions

- **IPv6 for the sign-in service's own limits** (D55 (14), (24)). Whether the token, authorization, revocation and sign-in callback limits, and the limit on the CLI's polls, also count an IPv6 client by its /64, as registrations now do; they count each address today.
- **Settings for the numbers named here** (D55 (5), (48), (55)). Whether an operator may change the cap on bodies in flight, the digest's 7 days or the Compose limits in `.env`; the Compose limits are edited in `compose.yaml`, and no `.env` key is added.
- **The removed webhook's own sentences** (D55 (6), T2). Whether the banner and the email about GitHub's webhook keep, for a removed webhook, the sentences that name it and say how to add it back, and the column `github_app.webhook_removed` of the migration `0096_record_a_removed_github_webhook.sql` that tells them apart from a given-up delivery's, as built after the approval below. The alternative is D50 (15)'s sentences for both, as T2 said when it was approved, which tell the admins that Tiehall gave a delivery up after asking GitHub 5 times when no delivery was given up, and need no column.
- **Restoring a removed webhook from Tiehall** (D55 (6)). Whether Tiehall could add the webhook back through GitHub's API, which `github-app-reachability`'s Open Question on setting the webhook leaves open.
- **The security policy's fallback contact** (D55 (84)). Which address it names, once the project has its own organization.
- **Who else gets a receipt of a trust change** (D55 (81)). Answered at the approval below: the receipt of a role change or a member's removal goes only to the person who confirmed it, as every other receipt does, and no other admin gets one.

## Decisions to approve

**Approved by the maintainer on 2026-10-12:** every item below, with its recommended option, as written here; item 14 as worded here, with the CLI's polls under a limit of their own, 60 from one address in any minute, and every limit counting the past window's calls. The open question on item 81 is answered: the receipts of a role change and of a member's removal go to the person who confirmed them only. Item 59 names the first character of an API's name as the maintainer answered the same day: a lower-case letter or a digit, as the code and its published pattern have it. Item 5 counts a declared body's bytes as they arrive, as a chunked body's are, instead of its declared length from when its head arrives, as the maintainer answered the same day to the open question "Bodies declared and not sent", so a request that declares a length and sends nothing holds none of the cap; each route keeps its own limit, and a body whose bytes would pass the cap as they arrive still gets 503 `busy` with `Retry-After: 5`. Item 43 is narrowed by item (4) of `findings-from-claude-code-run`, approved the same day: `whats_new`, `tiehall updates`, the wait endpoint and the hooks leave out what the user's agents did and keep what the user did in the web UI, while the web inbox's update feed and the daily digest leave out every event of the user; where both are built, that item governs, and task 1.35 is built with that change's task 1.3.

1. On the page routes other than request URLs and intake pages, an `Accept` header asks for HTML only when it names `text/html` with a quality above 0.
2. The public-api scenario "A web form over the limit" says that a browser gets the 413 as a page and any other caller gets the problem.
3. `github-layer-hardening`'s T5 names `request-guard.ts` and `page-routes.ts` among the users of the refusal renderer.
4. `request-body-limit`'s Goals and Non-Goals name only the Jira webhook as open.
5. One web process reads at most 64 MiB of request bodies at once, counting each body's bytes as they arrive, and a body whose bytes do not fit gets 503 with the new problem type `busy` and `Retry-After`.
6. In webhook mode with a stored webhook secret, a 404 for the delivery log moves GitHub to polling with a `github.mode_changed` event and shows the webhook banner, whoever last set the mode.
7. A sign-in that GitHub's membership look-up fails gets 502 `integration-unavailable`, admits no one and records no refusal event.
8. `github-layer-hardening`'s T8 names `github_redeliveries.given_up_at` among the columns its migration adds.
9. Task 21.10's banners show to the admins and to the members of each team whose mirrors go through the integration.
10. Approving an agent client and revoking a grant write their security events in the same transaction, and tasks 15.10, 20.3 and T8 say so.
11. A token check reads the signing keys in the same process with no HTTP call, and T9 and task 15.2 say so.
12. An authorization request that names `offline_access` is not refused for it, and Tiehall ignores the scope while giving every grant a refresh token.
13. An authorization request that names no scope gets `requests:read` and `requests:write`, never `contracts:report`.
14. From one client address, the token endpoint takes 20 calls in any minute besides the CLI's polls, which take 60 in any minute of their own, and the authorization and revocation endpoints 30 each, each limit counting the past minute's calls, and the next call gets 429 with `Retry-After`.
15. A registration that names no type and whose every redirect URI is local or an app scheme is a native client's.
16. Every registration attempt counts toward the 10 an hour, refused ones included.
17. `/api/v1` shares the `/mcp` resource and its metadata, and its challenges point there.
18. A personal access token's label has 1 to 100 characters with no control character, is shown quoted and never appears in a reminder.
19. While the PAT switch is off, creating a personal access token gets 403 `personal-access-tokens-off`, and the page offers no form.
20. PAT reminders fall on UTC days, catch up at the next run, skip days before the token existed, go to members only and stay listed until the token expires or is revoked.
21. Each member has one CLI grant, which every login updates, and the tokens page says that revoking it signs the CLI out on every machine.
22. The CLI approval's review page is reached only from the device approval page, and typed codes may use lower case, no dash or spaces.
23. An authorization request without `resource` is taken as naming `TIEHALL_URL/mcp`, so every issued token works on both endpoints.
24. The registration limit counts an IPv6 client by its /64 prefix.
25. A `client_id` URL has at most 1,024 characters, a client's name 1 to 100, and a client at most 10 redirect URIs of at most 2,048 characters, refused with `invalid_client_metadata` or `invalid_client` and never a 500.
26. A request to `/mcp` whose `Origin` header names another origin gets 403 `forbidden`.
27. A `get_request` page's 32,000 characters count the markdown and the structured content together.
28. `list_inbox` returns requests not in a terminal state by default, with `state` to ask for any one state.
29. `whats_new` carries no read-only hint, because it can move a read cursor.
30. For stable operations and their tools, the compatibility checks fail on removals that the diff engine rates as warnings too.
31. A request state is bound to the tool and arguments of the call that created the proposal, and a retry with other arguments gets 403.
32. A removed member's `initialize` and `tools/list` still answer, and their tool calls return the removed member's tool error.
33. A removed member's retry gets the removed member's refusal before its request state is checked.
34. Every CLI command calls a public REST operation at `beta`, the CLI's new operations stay public, and the web UI's two list reads stay internal.
35. The CLI's version is checked on `/api/v1` only, so an old CLI can sign in and is told to upgrade at its first command.
36. Every string in the agent view and the CLI's output loses C0 controls but tab and line feed, DEL and C1 controls.
37. Withdrawing a proposal through `POST /api/v1/proposals` answers 200 with the ended proposal.
38. A request URL or intake page asked for with a token that negotiates HTML gets markdown, and HTML goes only to sessions.
39. Intake notes have at most 4,000 characters, and `directory` answers in pages of at most 50 teams, 50 APIs and 32,000 characters.
40. An intake page under an old key answers 307, and its 401 names the MCP tool `directory`.
41. A team's required fields also refuse a reassignment proposal into it and a packet revision that drops one, with contract reports exempt.
42. Other methods on a request URL get 404 `route-not-found`, a `POST` keeps its method across the 307 and gets a one-off `ETag`, and encoded unreserved characters name the same URL.
43. The user's own events are left out of `whats_new`, `tiehall updates`, the wait endpoint, the hooks, the digest and the web inbox's update feed.
44. A new reader starts at the user's web inbox cursor, and the hooks read after the furthest cursor of the user's CLI and MCP clients.
45. A request stays in a user's updates once they have acted on it in any recorded way.
46. Of a request to a user's team, only its opening and a reassignment into the team reach the user through the team.
47. The wait entries use `requestKey` and `teamKey`, changed before the first release under the `api-breaking` label, whose rule gains that case for breaks an approved OpenSpec change names.
48. The digest covers every ended UTC day since the last one, at most 7, in one email, and notices may carry identifiers and Tiehall's fixed words, never anyone's text.
49. A question's immediate email never goes to its poster and is sent even with the digest off.
50. `events.read` and `events.acknowledge` become internal before the first release, leaving `whats_new` and the wait endpoint as the readers' API.
51. The spec names `tiehall hook session-end`, the watch's shared mark and exit code 1, skipped unreadable entries, the digest's 50 entries and "more" line, and the setting that lowers the wait cap.
52. When the install refuses the hooks as too old, the SessionStart digest prints one fixed line asking to run `npm install --global tiehall@latest`.
53. `admin grant` before setup completes changes nothing and records nothing.
54. An older image's migrate step leaves the rights on tables it does not know unchanged.
55. `compose.yaml` limits the app to 2 GiB and 512 processes and the migrate step to 512 MiB and 128 processes, documented as editable.
56. Registering an API under an unregistered one's name keeps its declarations only when its repository and provider team are unchanged.
57. The outbound list names `token.actions.githubusercontent.com`.
58. A CI caller is refused on other operations before keys are read, proves its token before its repository is judged, and spends its `jti` once its token is accepted.
59. `contract.report` refuses unknown fields, takes at most 1,000 changes, names its PR by number and its API by a name of 1 to 100 of `[a-z0-9._-]` that starts with a letter or a digit.
60. Declaring, removing and re-confirming a team's consumption of an API are domain events in the activity log, on no agent surface.
61. A workflow binding names the repository and workflow file, matched without the ref, and a PR run must report its own PR number.
62. The contract Action fails open with a warning and job summary on a blocked download, external `$ref`s, a deleted document, a 400 or a 413, and fails only on a checksum mismatch.
63. A hand-attached contract section may name no provider PR or status, changed through the packet's breaking path.
64. An update whose classified changes equal the last ones adds no revision, message or notice.
65. Members who opted in to a team's requester emails get that team's requests' updates in their digest.
66. Request keys are matched only as written, so `renovate/node-22` and `utf-8` mention nothing.
67. Only links made by the claimant or a target-team member count for close on merge.
68. Breaking changes that return after a system withdrawal open a new request for that team.
69. A WARN digest leaves a member's standing list when they dismiss it or after 7 days.
70. The WARN digest gives counts, the API's name and the PR's link, and the scenario says so.
71. The provider PR's merge adds one system message to each open request of its change set, and the packet keeps the reported status.
72. A same-second claim or link counts as before the merge, a reopened PR's later reports reopen withdrawn teams, attribution follows D50 (10), and uncovered repositories only link.
73. A key counts as mentioned before the merge only when read while the PR was open, except in the branch name.
74. A GitHub close as `duplicate` is not a tracker "Done".
75. Removing a mapping stops writes to its issues, a new mapping starts new ones, and nothing is backfilled.
76. A newer mirror job supersedes a dead-lettered one and clears its banner when it succeeds.
77. D50 (10) is amended so that a polled change acts for the account GitHub names, such as `closed_by`, while that user is a member.
78. A reassignment undone before its mirror job runs writes nothing to the trackers.
79. A mirror issue that GitHub answers with 404 or 410 is marked gone, written no more, noted once on the request, and its dead letter cleared.
80. An API's name is fenced as its provider team's text everywhere, with `untrusted.api` added and `providerChange.api` deprecated.
81. Every confirmation, trust changes included, gives a receipt in the standing list and by email, and the docs say so again.
82. Adding a person to a team and removing one are security events, with no confirmation step.
83. The packet schema's URL fields carry an `http` or `https` pattern, changed through the packet's breaking path before publication.
84. `SECURITY.md`'s terms stand as written, and a fallback contact is added once the project has its own organization.
85. The rule on the image's patches names Debian's signed archives for the base image's release.
86. A fixable HIGH or CRITICAL finding outside Debian may take the advisory's fixed version before 7 days through a reviewed, labelled pull request recorded in the changelog.

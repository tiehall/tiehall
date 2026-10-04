# Spec Delta: requester-loop

## Purpose

States which events are a user's updates, where a new reader's cursor starts and which cursor the hooks follow, the readers' API, the names of the wait entries, the hooks as built and the upgrade line, the digest's days, who gets a question's email, and the digest of a team that requests. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: The pull readers

`whats_new`, `tiehall updates` and the web inbox's update feed SHALL each return the domain events that came after the reader's cursor, and SHALL let the reader acknowledge them. Each reader SHALL use the read cursor of its own user and client, and SHALL serve only the domain events that reader is allowed to see, as the requests capability defines for cursors and event reads; a reader that has no cursor yet SHALL start where the requests capability defines, at the user's web inbox cursor. These readers and the long-poll wait endpoint SHALL be the readers' whole API on the agent surfaces: no agent surface SHALL offer a read or an acknowledgement of the event log itself, which would serve events outside the scope below and move a reader's cursor outside it. Of those events, each reader serves the narrower set that the requirement on what `whats_new` covers defines: `whats_new` and `tiehall updates` serve the user's updates, and the web inbox's update feed serves the same updates plus the events on requests whose requesting team is one of the user's teams. What else the web inbox lists is defined by the requirement on the web inbox. Any text in these results that Tiehall did not generate SHALL be fenced as the agent-safety capability defines.

Source: D8; D28 #58; D29 (5); D55 (44), (50); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: Acknowledging through whats_new

- **WHEN** Sam's agent calls `whats_new`, gets the question event on `FE-142`, acknowledges it, and calls `whats_new` again
- **THEN** the second result no longer includes that event

#### Scenario: The CLI keeps its own place

- **WHEN** Sam's Claude Code agent has acknowledged the question event on `FE-142` through `whats_new`, and Sam then runs `tiehall updates`
- **THEN** the CLI output still lists the question event on `FE-142`

#### Scenario: Other teams' text is fenced

- **WHEN** a pull reader's result includes text that team FE wrote in `FE-142`
- **THEN** that text appears only inside a fence

#### Scenario: Security events are not updates

- **WHEN** an admin changes the role of Sam, and Sam's agent then calls `whats_new`
- **THEN** the result includes no event about the role change

#### Scenario: No raw read of the event log

- **WHEN** a client reads `https://tiehall.example.com/api/v1/openapi.json` and lists the tools of `https://tiehall.example.com/mcp`
- **THEN** neither offers an operation that reads or acknowledges the event log, other than `whats_new`, `tiehall updates` and the wait endpoint
- **AND** a call to `GET /api/v1/events` with a valid token answers 404

#### Scenario: A new client starts where the web inbox is

- **WHEN** Sam has acknowledged in the web inbox every event up to number 400, and a new MCP client of Sam's calls `whats_new` for the first time
- **THEN** the result holds no update numbered 400 or lower

### Requirement: What whats_new covers

`whats_new` SHALL return the domain events on the requests whose requesting user is its user, the requests its user has claimed and the requests its user is accountable for, plus the new requests addressed to the user's teams. The requesting user of a request is the user who opened it, or, for a contract-change request, the user whom the contract-changes capability names as its requester: the member of the install whose GitHub account authored the provider PR. A request's events SHALL be in the user's updates for good once the user opened it, claimed it, is the accountable human of a proposal on it, or was the accountable human of any event on it, such as a message they or their agent posted or a PR they linked. Of a request addressed to one of the user's teams, only its opening and its reassignment into that team SHALL reach the user's updates through the team; its later events reach them only once the request is theirs by one of the rules above. Every event whose accountable human is the user themself, what they or their agents did, SHALL be left out, so that a user's updates are what others did. Events on other requests of the install SHALL NOT appear in it. `tiehall updates` runs the same operation as `whats_new`, as the public-api capability requires of every operation, so it SHALL return the same updates. The Claude Code hooks read these updates with the CLI's cursor, as the requirement on the hooks defines, and the wait endpoint wakes only for them, so that no update reaches a reader only through a push path.

The web inbox's update feed SHALL use the same scope as `whats_new`, plus the events on the requests whose requesting team is one of the user's teams, as the requirement on when the requester is a team defines. Events on any other request of the install SHALL NOT appear in the update feed, even though the user may open those requests.

Source: D14; D28 #58, #60, #62, #75; D29 (5); D55 (43), (45), (46); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The author of a provider PR gets the consumers' questions

- **WHEN** Deniz is the requester of the contract-change request `FE-150` because the GitHub account they sign in to Tiehall with authored provider PR #310, and FE's agent posts a question on `FE-150`
- **THEN** the next `whats_new` call by Deniz's agent includes the question event on `FE-150`, though Deniz did not open `FE-150` themselves

#### Scenario: A request the user claimed

- **WHEN** Dana has claimed `FE-142`, which Sam opened, and Sam posts an answer on it
- **THEN** the next `whats_new` call by Dana's agent includes the answer event on `FE-142`

#### Scenario: A new request to the user's team

- **WHEN** Sam opens `FE-143` to team FE, of which Dana is a member
- **THEN** the next `whats_new` call by Dana's agent includes the new request `FE-143`

#### Scenario: A request the user has no part in

- **WHEN** Lee, a member of team BE, opens `OPS-7` to team OPS, and Dana is in neither team, has not claimed `OPS-7` and is not accountable for anything on it
- **AND** a question is then posted on `OPS-7`
- **THEN** no event on `OPS-7` appears in Dana's `whats_new`
- **AND** no event on `OPS-7` appears when Dana runs `tiehall updates`
- **AND** no event on `OPS-7` appears in Dana's web inbox, though Dana can open `OPS-7` in the web UI

#### Scenario: The web inbox shows the user's updates

- **WHEN** Dana has claimed `FE-142`, which Sam opened, and Sam posts an answer on it
- **THEN** Dana's web inbox lists the answer event on `FE-142`

#### Scenario: The web inbox adds requests whose requester is the user's team

- **WHEN** team PAY is the requester of `FE-150` because the author of the provider PR is not a member of the install, Kim is a member of PAY and not of FE, has not claimed `FE-150` and is not accountable for anything on it, and FE's agent posts a question on `FE-150`
- **THEN** Kim's web inbox lists the question event on `FE-150`
- **AND** Kim's `whats_new` does not include it

#### Scenario: A user's own write is not their update

- **WHEN** Dana has claimed `FE-142`, which Sam opened, and Dana's agent posts a question on it
- **THEN** the next `whats_new` call by Dana's agent does not include the question event
- **AND** the next `whats_new` call by Sam's agent includes it

#### Scenario: A request the user took part in stays in their updates

- **WHEN** Dana, a member of team BE only, posted a comment on `OPS-7`, which Lee opened to team OPS, and Lee later posts an answer on `OPS-7`
- **THEN** the next `whats_new` call by Dana's agent includes Lee's answer

#### Scenario: A team's new request reaches its members once

- **WHEN** Sam opens `FE-143` to team FE, of which Dana is a member, and Sam later posts a comment on `FE-143`, which nobody has claimed
- **THEN** Dana's `whats_new` includes the opening of `FE-143`
- **AND** it does not include Sam's comment

### Requirement: The long-poll wait endpoint

Tiehall SHALL offer a long-poll endpoint, `GET /api/v1/events/wait`, that takes a `cursor` parameter, answers as soon as an event in the reader's updates, as the requirement on what `whats_new` covers defines, exists after that cursor, and otherwise holds the call open for at most 60 seconds. Its answer SHALL carry identifiers and server text only, never message or packet text: a list of entries, each with the event's `seq`, its `type`, the `requestKey`, the `teamKey` of the request's target team and the request's `url`, named as the rest of the API names its fields, and the cursor. The reader then pulls the content. When the hold ends with no new event, the endpoint SHALL answer 200 with an empty list and the cursor, and the reader's stored cursor SHALL NOT move. While the app shuts down, as it does when an upgrade restarts it as the self-host-install capability defines, the endpoint SHALL end open waits with 503 and `Retry-After: 0`.

Source: D28 #59; D55 (43), (47); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A question arrives during a wait

- **WHEN** Sam's client is waiting on `/api/v1/events/wait` with its cursor and an agent in team FE posts a question on `FE-142`
- **THEN** the wait answers with an entry that holds the new event's `seq` and `type`, the `requestKey` `FE-142`, the `teamKey` `FE` and the `url` `https://tiehall.example.com/FE-142`
- **AND** the answer contains none of the question's text

#### Scenario: An update is already waiting

- **WHEN** a client calls `/api/v1/events/wait` while an event in its user's updates already exists after its cursor
- **THEN** the endpoint answers at once

#### Scenario: A request the user has no part in does not wake the wait

- **WHEN** Dana's client is waiting on `/api/v1/events/wait`, and a question is posted on `OPS-7`, a request Dana did not open or claim, is not accountable for anything on and that is not addressed to Dana's teams
- **THEN** the wait does not answer because of that question

#### Scenario: Nothing happens

- **WHEN** a client calls `/api/v1/events/wait` and no new event arrives
- **THEN** no later than 60 seconds after the call, the endpoint answers 200 with an empty list and the cursor
- **AND** the reader's stored cursor does not move

#### Scenario: The app shuts down during a wait

- **WHEN** a client is waiting on `/api/v1/events/wait` and the operator restarts the install for an upgrade
- **THEN** the wait answers 503 with `Retry-After: 0`

#### Scenario: The user's own write does not end a wait

- **WHEN** Dana's client is waiting on `/api/v1/events/wait`, and Dana's agent posts a comment on `FE-142`, which Dana has claimed
- **THEN** the wait does not answer because of that comment

### Requirement: Claude Code SessionStart digest

The Claude Code plugin SHALL register a SessionStart hook that runs `tiehall hook session-start`, which prints a digest of the user's updates that are new and not yet announced, as the requirement that news is announced once defines. Each entry SHALL carry only the server text the agent-safety capability allows in push notices: the request key, the event type, the team and the request URL. The agent then pulls the content. The digest SHALL list at most 50 updates and then, when more wait, one line in Tiehall's words that says so. When the install answers the hook's call with `upgrade-required`, as the public-api capability defines for a CLI below its minimum, the digest SHALL print one fixed line that asks the user to run `npm install --global tiehall@latest`, and nothing else.

Source: D55 (51), (52); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: Two updates waiting

- **WHEN** Sam starts a Claude Code session with the plugin installed while two updates on Sam's requests are new and not yet announced
- **THEN** the hook prints two entries, each with a request key, an event type, a team and a request URL
- **AND** it prints no text that any user wrote

#### Scenario: More updates than the digest lists

- **WHEN** Sam starts a Claude Code session with the plugin installed while 60 updates on Sam's requests are new and not yet announced
- **THEN** the hook prints 50 entries and then one line that says that more updates wait

#### Scenario: An old CLI asks for an upgrade

- **WHEN** Sam's CLI is older than the minimum the install keeps, and Sam starts a Claude Code session with the plugin installed
- **THEN** the hook prints exactly one line, which asks Sam to run `npm install --global tiehall@latest`
- **AND** it prints no update

### Requirement: Claude Code Stop-hook waiter

The plugin SHALL register a Stop hook, run with Claude Code's `asyncRewake` option, that runs `tiehall hook wait`. The waiter SHALL long-poll the wait endpoint; SHALL stop after at most 30 minutes, a cap the CLI enforces itself; SHALL hold a per-session lock, which the CLI enforces, so that at most one waiter waits for a Claude Code session; and SHALL exit with code 2 when news that has not been announced arrives, which wakes Claude with a reminder made only of the server text the agent-safety capability allows in push notices. Everything the waiter writes to its error output reaches Claude, so it SHALL write nothing there but that reminder. A new waiter SHALL be armed at the end of every turn. When a wait ends with an empty answer, or with 503 and `Retry-After: 0` while the app shuts down, the waiter SHALL call the wait endpoint again and keep waiting within the same 30-minute cap. The Stop hook SHALL be registered with a timeout longer than the cap, 1900 seconds, so that Claude Code does not end the waiter before the cap. The lock SHALL be released when the waiter exits and when the Claude Code session ends, through `tiehall hook session-end`, which the plugin's SessionEnd hook runs, and a waiter whose session has ended SHALL exit. The environment variable `TIEHALL_HOOK_WAIT_CAP_SECONDS` MAY lower the 30-minute cap, and SHALL NOT raise it. An entry of the wait's answer that the CLI cannot read SHALL be skipped. When the install answers the waiter with `upgrade-required`, the waiter SHALL exit without writing anything and without code 2.

Source: D28 #59; D55 (51); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: News wakes Claude

- **WHEN** Sam's Claude Code session is idle with a waiter armed, and an agent in team FE posts a question on `FE-142` within 30 minutes
- **THEN** `tiehall hook wait` exits with code 2
- **AND** Claude wakes with a reminder that names `FE-142`, the event type, the team FE and the request URL, and no text that any user wrote

#### Scenario: News late in the wait still wakes Claude

- **WHEN** Sam's Claude Code session is idle with a waiter armed, and 25 minutes after the waiter started an agent in team FE posts a question on `FE-142`
- **THEN** the waiter is still running when the question is posted
- **AND** it exits with code 2 and Claude wakes

#### Scenario: The 30-minute cap

- **WHEN** 30 minutes pass after a waiter starts and no new event arrives
- **THEN** the waiter exits without code 2
- **AND** Claude is not woken

#### Scenario: One waiter per session

- **WHEN** a turn ends while an earlier waiter of the same Claude Code session is still waiting
- **THEN** only one waiter keeps waiting for that session

#### Scenario: Armed again after each turn

- **WHEN** Claude finishes the turn it was woken for
- **THEN** a new waiter is armed for that session

#### Scenario: The session ends

- **WHEN** Sam ends a Claude Code session while its waiter is waiting
- **THEN** the waiter exits
- **AND** the session's lock is released

#### Scenario: A restart during a wait

- **WHEN** the server ends the waiter's long-poll with 503 and `Retry-After: 0` 10 minutes after the waiter started, because the install is shutting down for an upgrade
- **THEN** the waiter calls the wait endpoint again and keeps waiting
- **AND** it still stops no later than 30 minutes after it started

#### Scenario: An empty answer during a wait

- **WHEN** the wait endpoint answers the waiter 200 with an empty list 5 minutes after the waiter started
- **THEN** the waiter calls the wait endpoint again and keeps waiting
- **AND** it still stops no later than 30 minutes after it started

#### Scenario: A lower cap

- **WHEN** `TIEHALL_HOOK_WAIT_CAP_SECONDS` is 600 in the waiter's environment, and no new event arrives
- **THEN** the waiter exits without code 2 no later than 10 minutes after it started

#### Scenario: The cap is never raised

- **WHEN** `TIEHALL_HOOK_WAIT_CAP_SECONDS` is 7200 in the waiter's environment, and no new event arrives
- **THEN** the waiter exits no later than 30 minutes after it started

#### Scenario: An old CLI's waiter stays silent

- **WHEN** Sam's CLI is older than the minimum the install keeps, and a turn ends
- **THEN** the waiter exits without code 2
- **AND** it writes nothing to its error output

### Requirement: The hooks read with the CLI's cursor and acknowledge nothing

`tiehall hook session-start` and `tiehall hook wait` SHALL read the user's updates after the furthest of the read cursors of the user's CLI client and of the user's MCP clients on that install, and SHALL NOT acknowledge any event. The agent acknowledges events through `whats_new` or `tiehall updates`, and an acknowledgement through either quiets the hooks.

Source: D28 #60; D55 (44); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The digest acknowledges nothing

- **WHEN** the SessionStart hook prints a digest of two new updates on Sam's requests
- **THEN** the cursor of Sam's CLI client has not moved
- **AND** Sam's next `tiehall updates` still lists both updates

#### Scenario: The waiter acknowledges nothing

- **WHEN** `tiehall hook wait` exits with code 2 because a question was posted on `FE-142`
- **THEN** none of Sam's read cursors has moved past the question event on `FE-142`
- **AND** the next `whats_new` call by Sam's agent includes it

#### Scenario: The hooks follow the CLI's cursor

- **WHEN** Sam has acknowledged the question event on `FE-142` through `tiehall updates` and then starts a Claude Code session with the plugin installed
- **THEN** the SessionStart digest does not list that event

#### Scenario: The hooks follow an acknowledgement through whats_new

- **WHEN** Sam's agent has acknowledged the question event on `FE-142` through `whats_new`, and Sam then starts a new Claude Code session with the plugin installed
- **THEN** the SessionStart digest does not list that event
- **AND** Sam's next `tiehall updates` still lists it, because the CLI keeps its own place

### Requirement: The plugin monitor fallback

If Claude Code's `asyncRewake` on the Stop hook cannot wake Claude, the plugin SHALL offer a plugin monitor that runs `tiehall watch` in place of the Stop-hook waiter. The monitor SHALL be marked experimental, SHALL run only in Claude Code's interactive CLI, and SHALL need no admin setup. Its output SHALL carry only the server text the agent-safety capability allows in push notices. `tiehall watch` SHALL share the announced mark of the hooks, as the requirement that news is announced once defines, and SHALL exit with code 1 when the install refuses it.

Source: D55 (51); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The fallback reports an update

- **WHEN** the plugin uses the monitor fallback and an agent in team FE posts a question on `FE-142` during Sam's interactive Claude Code session
- **THEN** `tiehall watch` reports the update with the request key, the event type, the team and the request URL only

#### Scenario: The monitor shares the announced mark

- **WHEN** the SessionStart digest listed the question on `FE-142`, and the monitor then runs in the same session
- **THEN** `tiehall watch` does not report that question again

#### Scenario: A refused monitor exits

- **WHEN** the install refuses the call of `tiehall watch`, because the grant of Sam's CLI was revoked
- **THEN** `tiehall watch` exits with code 1

### Requirement: Email for people, only when SMTP is set

Tiehall SHALL send email only when the install has SMTP settings, as the self-host-install capability defines; without them it SHALL send no email, and every notice SHALL still reach people through their web inbox. When SMTP is set:
- When a question is posted on a request, Tiehall SHALL email the person it is asked of right away: the requester when the target team's side asks, and the claimant when the requester's side asks. A question that the requester's side posts on a request that nobody has claimed is asked of no one person, so it SHALL be emailed to nobody right away. The email about a question SHALL never go to the person who posted it, and SHALL be transactional: it SHALL be sent even when the person it is asked of has turned the digest off.
- Tiehall SHALL gather every other update into a daily digest email, sent at most once per UTC day, after the UTC days it covers have ended: one email that covers every UTC day that has ended since the last digest the user was sent, at most the 7 latest, whose subject names the days it covers. The digest SHALL leave out the user's own events, as the requirement on what `whats_new` covers defines.
- Users SHALL be able to turn the digest off, but SHALL NOT be able to turn off transactional email, such as proposal notices and receipts. Turning the digest off SHALL also stop the daily WARN digest email that the contract-changes capability defines, for that user; it SHALL NOT stop the emails that ask a consuming team to re-confirm its consumer-map declarations every 90 days, which the contract-changes capability also defines.
- Emails SHALL go to the primary verified email address of the user's GitHub account.
- Email subjects SHALL carry only the server text the agent-safety capability allows in push notices.

Source: D9; D28 #61, #73; D29 (6); D55 (43), (48), (49); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A question to the requester is emailed right away

- **WHEN** the install has SMTP set, and an agent in team FE posts a question on `FE-142`, which Sam opened
- **THEN** Sam gets an email about the question right away
- **AND** its subject holds no text that any user wrote

#### Scenario: A question to the claimant is emailed right away

- **WHEN** the install has SMTP set, Dana has claimed `FE-142`, which Sam opened, and Sam's agent posts a question on it
- **THEN** Dana gets an email about the question right away
- **AND** its subject holds no text that any user wrote

#### Scenario: A status change goes to the daily digest

- **WHEN** the install has SMTP set, and `FE-142` moves from `claimed` to `in_progress`
- **THEN** Sam gets no immediate email about it
- **AND** the change appears in the digest email Sam gets after that UTC day ends

#### Scenario: A question on an unclaimed request

- **WHEN** the install has SMTP set, `FE-143` is `open` with no claimant, and Sam, its requester, posts a question on it
- **THEN** no email about the question is sent right away

#### Scenario: Turning the digest off

- **WHEN** the install has SMTP set, Sam turns the digest off, and a proposal then waits for Sam's confirmation
- **THEN** Sam gets no digest email
- **AND** Sam still gets the email about the waiting proposal

#### Scenario: Turning the digest off covers the WARN digest, not re-confirmation

- **WHEN** the install has SMTP set, Sam, a member of team FE, has turned the digest off, a WARN-level change to an API that FE consumes is reported, and later FE's declaration for that API comes due for its 90-day re-confirmation
- **THEN** Sam gets no WARN digest email
- **AND** Sam gets the re-confirmation email

#### Scenario: Transactional email cannot be turned off

- **WHEN** Sam opens their email settings on an install with SMTP set
- **THEN** no setting there stops transactional email, such as proposal notices and receipts

#### Scenario: The address comes from GitHub

- **WHEN** the install has SMTP set, the primary verified email address of Sam's GitHub account is `sam@example.com`, and an agent in team FE posts a question on `FE-142`, which Sam opened
- **THEN** the email about the question goes to `sam@example.com`

#### Scenario: An install without SMTP

- **WHEN** the install has no SMTP settings, and an agent in team FE posts a question on `FE-142`, which Sam opened
- **THEN** Tiehall sends no email
- **AND** Sam's web inbox lists the question event on `FE-142`

#### Scenario: The poster of a question gets no email about it

- **WHEN** the install has SMTP set, Sam opened `FE-142` to team FE, of which Sam is a member, Sam has claimed it, and Sam's agent posts a question on it
- **THEN** no email about the question is sent to Sam

#### Scenario: A question is emailed with the digest off

- **WHEN** the install has SMTP set, Sam has turned the digest off, and an agent in team FE posts a question on `FE-142`, which Sam opened
- **THEN** Sam gets an email about the question right away

#### Scenario: The digest catches up after a stopped worker

- **WHEN** the install has SMTP set, the last digest Sam was sent covered 2026-11-02, the worker was stopped until 2026-11-05, and Sam had updates on 2026-11-03 and 2026-11-04
- **THEN** on 2026-11-05 Sam gets one digest email that covers both days
- **AND** its subject names 2026-11-03 and 2026-11-04

#### Scenario: The digest goes back at most 7 days

- **WHEN** the install has SMTP set, the last digest Sam was sent covered 2026-11-01, and the worker was stopped until 2026-11-20
- **THEN** the digest Sam gets on 2026-11-20 covers 2026-11-13 to 2026-11-19 only

### Requirement: When the requester is a team

When the provider team is the requester of a contract-change request, as the contract-changes capability defines for a provider PR whose author is not a member of the install, the requester loop's events on that request SHALL go to the provider team's inbox, and so to the update feed of the web inbox of every member of that team, as the requirements on what `whats_new` covers and on the web inbox define. When SMTP is set, its emails SHALL go only to the members of that team who have opted in to them. Each member SHALL choose, for each team they belong to, in their email settings in the web UI, whether they get the emails that go to that team as a requester; the choice SHALL be off until the member turns it on, and SHALL change nothing in their web inbox. A member who has turned it on SHALL also get, in their daily digest, the updates on the requests whose requester is that team. This SHALL include the proposal notices that ask the requester side for its confirmation of a two-sided commitment, as the requests capability defines; every member of the team who may give that confirmation SHALL still find the proposal waiting in the standing list of their web inbox.

Source: D14; D28 #62, #75; D29 (5); D30 (4); D55 (65); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A question reaches the team's inbox

- **WHEN** team PAY is the requester of `FE-150` because the author of the provider PR is not a member of the install, and FE's agent posts a question on `FE-150`
- **THEN** the question event on `FE-150` appears in PAY's inbox
- **AND** it appears in the web inbox of each member of PAY

#### Scenario: Only members who opted in get the email

- **WHEN** the install has SMTP set, Lee and Kim are members of PAY, Lee has opted in to these emails and Kim has not, and FE's agent posts a question on `FE-150`
- **THEN** Lee gets the email about the question
- **AND** Kim gets no email about it

#### Scenario: The team's emails are off until a member opts in

- **WHEN** the install has SMTP set, Kim has just been added to team PAY and has not changed their email settings, and FE's agent posts a question on `FE-150`, whose requester is PAY
- **THEN** Kim gets no email about the question
- **AND** after Kim turns on PAY's emails in their email settings, the next question on `FE-150` is emailed to Kim

#### Scenario: A due date waits for the team, emailed only where members opted in

- **WHEN** the install has SMTP set, Lee and Kim are members of PAY, Lee has opted in to these emails and Kim has not, and Bob, a member of team FE, proposes a due date on `FE-150` and confirms it in the web UI
- **THEN** the proposal is listed as waiting in the web inboxes of Lee and Kim
- **AND** Lee gets the proposal notice and Kim gets none

#### Scenario: An opted-in member's digest holds the team's requests

- **WHEN** the install has SMTP set, Lee and Kim are members of PAY, Lee has opted in to PAY's emails and Kim has not, and `FE-150`, whose requester is PAY, moves from `claimed` to `in_progress`
- **THEN** the digest Lee gets after that UTC day ends lists the change
- **AND** the digest Kim gets lists nothing about `FE-150`

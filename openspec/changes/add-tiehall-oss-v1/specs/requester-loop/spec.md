# Spec Delta: requester-loop

## Purpose

Defines how clarifying questions, status changes, proposal outcomes and other updates on a request reach the requester's own agent and the people involved, so that questions do not stall the work: pull as the contract, the web inbox, a long-poll wait, Claude Code hooks as the only push path, and email when the install has SMTP set up.

## ADDED Requirements

### Requirement: Pull is the contract

Every update the requester loop delivers SHALL be available by pull, through `whats_new` over MCP, `tiehall updates` in the CLI and the web inbox. Push paths SHALL only make delivery faster; no update SHALL reach its reader only through a push path.

Source: D8; D9; design.md, Decisions this change rests on; design.md, Design rules: Requester loop

#### Scenario: A question reaches the requester's agent by pull

- **WHEN** Sam, a member of team BE, has opened `FE-142`, an agent in team FE posts a question on it, and Sam's agent then calls `whats_new`
- **THEN** the result includes the question event on `FE-142`

#### Scenario: A client without hooks

- **WHEN** Sam's agent runs in Cursor, which has none of the Claude Code hooks, and calls `whats_new` after that question
- **THEN** the result includes the question event on `FE-142`

### Requirement: The pull readers

`whats_new`, `tiehall updates` and the web inbox's update feed SHALL each return the domain events that came after the reader's cursor, and SHALL let the reader acknowledge them. Each reader SHALL use the read cursor of its own user and client, and SHALL serve only the domain events that reader is allowed to see, as the requests capability defines for cursors and event reads. Of those events, each reader serves the narrower set that the requirement on what `whats_new` covers defines: `whats_new` and `tiehall updates` serve the user's updates, and the web inbox's update feed serves the same updates plus the events on requests whose requesting team is one of the user's teams. What else the web inbox lists is defined by the requirement on the web inbox. Any text in these results that Tiehall did not generate SHALL be fenced as the agent-safety capability defines.

Source: D8; D28 #58; D29 (5); design.md, Decisions this change rests on; design.md, Design rules: Requester loop; design.md, Design rules: Requests and events; design.md, Design rules: Agent safety

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

### Requirement: What whats_new covers

`whats_new` SHALL return the domain events on the requests whose requesting user is its user, the requests its user has claimed and the requests its user is accountable for, plus the new requests addressed to the user's teams. The requesting user of a request is the user who opened it, or, for a contract-change request, the user whom the contract-changes capability names as its requester: the member of the install whose GitHub account authored the provider PR. Events on other requests of the install SHALL NOT appear in it. `tiehall updates` runs the same operation as `whats_new`, as the public-api capability requires of every operation, so it SHALL return the same updates. The Claude Code hooks read these updates with the CLI's cursor, as the requirement on the hooks defines, and the wait endpoint wakes only for them, so that no update reaches a reader only through a push path.

The web inbox's update feed SHALL use the same scope as `whats_new`, plus the events on the requests whose requesting team is one of the user's teams, as the requirement on when the requester is a team defines. Events on any other request of the install SHALL NOT appear in the update feed, even though the user may open those requests.

Source: D14; D28 #58, #60, #62, #75; D29 (5); design.md, Decisions this change rests on; design.md, Design rules: Contract changes

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

### Requirement: The web inbox

Each user's web inbox SHALL have two parts:
- the update feed: the domain events that the requirement on what `whats_new` covers defines for the web inbox, read with the web inbox's own cursor and acknowledged like any pull reader's;
- the standing list: items that stay listed whether or not the user has acknowledged anything in the update feed. It SHALL hold every proposal that waits for a confirmation the user may give, and the receipts of the user's confirmations and undos, as the requests capability defines; and, for each team the user belongs to, that team's daily WARN digests and the requests to re-confirm its consumer-map declarations, as the contract-changes capability defines.

A proposal waits for its accountable human first; once that human has confirmed a commitment that needs a confirmation from each side, it waits for each person who may give the other side's confirmation, as the requests capability defines for two-sided commitments. Acknowledging events in the update feed SHALL NOT remove an item from the standing list. Who a proposal waits for SHALL be decided at each moment, so the standing lists follow changes in who may give a waiting confirmation, as the requests capability defines. A waiting proposal SHALL stay listed as waiting for a user until it no longer waits for that user's confirmation: once the user has confirmed it, once it has taken effect, once the user may no longer give the confirmation, or once it ends, as the requests capability defines. A receipt that says a commitment waits for the other side SHALL show how the proposal ended once it ends without taking effect. A re-confirmation request SHALL stay listed until its declaration is re-confirmed. A team's inbox, which the other capabilities name, SHALL be what the web inbox of each member of that team shows for the team: the team's items in the standing list, and in the update feed the events on requests whose requesting team is that team.

Source: D23; D28 #62, #73; D29 (5); D30 (2), (4); design.md, Decisions this change rests on; design.md, Design rules: Requester loop; design.md, Self-hosting decisions: S7

#### Scenario: A waiting proposal outlasts the acknowledged feed

- **WHEN** a decline proposal for `FE-142` waits for Bob, and Bob acknowledges every event in the update feed of their web inbox
- **THEN** Bob's web inbox still lists the decline proposal as waiting
- **AND** once Bob confirms it in the web UI, it is no longer listed as waiting

#### Scenario: A due date waits in the other side's web inboxes

- **WHEN** Sam, the requester of `FE-142`, confirms their due-date proposal on `FE-142` in the web UI, and Bob and Erin are the members of team FE
- **THEN** Sam's web inbox no longer lists the proposal as waiting for Sam
- **AND** the web inboxes of Bob and Erin each list it as waiting
- **AND** once Bob confirms it in the web UI, neither Bob's nor Erin's web inbox lists it as waiting any longer

#### Scenario: A receipt is listed in the web inbox

- **WHEN** Bob confirms the decline proposal for `FE-142` in the web UI
- **THEN** Bob's web inbox lists the receipt for that confirmation

#### Scenario: A receipt shows how a half-confirmed proposal ended

- **WHEN** Sam, the requester of `FE-142`, confirmed a due-date proposal on `FE-142`, and Bob, a member of team FE, then rejected it
- **THEN** the receipt for Sam's confirmation in Sam's web inbox shows that the proposal was rejected

#### Scenario: A team's WARN digest reaches each member's web inbox

- **WHEN** Mehmet and Ayşe are members of FE, and a daily WARN digest for FE is produced
- **THEN** the web inbox of Mehmet and the web inbox of Ayşe each list FE's WARN digest
- **AND** each still lists it after they acknowledge every event in their update feed

#### Scenario: A re-confirmation request stays until it is done

- **WHEN** FE's declaration for `payments-api` comes due for re-confirmation, and Mehmet, a member of FE, acknowledges every event in the update feed of their web inbox
- **THEN** Mehmet's web inbox still lists the re-confirmation request
- **AND** once Ayşe, another member of FE, re-confirms the declaration, no FE member's web inbox lists that request any longer

### Requirement: Proposal outcomes reach the proposing agent

When the accountable human confirms a proposal that an agent made, the confirmation SHALL appear in `whats_new` for the user that agent acts for. For a commitment that needs a confirmation from each side, as the requests capability defines, the other side's confirmation, which makes the commitment take effect, SHALL appear there too. When a proposal ends without taking effect, whether it is rejected, withdrawn, expired or cancelled, as the requests capability defines, the event that names how it ended SHALL appear in `whats_new` for its accountable human, including when the accountable human has confirmed it and it was waiting for the other side. No email SHALL be sent for an ending right away; the ending reaches the web inbox's update feed and, when SMTP is set, the daily digest.

Source: D23; D28 #16, #61; D30 (4); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S10

#### Scenario: A confirmed decline

- **WHEN** Dana's agent proposes declining `FE-142` and Dana confirms it in the web UI
- **THEN** the next `whats_new` call by Dana's agent includes the confirmation

#### Scenario: A due date confirmed by both sides

- **WHEN** Dana, a member of team FE, confirms their agent's due-date proposal on `FE-142`, and Sam, the requester of `FE-142`, then confirms it too
- **THEN** the `whats_new` calls by Dana's agent include Dana's confirmation and then Sam's confirmation, with which the due date took effect

#### Scenario: The other side's rejection reaches the proposing agent

- **WHEN** Dana, a member of team FE, confirms their agent's due-date proposal on `FE-142`, and Sam, the requester of `FE-142`, then rejects it
- **THEN** the next `whats_new` call by Dana's agent includes the rejection

#### Scenario: A half-confirmed due date expires

- **WHEN** the install has SMTP set, Alice's agent created a due-date proposal on `FE-142` at 2026-10-01 09:00 UTC, Alice, the requester of `FE-142`, confirmed it on 2026-10-02, and no member of team FE confirmed it by 2026-10-08 09:00 UTC
- **THEN** the next `whats_new` call by Alice's agent includes an event that the proposal expired
- **AND** Alice gets no immediate email about the expiry

### Requirement: The long-poll wait endpoint

Tiehall SHALL offer a long-poll endpoint, `GET /api/v1/events/wait`, that takes a `cursor` parameter, answers as soon as an event in the reader's updates, as the requirement on what `whats_new` covers defines, exists after that cursor, and otherwise holds the call open for at most 60 seconds. Its answer SHALL carry identifiers and server text only, never message or packet text: a list of entries, each with the event's `seq`, its `type`, the `request_key`, the `team_key` of the request's target team and the request's `url`, and the cursor. The reader then pulls the content. When the hold ends with no new event, the endpoint SHALL answer 200 with an empty list and the cursor, and the reader's stored cursor SHALL NOT move. While the app shuts down, as it does when an upgrade restarts it as the self-host-install capability defines, the endpoint SHALL end open waits with 503 and `Retry-After: 0`.

Source: D28 #59; design.md, Decisions this change rests on; design.md, Design rules: Requester loop; design.md, Technical decisions: T15; design.md, Self-hosting decisions: S12

#### Scenario: A question arrives during a wait

- **WHEN** Sam's client is waiting on `/api/v1/events/wait` with its cursor and an agent in team FE posts a question on `FE-142`
- **THEN** the wait answers with an entry that holds the new event's `seq` and `type`, the `request_key` `FE-142`, the `team_key` `FE` and the `url` `https://tiehall.example.com/FE-142`
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

### Requirement: Claude Code SessionStart digest

The Claude Code plugin SHALL register a SessionStart hook that runs `tiehall hook session-start`, which prints a digest of the user's updates that are new and not yet announced, as the requirement that news is announced once defines. Each entry SHALL carry only the server text the agent-safety capability allows in push notices: the request key, the event type, the team and the request URL. The agent then pulls the content.

Source: design.md, Design rules: Requester loop; design.md, Design rules: Agent safety; design.md, Technical decisions: T15

#### Scenario: Two updates waiting

- **WHEN** Sam starts a Claude Code session with the plugin installed while two updates on Sam's requests are new and not yet announced
- **THEN** the hook prints two entries, each with a request key, an event type, a team and a request URL
- **AND** it prints no text that any user wrote

### Requirement: Claude Code Stop-hook waiter

The plugin SHALL register a Stop hook, run with Claude Code's `asyncRewake` option, that runs `tiehall hook wait`. The waiter SHALL long-poll the wait endpoint; SHALL stop after at most 30 minutes, a cap the CLI enforces itself; SHALL hold a per-session lock, which the CLI enforces, so that at most one waiter waits for a Claude Code session; and SHALL exit with code 2 when news that has not been announced arrives, which wakes Claude with a reminder made only of the server text the agent-safety capability allows in push notices. Everything the waiter writes to its error output reaches Claude, so it SHALL write nothing there but that reminder. A new waiter SHALL be armed at the end of every turn. When a wait ends with an empty answer, or with 503 and `Retry-After: 0` while the app shuts down, the waiter SHALL call the wait endpoint again and keep waiting within the same 30-minute cap. The Stop hook SHALL be registered with a timeout longer than the cap, 1900 seconds, so that Claude Code does not end the waiter before the cap. The lock SHALL be released when the waiter exits and when the Claude Code session ends, and a waiter whose session has ended SHALL exit.

Source: D28 #59; design.md, Decisions this change rests on; design.md, Design rules: Requester loop; design.md, Technical decisions: T15

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

### Requirement: News is announced once

The CLI SHALL keep, on the user's machine, a local mark of the updates already announced, one per user and install, which the SessionStart digest and the Stop-hook waiter share. Neither SHALL announce an update that the mark already holds, and each SHALL add to the mark the updates it announces. The mark SHALL NOT acknowledge anything: an announced update stays in every pull reader until the user or their agent acknowledges it.

Source: design.md, Technical decisions: T15

#### Scenario: The next turn does not wake Claude again for the same news

- **WHEN** the waiter woke Claude for the question on `FE-142`, and Claude's turn ends without acknowledging it
- **THEN** the next waiter does not exit with code 2 because of that question
- **AND** it exits with code 2 when a new update arrives

#### Scenario: A new session does not list announced news again

- **WHEN** the waiter woke Claude for the question on `FE-142`, and Sam then starts a new Claude Code session without having acknowledged it
- **THEN** the SessionStart digest does not list the question on `FE-142`
- **AND** Sam's next `tiehall updates` still lists it

#### Scenario: Another install keeps its own mark

- **WHEN** Sam has saved logins for `https://tiehall.example.com` and `https://tiehall.example.net`, and the question on `FE-142` of `https://tiehall.example.com` has been announced
- **THEN** that announcement adds nothing to the mark for `https://tiehall.example.net`

### Requirement: The hooks read with the CLI's cursor and acknowledge nothing

`tiehall hook session-start` and `tiehall hook wait` SHALL read with the read cursor of the user's CLI client and SHALL NOT acknowledge any event. The agent acknowledges events through `whats_new` or `tiehall updates`.

Source: D28 #60; design.md, Decisions this change rests on; design.md, Technical decisions: T15

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

### Requirement: The hooks stay quiet without the CLI

When the `tiehall` CLI is not installed, the plugin's hooks SHALL exit quietly: they SHALL write nothing that reaches Claude, SHALL NOT wake Claude, and SHALL NOT stop the Claude Code session from starting or continuing.

Source: design.md, Technical decisions: T15

#### Scenario: A session starts without the CLI

- **WHEN** Sam has the Tiehall plugin installed but no `tiehall` command on the machine, and starts a Claude Code session
- **THEN** the session starts normally
- **AND** no hook output or error from the Tiehall hooks reaches Claude

#### Scenario: A turn ends without the CLI

- **WHEN** a turn ends in that session
- **THEN** no waiter keeps running
- **AND** Claude is not woken by the Tiehall hooks

### Requirement: The plugin monitor fallback

If Claude Code's `asyncRewake` on the Stop hook cannot wake Claude, the plugin SHALL offer a plugin monitor that runs `tiehall watch` in place of the Stop-hook waiter. The monitor SHALL be marked experimental, SHALL run only in Claude Code's interactive CLI, and SHALL need no admin setup. Its output SHALL carry only the server text the agent-safety capability allows in push notices.

Source: design.md, Design rules: Requester loop; design.md, Technical decisions: T15

#### Scenario: The fallback reports an update

- **WHEN** the plugin uses the monitor fallback and an agent in team FE posts a question on `FE-142` during Sam's interactive Claude Code session
- **THEN** `tiehall watch` reports the update with the request key, the event type, the team and the request URL only

### Requirement: No push paths other than the hooks

In v1, the only push path SHALL be the Claude Code hooks, or the plugin monitor in place of the Stop-hook waiter. Claude Code channels SHALL NOT ship in v1, and Tiehall SHALL NOT offer a server-sent event stream; the wait endpoint serves the loop.

Source: D8; design.md, Decisions this change rests on; design.md, Design rules: Requester loop

#### Scenario: No channel in the plugin

- **WHEN** the v1 Claude Code plugin is inspected
- **THEN** it registers the SessionStart and Stop hooks
- **AND** it declares no channel

#### Scenario: No event stream in the API

- **WHEN** the OpenAPI document served by an install is read
- **THEN** it describes no operation that streams events as server-sent events

### Requirement: Codex and other clients pull

Codex, Cursor, Copilot and every other client without the Claude Code hooks SHALL get updates by pull. Because Codex hooks cannot wake an idle session, a Codex SessionStart snippet is the only hook Tiehall offers for Codex, and it SHALL ship only after it has been tested to work.

Source: D8; design.md, Decisions this change rests on; design.md, Design rules: Requester loop

#### Scenario: A Codex agent pulls

- **WHEN** Sam's agent runs in Codex and calls `whats_new` after a question was posted on `FE-142`
- **THEN** the result includes the question event on `FE-142`

#### Scenario: An untested snippet is not offered

- **WHEN** the Codex SessionStart snippet has not yet been tested to work
- **THEN** neither the plugin nor Tiehall's documentation offers it

### Requirement: Email for people, only when SMTP is set

Tiehall SHALL send email only when the install has SMTP settings, as the self-host-install capability defines; without them it SHALL send no email, and every notice SHALL still reach people through their web inbox. When SMTP is set:
- When a question is posted on a request, Tiehall SHALL email the person it is asked of right away: the requester when the target team's side asks, and the claimant when the requester's side asks. A question that the requester's side posts on a request that nobody has claimed is asked of no one person, so it SHALL be emailed to nobody right away.
- Tiehall SHALL gather every other update into a daily digest email, sent at most once per UTC day, after the UTC day it covers has ended.
- Users SHALL be able to turn the digest off, but SHALL NOT be able to turn off transactional email, such as proposal notices and receipts. Turning the digest off SHALL also stop the daily WARN digest email that the contract-changes capability defines, for that user; it SHALL NOT stop the emails that ask a consuming team to re-confirm its consumer-map declarations every 90 days, which the contract-changes capability also defines.
- Emails SHALL go to the primary verified email address of the user's GitHub account.
- Email subjects SHALL carry only the server text the agent-safety capability allows in push notices.

Source: D9; D28 #61, #73; D29 (6); design.md, Decisions this change rests on; design.md, Design rules: Agent safety; design.md, Self-hosting decisions: S10

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

### Requirement: When the requester is a team

When the provider team is the requester of a contract-change request, as the contract-changes capability defines for a provider PR whose author is not a member of the install, the requester loop's events on that request SHALL go to the provider team's inbox, and so to the update feed of the web inbox of every member of that team, as the requirements on what `whats_new` covers and on the web inbox define. When SMTP is set, its emails SHALL go only to the members of that team who have opted in to them. Each member SHALL choose, for each team they belong to, in their email settings in the web UI, whether they get the emails that go to that team as a requester; the choice SHALL be off until the member turns it on, and SHALL change nothing in their web inbox. This SHALL include the proposal notices that ask the requester side for its confirmation of a two-sided commitment, as the requests capability defines; every member of the team who may give that confirmation SHALL still find the proposal waiting in the standing list of their web inbox.

Source: D14; D28 #62, #75; D29 (5); D30 (4); design.md, Decisions this change rests on; design.md, Design rules: Contract changes

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

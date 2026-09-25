# Spec Delta: requests

## Purpose

A request is how one team of the company that runs an install asks another team for work. This capability defines the request's lifecycle and states, who may see and act on it, its per-team key, its thread of messages with server-stamped provenance, the proposals through which commitments wait for a person to confirm them in the web UI (for a due date, or a scope change while the request is claimed, a person on each side), the receipts and the undo window, and the install's event log that readers follow.

## ADDED Requirements

### Requirement: Requests only, with questions in the request's thread

In v1, Tiehall SHALL offer tracked requests and SHALL NOT offer free-form rooms; rooms come later. Clarifying questions and their answers SHALL be posted in the thread of the request they concern.

Source: D7; D11; design.md, Decisions this change rests on

#### Scenario: A clarifying question goes into the request's own thread

- **WHEN** an agent working on request FE-142 posts a clarifying question about it
- **THEN** the question is appended to the thread of FE-142
- **AND** no other conversation is created

#### Scenario: No room operations in v1

- **WHEN** a client lists the operations in `/api/v1/openapi.json` and the tools of the MCP server
- **THEN** none of them creates, lists or reads a free-form room

### Requirement: A request is addressed to a team of the install

Every request SHALL be addressed to exactly one target team of the install. Tiehall SHALL record the requesting user and the requesting team, except where the contract-changes capability names a different requester. A request addressed to a team the install does not have SHALL be refused with 404, as the public-api capability's error model defines for a record that does not exist, and nothing SHALL be created. An install serves one company, so requests between companies do not exist in v1.

Source: D25; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S1

#### Scenario: Opening a request to another team

- **WHEN** Alice, a member of team BE, opens a request addressed to team FE
- **THEN** a request is created with FE as its target team
- **AND** Alice and team BE are recorded as the requester
- **AND** the request is in state `open`

#### Scenario: A team the install does not have

- **WHEN** Alice opens a request through `/api/v1` addressed to the team key `ZZ`, which names no team of the install
- **THEN** Tiehall answers 404 with an RFC 9457 problem
- **AND** no request is created

### Requirement: The requester picks the requesting team

When a user opens a request, they SHALL pick the requesting team from the teams they belong to. When the user belongs to exactly one team and picks none, that team SHALL be recorded as the requesting team. When the user belongs to several teams and picks none, the request SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema, with a problem that lists the teams the user may pick from. A user who belongs to no team SHALL NOT be able to open a request: the call SHALL be refused with 403, as that error model defines for a caller whose part does not allow the action, until an admin adds them to a team. A pick of a team the user does not belong to SHALL be refused with 403 in the same way. In every one of these refusals, no request SHALL be created.

Source: D28 #11; design.md, Decisions this change rests on

#### Scenario: A member of two teams picks one

- **WHEN** Alice, a member of teams BE and QA, opens a request to team FE and picks QA as the requesting team
- **THEN** the request records Alice and team QA as the requester

#### Scenario: The only team is the default

- **WHEN** Alice, whose only team is BE, opens a request to team FE without picking a requesting team
- **THEN** the request records Alice and team BE as the requester

#### Scenario: A member of two teams must pick one

- **WHEN** Alice, a member of teams BE and QA, opens a request to team FE through `/api/v1` without picking a requesting team
- **THEN** Tiehall answers 400 with an RFC 9457 problem that lists BE and QA
- **AND** no request is created

#### Scenario: A user in no team cannot open a request

- **WHEN** Lee, a member of the install who belongs to no team, opens a request to team FE through `/api/v1`
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** no request is created

#### Scenario: A team the user is not in cannot be the requesting team

- **WHEN** Alice, whose only team is BE, opens a request to team FE through `/api/v1` and picks OPS as the requesting team
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** no request is created

### Requirement: Every member sees every request

Every member of the install SHALL be able to see every request, whether or not they belong to the requesting team or the target team.

Source: D28 #3; design.md, Decisions this change rests on

#### Scenario: A member of a third team reads a request

- **WHEN** Carol, a member of team OPS only, reads FE-142, which team BE opened to team FE
- **THEN** Tiehall returns FE-142

### Requirement: Which side may act on a request

The right to act on a request SHALL depend on the caller's side of it, whether the caller acts in the web UI or through an agent acting for them:
- members of the target team SHALL be the ones who claim the request, start work on it, decline it, mark it done and reassign it to another team;
- the requester side, meaning the requesting user and the members of the requesting team, SHALL be the ones who withdraw the request, change its scope and add packet revisions;
- either side SHALL be able to propose a due date.

An action by a caller whose side does not hold the right SHALL be refused with 403, as the public-api capability's error model defines for a caller whose part in the request does not allow the action, and nothing SHALL change: no state, no revision and no proposal. For an action that is a commitment, holding the right lets the caller start the proposal; the commitment still takes effect only when it is confirmed, and a due date, or a scope change while the request is claimed, also needs a confirmation from the other side, as the requirement on cross-team commitments defines.

Source: D28 #3; D30 (2); design.md, Decisions this change rests on

#### Scenario: The requester side cannot decline

- **WHEN** Alice, the requester of FE-142 and not a member of its target team FE, asks through `/api/v1` to decline FE-142
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** no decline proposal is created and FE-142 keeps its state

#### Scenario: The target team cannot withdraw

- **WHEN** Bob, a member of FE-142's target team FE who does not belong to the requesting team BE, asks through `/api/v1` to withdraw FE-142
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** no withdrawal proposal is created

#### Scenario: A member of a third team cannot claim

- **WHEN** Carol, a member of team OPS only, asks through `/api/v1` to claim the open request FE-142
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** FE-142 stays `open` with no claimant

#### Scenario: Either side proposes a due date

- **WHEN** Bob, a member of the target team FE, proposes a due date on FE-142
- **AND** Alice, the requester, proposes a different due date on FE-142
- **THEN** two due-date proposals are created, one with Bob and one with Alice as its accountable human

### Requirement: Request states

A request SHALL always be in exactly one of seven states: `open`, `claimed`, `in_progress`, `needs_info`, `done`, `declined` and `withdrawn`. A new request SHALL start in `open`. The states `done`, `declined` and `withdrawn` SHALL be terminal: once a request reaches one of them, its state SHALL NOT change again, and a request to change it SHALL be refused with 409, as the public-api capability's error model defines for a state conflict, with one exception: a confirmed decline SHALL be reversible within the undo window this capability defines, which returns the request to the state it had before the decline. `declined` SHALL be used when the target team refuses a request, and `withdrawn` when the requester side cancels it or when the system withdraws it because its provider PR closed unmerged or its breaking changes disappeared.

Source: D28 #13, #34; design.md, Decisions this change rests on; design.md, Design rules: Requests and events

#### Scenario: A new request starts open

- **WHEN** a request is opened to team FE
- **THEN** its state is `open`

#### Scenario: Only the seven states exist

- **WHEN** a client reads the state of any request through `/api/v1`
- **THEN** the value is one of `open`, `claimed`, `in_progress`, `needs_info`, `done`, `declined` or `withdrawn`

#### Scenario: A terminal state does not change

- **WHEN** request FE-142 is `withdrawn` and an agent asks through `/api/v1` to set it to `in_progress`
- **THEN** Tiehall answers 409 with an RFC 9457 problem
- **AND** FE-142 stays `withdrawn`

#### Scenario: A confirmed decline is undone within the window

- **WHEN** FE-142 was `claimed`, Bob confirmed its decline in the web UI, and 10 minutes later Bob uses the undo link from the receipt and confirms the undo in the web UI
- **THEN** FE-142 is `claimed` again

### Requirement: Allowed state changes

Tiehall SHALL allow these state changes, besides the ones the other requirements of this capability define:
- a decline and a withdrawal SHALL be allowed from any state that is not terminal;
- a move to `done` SHALL be allowed only from `claimed`, `in_progress` or `needs_info`;
- the claimant SHALL be able to release their claim without a proposal, which returns the request to `open` with no claimant;
- when the claimant is no longer a member of the install, any member of the request's target team SHALL be able to release that claim in the same way, without a proposal.

A change that the request's current state does not allow, such as claiming a request that is not `open` or marking an `open` request done, SHALL be refused with 409, as the public-api capability's error model defines for a state conflict; the request SHALL NOT change and no proposal SHALL be created. Only the claimant SHALL be able to release a claim, except that any member of the target team MAY release a claim held by someone who is no longer a member of the install; anyone else who tries SHALL be refused with 403.

Source: D28 #10, #13; D29 (3); design.md, Decisions this change rests on

#### Scenario: Declining during triage

- **WHEN** FE-143 is `open` and Bob, a member of team FE, declines it and confirms the decline proposal in the web UI
- **THEN** FE-143 is `declined`

#### Scenario: Withdrawing while blocked on a question

- **WHEN** FE-142 is `needs_info` and Alice, its requester, withdraws it and confirms the withdrawal proposal in the web UI
- **THEN** FE-142 is `withdrawn`

#### Scenario: Done from needs_info

- **WHEN** FE-142 is `needs_info` after a blocking question posted while it was `in_progress`, and Bob confirms a done proposal for it in the web UI
- **THEN** FE-142 is `done`

#### Scenario: An open request cannot be marked done

- **WHEN** FE-143 is `open` and Bob's agent asks through `/api/v1` to set it to `done`
- **THEN** Tiehall answers 409 with an RFC 9457 problem
- **AND** no done proposal is created and FE-143 stays `open`

#### Scenario: A claimed request cannot be claimed again

- **WHEN** FE-142 is `claimed` by Bob and Erin, another member of team FE, asks through `/api/v1` to claim it
- **THEN** Tiehall answers 409 with an RFC 9457 problem
- **AND** Bob stays the claimant

#### Scenario: The claimant releases a claim

- **WHEN** FE-142 is `claimed` by Bob and Bob's agent releases the claim
- **THEN** FE-142 is `open` with no claimant
- **AND** no proposal is created

#### Scenario: Only the claimant releases

- **WHEN** FE-142 is `claimed` by Bob, who is still a member of the install, and Erin, another member of team FE, asks through `/api/v1` to release Bob's claim
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** Bob stays the claimant

#### Scenario: A team member releases a departed member's claim

- **WHEN** FE-142 is `claimed` by Dana, who has since been removed from the install, and Erin, a member of team FE, asks through `/api/v1` to release Dana's claim
- **THEN** FE-142 is `open` with no claimant
- **AND** no proposal is created

#### Scenario: Only the target team releases a departed member's claim

- **WHEN** FE-142 is `claimed` by Dana, who has since been removed from the install, and Sam, a member of team BE and not of team FE, asks through `/api/v1` to release Dana's claim
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** Dana stays the claimant

### Requirement: Claiming and starting work need no proposal

Tiehall SHALL let an agent acting for its own signed-in user claim an open request, and move a claimed request to `in_progress`, without a proposal. A person in the web UI SHALL be able to do the same. A claim SHALL record the user it was made for as the claimant. A request SHALL count as claimed while it has a claimant; once its claim is released, it SHALL count as unclaimed again. Wherever these specs speak of a claimed or unclaimed request, or of a change after a claim, they mean whether the request has a claimant at that moment.

Source: D23; D28 #13; design.md, Decisions this change rests on; design.md, Design rules: Requests and events

#### Scenario: An agent claims a request for its user

- **WHEN** an agent holding a token for Bob, a member of team FE, claims the open request FE-142
- **THEN** FE-142 moves to `claimed` with Bob as the claimant
- **AND** no proposal is created

#### Scenario: An agent starts work

- **WHEN** Bob's agent moves the claimed request FE-142 to `in_progress`
- **THEN** FE-142 is `in_progress`
- **AND** no proposal is created

#### Scenario: A released claim leaves the request unclaimed

- **WHEN** Bob claimed FE-142 and then released the claim, so FE-142 is `open` with no claimant, and Alice, its requester, changes its need
- **THEN** the change is added as the next packet revision without a proposal, as for a request that was never claimed

### Requirement: Thread messages and blocking questions

A message in a request's thread SHALL be a comment, a question or an answer, and a question SHALL be markable as blocking. Only the two sides of the request, the requester side and the members of the target team, SHALL be able to post messages on it; a member who is on neither side SHALL be refused with 403, as the public-api capability's error model defines for a caller whose part in the request does not allow the action, and nothing SHALL be added. Tiehall's own system messages and notices are not posted by a caller and are not limited by this. Every answer SHALL name the question it answers; an answer that names no question SHALL be refused with 400. A blocking question SHALL move a request that is `open`, `claimed` or `in_progress` to `needs_info`. The request SHALL stay in `needs_info` until every blocking question on it has an answer, and SHALL then return to the state it was in before the first of those questions moved it. A comment or a non-blocking question SHALL NOT change the request's state. How often an agent may make a request flip between `needs_info` and `in_progress` is limited by the agent-safety capability.

Source: D9; D11; D28 #3, #17; design.md, Decisions this change rests on; design.md, Design rules: Requests and events

#### Scenario: A blocking question during work

- **WHEN** Bob's agent posts a blocking question on FE-142 while it is `claimed`
- **THEN** FE-142 moves to `needs_info`
- **AND** when the requester's agent posts an answer that names that question, FE-142 returns to `claimed`

#### Scenario: A blocking question during triage

- **WHEN** a member of team FE posts a blocking question on FE-143 while it is `open`
- **THEN** FE-143 moves to `needs_info`
- **AND** when an answer that names that question is posted, FE-143 returns to `open`

#### Scenario: Two blocking questions need two answers

- **WHEN** FE-142 is `in_progress` and Bob's agent posts blocking questions Q1 and Q2 on it
- **AND** the requester's agent answers Q1
- **THEN** FE-142 stays `needs_info`
- **AND** when the requester's agent then answers Q2, FE-142 returns to `in_progress`

#### Scenario: An answer must name its question

- **WHEN** an agent posts an answer on FE-142 through `/api/v1` without naming the question it answers
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** nothing is added to the thread of FE-142

#### Scenario: A member of a third team cannot post

- **WHEN** Carol, a member of team OPS only, posts a comment on FE-142, which team BE opened to team FE, through `/api/v1`
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** nothing is added to the thread of FE-142

#### Scenario: A non-blocking question leaves the state alone

- **WHEN** Bob's agent posts a question on FE-142 that is not marked blocking while FE-142 is `in_progress`
- **THEN** FE-142 stays `in_progress`

### Requirement: Commitments become proposals

These actions SHALL be commitments: setting or changing a due date after the request was opened; changing scope, meaning the need, the acceptance criteria or the contract section, while the request is claimed; declining; reassigning to another team; withdrawing; and marking done without a qualifying merged PR. A due date in the packet that a request is opened with SHALL NOT be a commitment; only later due-date changes are. The packet revisions that Tiehall adds to a contract-change request from a signed contract report SHALL NOT be commitments, even while the request is claimed: they are system actions, as the requirement on system actions defines.

When a commitment is started, whether by an agent on any surface or by a person in the web UI, Tiehall SHALL create a proposal instead of applying it. The commitment SHALL take effect only when its accountable human confirms the proposal in the web UI with the confirmation step, as the agent-safety capability defines, and, for a due date or a scope change while the request is claimed, only when the other side has confirmed it too, as the requirement on cross-team commitments defines. The accountable human SHALL be the user the agent acts for, or the user who started the commitment in the web UI. Confirming a proposal and undoing a commitment SHALL be possible only in the web UI: no MCP tool, CLI command or `/api/v1` operation SHALL offer them.

Source: D23; D28 #14, #15; D30 (2), (3); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7

#### Scenario: An agent asks to decline

- **WHEN** an agent holding a token for Bob asks to set FE-142 to `declined`
- **THEN** FE-142 keeps its current state
- **AND** a decline proposal is created with Bob as its accountable human

#### Scenario: A decline started in the web UI is also a proposal

- **WHEN** Bob clicks decline on FE-142 in the web UI
- **THEN** FE-142 keeps its current state
- **AND** a decline proposal is created with Bob as its accountable human
- **AND** FE-142 is declined only after Bob confirms the proposal on its confirm page

#### Scenario: The commitment applies on confirmation

- **WHEN** Bob confirms the decline proposal for FE-142 on its confirm page in the web UI
- **THEN** FE-142 moves to `declined`

#### Scenario: No agent surface confirms

- **WHEN** a client lists the tools of the MCP server, the commands of the `tiehall` CLI and the operations in `/api/v1/openapi.json`
- **THEN** none of them confirms a proposal or undoes a commitment

#### Scenario: A due date in the opening packet is not a commitment

- **WHEN** Alice opens request FE-144 with a packet whose due date is 2026-10-15
- **THEN** FE-144 is created with the due date 2026-10-15
- **AND** no proposal is created

#### Scenario: Changing the need after a claim is a commitment

- **WHEN** FE-142 is `claimed` by Bob and Alice's agent changes its need
- **THEN** a scope-change proposal is created with Alice as its accountable human
- **AND** FE-142's need is unchanged until Alice confirms the proposal and Bob, the claimant, confirms it too

#### Scenario: A contract revision on a claimed request is not a commitment

- **WHEN** the contract-change request FE-150 is claimed by Bob, and a signed contract report for its provider PR adds a packet revision with 3 breaking changes instead of 2
- **THEN** the revision becomes FE-150's current revision at once
- **AND** no proposal is created

### Requirement: Cross-team commitments need a confirmation from each side

Two commitments SHALL need a second confirmation, from the other side of the request, after the accountable human has confirmed them:
- a due date, whichever side proposes it. When the accountable human is on the requester side, meaning the requesting user or a member of the requesting team, the second confirmation SHALL come from a member of the target team. When the accountable human is a member of the target team and not on the requester side, it SHALL come from the requesting user or a member of the requesting team.
- a scope change while the request is claimed. The second confirmation SHALL come from the claimant, or, when the claimant is no longer a member of the install, from any member of the target team.

Each confirmation SHALL be given in the web UI with the confirmation step, as the agent-safety capability defines, by the person whose web session it is. The second confirmation SHALL come from a person other than the accountable human, even when the accountable human is on both sides, such as a member of both the requesting team and the target team; one person's confirmation SHALL never count for both sides. Which side the accountable human is on SHALL be recorded when the proposal is created, and that recorded side SHALL decide which side gives the second confirmation, even if the accountable human later joins or leaves a team. Who belongs to the other side, and who holds the claim, SHALL be decided when the second confirmation is given, so the claimant is whoever holds the claim at that moment.

The second confirmation SHALL be possible only after the accountable human has confirmed: before that, a confirmation from the other side SHALL be refused with 409, as the public-api capability's error model defines for a state conflict. A second confirmation from anyone who may not give it SHALL be refused with 403, as it defines for a caller whose part in the request does not allow the action; an attempt by the accountable human to confirm again SHALL be refused with 409, because the proposal no longer waits for their confirmation; either way the proposal SHALL keep waiting. While nobody may give the second confirmation, such as a scope change whose request nobody has claimed since the accountable human confirmed it, the proposal SHALL keep waiting until someone may, or until it ends as the requirement on how a proposal ends defines; the user who proposed it MAY instead withdraw it, and the requester side MAY then, while the request is unclaimed, make the change at once. Every other commitment SHALL take effect on the accountable human's confirmation alone.

Source: D23; D30 (2), (4); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7

#### Scenario: A due date proposed by the requester side waits for the target team

- **WHEN** Alice, the requester of FE-142 and not a member of its target team FE, proposes the due date 2026-10-15 on FE-142 and confirms the proposal in the web UI
- **THEN** FE-142's due date is unchanged
- **AND** the proposal waits for a confirmation from a member of team FE

#### Scenario: The target team's confirmation makes the due date binding

- **WHEN** Alice has confirmed their proposal of the due date 2026-10-15 on FE-142, and Bob, a member of team FE, then confirms it in the web UI
- **THEN** FE-142's due date is 2026-10-15

#### Scenario: A due date proposed by the target team waits for the requester side

- **WHEN** Bob, a member of team FE and not of the requesting team BE, proposes a due date on FE-142 and confirms the proposal in the web UI
- **THEN** FE-142's due date is unchanged
- **AND** once Sam, a member of team BE, confirms it in the web UI, the due date takes effect

#### Scenario: The other side cannot confirm first

- **WHEN** Alice's agent has proposed a due date on FE-142, Alice has not confirmed it yet, and Bob, a member of team FE, asks to confirm it
- **THEN** the confirmation is refused with 409
- **AND** the proposal still waits for Alice

#### Scenario: The proposer's own side cannot give the second confirmation

- **WHEN** Alice has confirmed their due-date proposal on FE-142, and Sam, a member of the requesting team BE and not of team FE, asks to confirm it
- **THEN** the confirmation is refused with 403
- **AND** the proposal still waits for a member of team FE

#### Scenario: A scope change after a claim waits for the claimant

- **WHEN** FE-142 is claimed by Bob, and Alice proposes new acceptance criteria for it and confirms the proposal in the web UI
- **THEN** FE-142's acceptance criteria are unchanged
- **AND** the proposal waits for Bob's confirmation
- **AND** once Bob confirms it in the web UI, the new acceptance criteria take effect

#### Scenario: Only the claimant gives the second confirmation of a scope change

- **WHEN** FE-142 is claimed by Bob, who is still a member of the install, Alice has confirmed a scope-change proposal on it, and Erin, another member of team FE, asks to confirm it
- **THEN** the confirmation is refused with 403
- **AND** the proposal still waits for Bob

#### Scenario: The target team confirms for a claimant who left the install

- **WHEN** FE-142 is claimed by Dana, who has since been removed from the install, Alice has confirmed a scope-change proposal on it, and Erin, a member of team FE, confirms it in the web UI
- **THEN** the scope change takes effect

#### Scenario: A scope change waits while nobody holds the claim

- **WHEN** FE-142 was claimed by Bob, Alice confirmed a scope-change proposal on it, and Bob then released the claim, so FE-142 is `open` with no claimant
- **THEN** Erin's attempt, as a member of team FE, to confirm the proposal is refused with 403 and the proposal keeps waiting
- **AND** when Alice withdraws the proposal and then changes the acceptance criteria while FE-142 is still unclaimed, the change is added as the next packet revision without a proposal

#### Scenario: Other commitments need one confirmation

- **WHEN** Alice, the requester of FE-142, confirms a withdrawal proposal for it in the web UI
- **THEN** FE-142 is `withdrawn`
- **AND** no confirmation from team FE was asked for

#### Scenario: A member of both sides still needs another person

- **WHEN** Sam, a member of both BE and FE, proposes a due date on FE-142, which team BE opened to team FE, and confirms the proposal in the web UI
- **THEN** FE-142's due date is unchanged
- **AND** Sam's attempt to confirm it again, as a member of team FE, is refused with 409
- **AND** once Bob, another member of team FE, confirms it in the web UI, the due date takes effect

#### Scenario: The accountable human's side is kept from when the proposal was created

- **WHEN** Sam, a member of the requesting team BE and not of team FE, proposes a due date on FE-142 and confirms it, and Sam then leaves team BE but stays a member of the install
- **AND** Bob, a member of team FE, confirms the proposal in the web UI
- **THEN** the due date takes effect

### Requirement: What a proposal records and shows

A proposal SHALL record who proposed it: the agent client, the surface and the user. It SHALL record which confirmations it needs and which it has received, each with the user who gave it and the time, and when it expires. Wherever the proposal is returned, listed or emailed, it SHALL show the confirmations it needs and has, and when it expires; once it has ended without taking effect, it SHALL show how it ended. No operation SHALL change what a proposal proposes once it is created: a different commitment SHALL be a new proposal. So a confirmation always applies to exactly what the person reviewed, and a confirmation the proposal has received SHALL stay valid while it waits for the other side; a proposed packet change whose base revision is overtaken is cancelled as stale instead, as the handoff-packet capability defines. What the caller that started a commitment gets back is defined by the public-api capability for the REST `202` answer and by the agent-surfaces capability for MCP tools and the CLI.

Source: D23; D30 (4); design.md, Decisions this change rests on; design.md, Design rules: Requests and events

#### Scenario: The proposal names its origin

- **WHEN** Bob's agent declines FE-142 through the `tiehall` CLI, and Bob opens the waiting decline proposal in the web UI
- **THEN** it names the agent client, the surface (`cli`) and Bob as the user who proposed it
- **AND** it shows that it needs Bob's confirmation and when it expires

#### Scenario: Proposing again makes a second proposal

- **WHEN** Bob's agent has proposed the due date 2026-10-15 on FE-142, and then proposes the due date 2026-10-01
- **THEN** FE-142 has two pending due-date proposals
- **AND** the first still proposes 2026-10-15, with the confirmations and the expiry it had

#### Scenario: A received confirmation stays valid while the claim moves

- **WHEN** FE-142 is claimed by Bob, Alice has confirmed a scope-change proposal on it, and Bob releases the claim and Erin claims FE-142
- **THEN** the proposal still records Alice's confirmation
- **AND** it waits only for Erin's

### Requirement: Where a proposal waits

Every waiting proposal SHALL be listed in the standing list of the web inbox of each person who may confirm it at that moment, as the requester-loop capability defines: first the accountable human, and then, once the accountable human has confirmed a commitment that needs the other side, each person who may give the other side's confirmation, as the requirement on cross-team commitments defines. When the set of people who may give a waiting confirmation changes, such as when the request is claimed, its claim is released or its claimant is removed from the install, the standing lists SHALL follow the new set at once.

When email is set up, as the self-host-install capability defines for SMTP, each person SHALL also get an email about the proposal when it starts to wait for their confirmation, including a person who becomes able to give a waiting confirmation; without email, Tiehall SHALL send none, and the standing list SHALL be where they find the proposal. One exception applies to email: when a team is the requester of a contract-change request, as the contract-changes capability defines for a provider PR whose author is not a member of the install, the emails that ask the requester side for its confirmation SHALL go only to the members of that team who have opted in to its emails, as the requester-loop capability defines; every member who may give the confirmation SHALL still find the proposal in their standing list. The accountable human's own email about a proposal has no exception. The confirm URL SHALL reach people only as the agent-safety capability defines.

Source: D28 #62; D30 (4); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S10

#### Scenario: The CLI starts a commitment

- **WHEN** the install has SMTP set, and the `tiehall` CLI, signed in as Bob, asks to set FE-142 to `declined`
- **THEN** the decline proposal is listed as waiting in the standing list of Bob's web inbox
- **AND** Bob gets an email about it that shows when the proposal expires

#### Scenario: Without SMTP the proposal waits in the web inbox only

- **WHEN** the install has no SMTP settings, and Bob's agent proposes declining FE-142
- **THEN** the decline proposal is listed as waiting in the standing list of Bob's web inbox
- **AND** no email is sent about it

#### Scenario: A confirmed due date moves to the other side's inboxes

- **WHEN** the install has SMTP set, Bob and Erin are the members of team FE, and Alice, the requester of FE-142, confirms their due-date proposal on FE-142
- **THEN** the proposal is listed as waiting in the web inboxes of Bob and Erin, and each of them gets an email about it
- **AND** the proposal records Alice's confirmation and that it still needs a confirmation from a member of team FE
- **AND** the listing and the emails show when the proposal expires

#### Scenario: A waiting scope change follows the claim

- **WHEN** the install has SMTP set, FE-142 is claimed by Bob, Alice has confirmed their scope-change proposal on it, and Bob then releases the claim
- **THEN** the proposal is no longer listed as waiting for Bob, and nobody can give its second confirmation
- **AND** when Erin, a member of team FE, then claims FE-142, the proposal is listed as waiting in Erin's web inbox and Erin gets an email about it

#### Scenario: A removed claimant's confirmation passes to the team

- **WHEN** FE-142 is claimed by Dana, Alice has confirmed a scope-change proposal on it, Dana is then removed from the install, and Bob and Erin are the members of team FE
- **THEN** the proposal is listed as waiting in the web inboxes of Bob and Erin

#### Scenario: A requesting team gets the email only where members opted in

- **WHEN** the install has SMTP set, team PAY is the requester of the contract-change request FE-150 because the author of the provider PR is not a member of the install, Lee and Kim are members of PAY, Lee has opted in to PAY's emails and Kim has not, and Bob, a member of team FE, proposes a due date on FE-150 and confirms it
- **THEN** the proposal is listed as waiting in the web inboxes of Lee and Kim
- **AND** Lee gets an email about it and Kim gets none

### Requirement: The proposal's confirm page

Each proposal SHALL have a confirm page at `/confirm/{proposal}` on the install's own host, such as `https://tiehall.example.com/confirm/{proposal}`. It SHALL be a review page of the confirmation step, so a GET of it changes no state and it cannot be framed, as the agent-safety capability defines; only a POST from the page SHALL confirm or reject, and a confirmation SHALL pass the confirmation step. A rejection needs no confirmation step, as the agent-safety capability defines. It SHALL show the proposal in server-generated words, with any text from other teams fenced as the agent-safety capability defines, and SHALL name who proposed it: the agent client, the surface and the user. It SHALL also show which confirmations the proposal needs and which it has received, and from whom, and when it expires. A browser without a session SHALL be sent to sign-in before the page shows the proposal.

Only a person who may give the confirmation the proposal waits for, as the requirement on cross-team commitments defines, SHALL be able to confirm from the page. A confirm request from anyone who may not confirm the proposal SHALL be refused with 403; a confirm request from a person on the other side before the accountable human has confirmed SHALL be refused with 409. The accountable human, and, once the proposal waits for the other side's confirmation, a person who may give it, SHALL also be able to reject the proposal, on this page and in their web inbox. Rejecting is not a commitment: it SHALL end the proposal at once, as the requirement on how a proposal ends defines. A reject request from a person on the other side before the accountable human has confirmed SHALL be refused with 409, and a reject request from anyone else with 403.

Source: D23; D28 #16, #66; D30 (4); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S15

#### Scenario: A browser without a session signs in first

- **WHEN** someone opens `https://tiehall.example.com/confirm/{proposal}` in a browser that has no Tiehall session
- **THEN** the browser is sent to sign-in
- **AND** the proposal is not shown before sign-in

#### Scenario: The page names the proposer

- **WHEN** Alice opens the confirm page for a proposal that their agent made through Claude Code over MCP
- **THEN** the page names the agent client, the MCP surface and Alice as the user

#### Scenario: Another person cannot confirm

- **WHEN** Bob opens the confirm page for a decline proposal whose accountable human is Erin, and sends a request to confirm it
- **THEN** the request is refused with 403
- **AND** the proposal stays pending

#### Scenario: The other side confirms on the page

- **WHEN** Alice, the requester of FE-142, has confirmed their due-date proposal on FE-142, and Bob, a member of the target team, opens its confirm page
- **THEN** the page shows that Alice has confirmed, that a confirmation from a member of the target team is still needed, and when the proposal expires
- **AND** Bob can confirm the proposal from the page

#### Scenario: The other side confirms too early on the page

- **WHEN** Alice, the requester of FE-142, has not yet confirmed their due-date proposal on FE-142, and Bob, a member of the target team, sends a request to confirm it from its confirm page
- **THEN** the request is refused with 409
- **AND** the proposal still waits for Alice

#### Scenario: The other side rejects on the page

- **WHEN** Alice, the requester of FE-142, has confirmed their due-date proposal on FE-142, and Bob, a member of the target team, rejects it on its confirm page
- **THEN** the proposal is rejected and can no longer be confirmed
- **AND** the due date of FE-142 is unchanged

#### Scenario: The accountable human rejects in the web inbox

- **WHEN** Bob finds a pending proposal to decline FE-142, whose accountable human Bob is, in the standing list of their web inbox and rejects it there
- **THEN** the proposal is rejected and can no longer be confirmed
- **AND** FE-142 keeps its state

### Requirement: How a proposal ends without taking effect

A pending proposal SHALL end without taking effect in any of these ways:
- its accountable human rejects it;
- once the accountable human has confirmed a commitment that needs the other side, a person who may give the other side's confirmation, as the requirement on cross-team commitments defines, rejects it;
- the user who proposed it withdraws it, in the web UI or through an agent acting for them;
- it expires, 7 days after it was created. Every confirmation the proposal needs SHALL come within those 7 days, and nothing SHALL restart them;
- it is cancelled: when its request reaches a terminal state; when a reassignment of its request is confirmed; when its accountable human is removed from the install, as the requirement on a removed member's proposals defines; or, for a proposed packet change, when the request's current revision moves past the revision the proposal was based on, as the handoff-packet capability defines.

A proposal cancelled by a decline or a reassignment SHALL stay cancelled when that decline or reassignment is undone. Each of these endings SHALL append a domain event to the event log that names how the proposal ended: rejected, withdrawn, expired or cancelled; the requester-loop capability defines how that event reaches the accountable human, with no email sent for it right away. A rejected, withdrawn, expired or cancelled proposal SHALL NOT be confirmable: an attempt to confirm it SHALL be refused with 409, and the request SHALL NOT change. A rejection by a person who may give the other side's confirmation, made before the accountable human has confirmed, SHALL be refused with 409, as the public-api capability's error model defines for a state conflict, like a confirmation at that moment. Anyone else who tries to reject a proposal, and anyone other than the user who proposed it who tries to withdraw it, SHALL be refused with 403.

Source: D28 #16; D30 (4); design.md, Decisions this change rests on

#### Scenario: The accountable human rejects a proposal

- **WHEN** Bob rejects the pending decline proposal for FE-142
- **THEN** FE-142 keeps its current state
- **AND** a later attempt to confirm that proposal is refused with 409

#### Scenario: The other side rejects a due date

- **WHEN** Alice, the requester of FE-142, has confirmed their due-date proposal on FE-142, and Bob, a member of team FE, rejects it
- **THEN** FE-142's due date is unchanged
- **AND** a later attempt by Erin, another member of team FE, to confirm that proposal is refused with 409

#### Scenario: The proposer withdraws a proposal

- **WHEN** Bob's agent proposed a due date on FE-142 and then withdraws that proposal
- **THEN** the proposal can no longer be confirmed
- **AND** FE-142's due date is unchanged

#### Scenario: A proposal expires after 7 days

- **WHEN** a due-date proposal for FE-142 was created at 2026-10-01 09:00 UTC and is still pending at 2026-10-08 09:00 UTC
- **THEN** the proposal has expired
- **AND** an attempt to confirm it is refused with 409 and FE-142's due date is unchanged
- **AND** the event log has an event that names the proposal as expired

#### Scenario: A first confirmation does not restart the 7 days

- **WHEN** Alice's due-date proposal for FE-142 was created at 2026-10-01 09:00 UTC, Alice confirms it at 2026-10-07 08:00 UTC, and no member of team FE has confirmed it by 2026-10-08 09:00 UTC
- **THEN** the proposal has expired
- **AND** Bob's attempt to confirm it at 2026-10-08 09:30 UTC is refused with 409 and FE-142's due date is unchanged

#### Scenario: A terminal state cancels pending proposals

- **WHEN** a due-date proposal and a decline proposal for FE-142 are pending and FE-142 is then withdrawn through a confirmed withdrawal
- **THEN** both proposals are cancelled
- **AND** Bob's attempt to confirm the decline proposal is refused with 409 and FE-142 stays `withdrawn`

#### Scenario: Undoing a decline does not bring back its cancelled proposals

- **WHEN** a due-date proposal for FE-142 is pending, Bob confirms a decline of FE-142, which cancels the due-date proposal, and Bob undoes the decline 10 minutes later
- **THEN** FE-142 has its earlier state again
- **AND** the due-date proposal stays cancelled and an attempt to confirm it is refused with 409

#### Scenario: A confirmed reassignment cancels pending proposals

- **WHEN** Alice has confirmed their due-date proposal on FE-142, no member of team FE has confirmed it yet, and a reassignment of FE-142 to team MOB is then confirmed, which makes it MOB-37
- **THEN** the due-date proposal is cancelled
- **AND** an attempt by Ravi, a member of team MOB, to confirm it is refused with 409 and MOB-37's due date is unchanged

#### Scenario: The other side cannot reject first

- **WHEN** Alice's agent has proposed a due date on FE-142, Alice has not confirmed it yet, and Bob, a member of team FE, asks to reject it
- **THEN** Tiehall answers 409 with an RFC 9457 problem
- **AND** the proposal still waits for Alice

#### Scenario: Someone who may not reject a decline is refused

- **WHEN** Carol asks to reject a pending decline proposal whose accountable human is Bob
- **THEN** Tiehall answers 403 with an RFC 9457 problem
- **AND** the proposal stays pending

### Requirement: Receipts

After every confirmation, Tiehall SHALL give the person who gave it a receipt that states in server-generated words exactly what was confirmed. The receipt SHALL be listed in the standing list of their web inbox, as the requester-loop capability defines, and, when email is set up as the self-host-install capability defines for SMTP, SHALL also be sent by email. For a commitment that needs a confirmation from each side, the receipt for the accountable human's confirmation SHALL state that the commitment waits for the other side, and when the other side's confirmation makes the commitment take effect, both people who confirmed it SHALL get a receipt that states what took effect. If the proposal instead ends without taking effect, the receipt in the accountable human's standing list SHALL show how it ended. When a commitment is undone, each person who confirmed it SHALL get a receipt, in the same places, that states what was undone and by whom. Receipt emails are transactional: turning off the daily digest SHALL NOT stop them.

Source: D23; D28 #61; D30 (4); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S10

#### Scenario: A decline confirmation gives a receipt

- **WHEN** the install has SMTP set, and Bob, a member of FE-142's target team, confirms a proposal to decline FE-142
- **THEN** Bob's web inbox lists a receipt stating that FE-142 was declined by their confirmation
- **AND** Bob gets the same receipt by email

#### Scenario: A receipt without SMTP

- **WHEN** the install has no SMTP settings, and Bob confirms a proposal to decline FE-142
- **THEN** Bob's web inbox lists the receipt
- **AND** no email is sent

#### Scenario: A due date gives a receipt to each side

- **WHEN** Alice, the requester of FE-142, confirms a proposal that sets the due date of FE-142 to 2026-10-15
- **THEN** Alice's web inbox lists a receipt stating that they confirmed the due date 2026-10-15 and that it waits for the target team
- **AND** when Bob, a member of the target team, then confirms it, the web inboxes of Alice and Bob each list a receipt stating that the due date of FE-142 was set to 2026-10-15

#### Scenario: A receipt shows that the other side never confirmed

- **WHEN** Alice, the requester of FE-142, confirmed a due-date proposal that no member of the target team confirmed before it expired
- **THEN** the receipt for Alice's confirmation in Alice's web inbox shows that the proposal expired
- **AND** the due date of FE-142 is unchanged

#### Scenario: Receipts do not follow the digest setting

- **WHEN** the install has SMTP set, Bob has turned off the daily digest, and Bob confirms a proposal to decline FE-142
- **THEN** Bob gets the receipt by email

### Requirement: The undo window for reversible commitments

Commitments that can be reversed, which are a due date, a scope change, a reassignment and a decline, SHALL get an undo window of 15 minutes that starts when the commitment takes effect, linked from the receipt that states it took effect. Undo SHALL cover only these four commitments. Only a person who confirmed the commitment SHALL be able to undo it, and for a commitment that needed a confirmation from each side, either of the two people who confirmed it MAY undo it alone; anyone else SHALL be refused with 403. An undo SHALL be confirmed in the web UI with the confirmation step, as the agent-safety capability defines; an undo request without a valid confirmation SHALL be refused as that capability defines.

Using undo within the window SHALL restore the state from before the commitment; for a reassignment, that means the old team, the old key and the old tracker mirror, and the new key then redirects to the old one, as the requirement on reassignment defines. Undoing a due date or a scope change SHALL be refused with 409 when the request's current revision is no longer the one the commitment created, such as after a contract report added a revision, so that no later revision is lost. After 15 minutes the undo SHALL be refused with 409. An undo and its event SHALL be recorded together or not at all, like a confirmation, with the actor kind `web_session`, and each person who confirmed the commitment SHALL get a receipt for it, as the requirement on receipts defines.

Source: D28 #18, #34; D30 (4); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S7

#### Scenario: Undo within the window

- **WHEN** Erin confirms declining FE-142, and 10 minutes later uses the undo link in the receipt and confirms the undo in the web UI
- **THEN** FE-142 returns to the state it had before the decline

#### Scenario: Undo without a confirmation is refused

- **WHEN** Erin confirmed declining FE-142, and 5 minutes later an undo request arrives that carries Erin's session but no confirmation nonce
- **THEN** the undo is refused with 403
- **AND** FE-142 stays declined

#### Scenario: Undo after the window

- **WHEN** Erin uses the undo link 16 minutes after confirming the decline of FE-142
- **THEN** the undo is refused with 409
- **AND** FE-142 stays declined

#### Scenario: Someone who did not confirm cannot undo

- **WHEN** Erin confirmed declining FE-142, and 5 minutes later Bob, another member of team FE, asks to undo the decline
- **THEN** the undo is refused with 403
- **AND** FE-142 stays declined

#### Scenario: Either side undoes a two-sided due date

- **WHEN** Alice, the requester of FE-142, and then Bob, a member of the target team, confirmed a due date of 2026-10-15 for FE-142, which had no due date, and 10 minutes after Bob's confirmation Alice uses the undo link from their receipt and confirms the undo in the web UI
- **THEN** FE-142 has no due date again
- **AND** Bob's web inbox lists a receipt stating that the due date 2026-10-15 of FE-142 was undone by Alice
- **AND** the event log holds an event for the undo, recorded with the actor kind `web_session` and Alice as the user

#### Scenario: An undo after a newer revision is refused

- **WHEN** Alice, the requester of the contract-change request FE-150, and Bob, its claimant, confirmed a scope change on it, which added revision 4, and 5 minutes later a signed contract report adds revision 5, and Alice then uses the undo link and confirms the undo in the web UI
- **THEN** the undo is refused with 409
- **AND** revision 5 stays the current revision

#### Scenario: Other commitments have no undo

- **WHEN** Alice confirms withdrawing FE-142
- **THEN** the receipt for the withdrawal carries no undo link

### Requirement: A removed member's claims stay and their proposals are cancelled

When a member is removed from the install, whether an admin removed them, as the teams-and-roles capability defines, or they lost access by leaving the GitHub organization through which they joined, as the sign-in capability defines, the requests they have claimed SHALL stay claimed by them, and the target team SHALL still be able to reassign those requests. Any member of the target team SHALL also be able to release such a claim without a proposal, which returns the request to `open` with no claimant, so that another member can claim it. Every pending proposal whose accountable human is the removed member SHALL be cancelled. Any later call the removed member makes SHALL be refused with 403.

Source: D28 #10; D29 (3); design.md, Decisions this change rests on; design.md, Design rules: Teams and roles; design.md, Self-hosting decisions: S5

#### Scenario: Removing a claimant

- **WHEN** Dana, the claimant of FE-142 and the accountable human of a pending due-date proposal on it, is removed from the install by an admin
- **THEN** FE-142 stays claimed by Dana
- **AND** the due-date proposal is cancelled
- **AND** Dana's attempt to confirm that proposal is refused with 403

#### Scenario: Leaving the GitHub organization has the same effect

- **WHEN** Dana joined the install through membership of the company's GitHub organization, claims FE-142 and is the accountable human of a pending decline proposal on FE-143, and Dana then leaves that GitHub organization
- **THEN** once Tiehall has noticed it, as the sign-in capability defines, FE-142 stays claimed by Dana
- **AND** the decline proposal on FE-143 is cancelled

#### Scenario: The team reassigns a removed member's request

- **WHEN** Dana has been removed from the install while claiming FE-142, and Bob, a member of team FE, proposes reassigning FE-142 to team MOB and confirms it in the web UI
- **THEN** the request moves to team MOB and is `open` with no claimant

#### Scenario: The team takes over a removed member's request

- **WHEN** Dana has been removed from the install while claiming FE-142, and Bob, a member of team FE, releases Dana's claim
- **THEN** FE-142 is `open` with no claimant and no proposal is created
- **AND** Bob can then claim FE-142 for themselves

### Requirement: A confirmed commitment applies only if the request still allows it

When a proposal is confirmed, Tiehall SHALL accept the confirmation only if the request's current state still allows the commitment, and, when it is the last confirmation the proposal needs, SHALL then apply the commitment; otherwise the confirmation SHALL be refused with 409 and the request SHALL NOT change. A confirmed commitment and its event SHALL be recorded together or not at all. Creating a proposal and each confirmation of it SHALL each append a domain event to the event log, so a commitment that needs a confirmation from each side has one event for each confirmation.

Source: D30 (4); design.md, Decisions this change rests on; design.md, Design rules: Requests and events

#### Scenario: The request moved on before confirmation

- **WHEN** a done proposal for FE-142 is waiting while FE-142 is `claimed`, and Bob then releases the claim so that FE-142 is `open`
- **AND** Bob tries to confirm the done proposal
- **THEN** the confirmation is refused with 409
- **AND** FE-142 stays `open`

#### Scenario: No commitment without its event

- **WHEN** Bob confirms a decline proposal for FE-142 and writing the confirmation's event fails
- **THEN** FE-142 is not declined
- **AND** the proposal stays pending

#### Scenario: Proposals appear in the event log

- **WHEN** a decline proposal for FE-142 is created and later confirmed
- **THEN** the event log has one event for the proposal and one for its confirmation

#### Scenario: Each side's confirmation appears in the event log

- **WHEN** Alice proposes a due date on FE-142 and confirms it, and Bob, a member of team FE, then confirms it
- **THEN** the event log has one event for the proposal, one for Alice's confirmation and one for Bob's confirmation

### Requirement: Linked PRs and done on merge

Tiehall SHALL let an agent acting for its signed-in user link PRs to a request without a proposal. A request SHALL move to `done` as a system action, without a proposal or a confirmation, when a PR merges that meets all three conditions: it was linked to the request, or mentioned the request's key in its title, body or branch name, before it merged; it merged after the request was claimed; and it is in a repository that a connected installation of the install's GitHub App covers, as the tracker-mirrors capability defines. Close on merge SHALL apply only while the request is `claimed`, `in_progress` or `needs_info`. Linking a PR that has already merged SHALL create a done proposal instead, when the user who links it is a member of the request's target team and the request's state allows a move to `done`; when anyone else links it, or the state does not allow `done`, the PR SHALL only be linked and no proposal SHALL be created. The provider PR of a contract-change request never closes that request, as the contract-changes capability defines. A tracker "Done" SHALL NOT close a request by itself; the tracker-mirrors capability defines what it does.

Source: D14; D23; D37; design.md, Decisions this change rests on; design.md, Design rules: Requests and events; design.md, Self-hosting decisions: S4

#### Scenario: A qualifying PR merges

- **WHEN** Bob's agent links PR #88 to FE-142 after FE-142 was claimed, and PR #88 is in a repository that a connected installation covers
- **AND** PR #88 then merges
- **THEN** FE-142 moves to `done` with no proposal

#### Scenario: A key in the branch name counts as a mention

- **WHEN** a PR whose branch name contains `FE-142` merges after FE-142 was claimed, in a repository that a connected installation covers
- **THEN** FE-142 moves to `done` with no proposal

#### Scenario: Linking an already merged PR

- **WHEN** FE-142 is `in_progress`, and Bob's agent links a PR to FE-142 that had already merged, and Bob is a member of FE-142's target team FE
- **THEN** a done proposal is created with Bob as its accountable human
- **AND** FE-142 keeps its current state until the proposal is confirmed

#### Scenario: The requester links an already merged PR

- **WHEN** Alice, the requester of FE-142 and not a member of team FE, links a PR to FE-142 that had already merged
- **THEN** the PR is linked to FE-142
- **AND** no done proposal is created and FE-142 keeps its current state

#### Scenario: Linking a merged PR to an open request

- **WHEN** FE-143 is `open` and Bob's agent links to it a PR that had already merged, and Bob is a member of FE-143's target team FE
- **THEN** the PR is linked to FE-143
- **AND** no done proposal is created and FE-143 stays `open`

#### Scenario: A merge after the claim was released

- **WHEN** PR #88 was linked to FE-142 while Bob had claimed it, Bob then released the claim so that FE-142 is `open`, and PR #88 then merges in a repository that a connected installation covers
- **THEN** FE-142 stays `open`

#### Scenario: A PR in a repository no connected installation covers

- **WHEN** a PR linked to the claimed request FE-142 merges in a repository whose GitHub App installation an admin has not connected
- **THEN** FE-142 does not move to `done`

### Requirement: System actions need no proposal or confirmation

These system actions, which follow signed GitHub events or signed contract reports rather than an agent's decision, SHALL take effect without a proposal and without a confirmation: done on merge, as the requirement on linked PRs defines; the system withdrawal of an unclaimed contract-change request, as the requirement on system withdrawals defines; and the packet revisions and system messages that Tiehall adds to a contract-change request from a signed contract report, including while the request is claimed, as the contract-changes capability defines. Every other commitment, including the done proposal that linking an already merged PR creates and a done proposal that comes from a tracker "Done", SHALL need its confirmation in the web UI like any other.

Source: D14; D23; D30 (3); design.md, Decisions this change rests on; design.md, Design rules: Requests and events

#### Scenario: A contract revision on a claimed request needs no confirmation

- **WHEN** the contract-change request FE-150 is claimed, and a new push to its provider PR brings a signed contract report with 3 breaking changes instead of 2
- **THEN** FE-150 gets a new packet revision with the 3 changes
- **AND** no proposal was created and no confirmation was asked for

#### Scenario: Linking an already merged PR needs a person

- **WHEN** FE-142 is `in_progress` and an agent acting for Bob, a member of its target team, links a PR that merged yesterday to FE-142
- **THEN** FE-142 is not done
- **AND** a done proposal waits for Bob's confirmation in the web UI

### Requirement: System withdrawals never touch a claimed request

Tiehall SHALL withdraw an unclaimed contract-change request as a system action, without a proposal or a confirmation, when its provider PR closes unmerged or its breaking changes disappear, as the contract-changes capability defines. A system withdrawal SHALL NOT apply to a request that is claimed at that moment. Every other withdrawal SHALL be a commitment.

Source: D14; design.md, Decisions this change rests on; design.md, Design rules: Requests and events

#### Scenario: An unclaimed contract request is withdrawn

- **WHEN** the provider PR behind the unclaimed contract-change request FE-150 closes without merging
- **THEN** FE-150 moves to `withdrawn` with no proposal
- **AND** the change is recorded with the actor kind `system`

#### Scenario: A claimed contract request is not withdrawn

- **WHEN** the provider PR behind the claimed contract-change request FE-151 closes without merging
- **THEN** FE-151 keeps its current state

#### Scenario: A released claim no longer protects the request

- **WHEN** Bob claimed the contract-change request FE-152 and then released the claim, so FE-152 is `open` with no claimant, and its provider PR then closes without merging
- **THEN** FE-152 moves to `withdrawn` with no proposal

### Requirement: Per-team request keys

When a request is created, Tiehall SHALL give it a key made of its target team's key, a hyphen and a number from a counter kept per team, for example `FE-142`. Numbers SHALL be unique within a team and SHALL NOT be reused, and each team's counter SHALL be independent of every other team's.

Source: design.md, Design rules: Requests and events

#### Scenario: The next number in the team

- **WHEN** the last request created for team FE is FE-141 and a new request is opened to FE
- **THEN** the new request's key is FE-142

#### Scenario: Teams count separately

- **WHEN** a request is opened to team BE right after FE-142 was created
- **THEN** its number comes from BE's counter and FE's next number is still 143

#### Scenario: Concurrent creates get distinct keys

- **WHEN** two requests are opened to team FE at the same moment
- **THEN** they get two different keys

### Requirement: Request keys that use a renamed team key keep resolving

When a team's key is renamed, which the teams-and-roles capability defines, the old key SHALL remain an alias of that team, so request keys and URLs that use the old key SHALL keep resolving to the same requests.

Source: design.md, Design rules: Teams and roles

#### Scenario: An old key still resolves

- **WHEN** team FE's key is renamed to WEB
- **AND** a client reads FE-142
- **THEN** Tiehall returns the request that was created as FE-142

### Requirement: Reassignment gives a new key and the old key redirects

Reassigning a request to another team of the install SHALL be a commitment that members of the current target team propose. When the reassignment is confirmed, the new team SHALL become the request's target team, the request SHALL return to `open` with no claimant, it SHALL get a new key from the new team's counter, and the old key SHALL redirect to the new key. Confirming a reassignment SHALL also cancel every other pending proposal on the request, as the requirement on how a proposal ends defines, so that no proposal made while the old team owned the request can be confirmed for the new team. Undoing a confirmed reassignment within the undo window SHALL restore the old team, the old key and the old tracker mirror, and the new key SHALL then redirect to the old key; the proposals the reassignment cancelled SHALL stay cancelled. How the tracker mirror moves is defined by the tracker-mirrors capability.

Source: D23; D28 #18; D30 (4); design.md, Decisions this change rests on; design.md, Design rules: Requests and events

#### Scenario: A confirmed reassignment

- **WHEN** FE-142 is `in_progress` with Bob as the claimant, and a reassignment of FE-142 to team MOB is confirmed while MOB's last request was MOB-36
- **THEN** the request's key becomes MOB-37 and its target team is MOB
- **AND** MOB-37 is `open` with no claimant
- **AND** a read or URL that uses FE-142 redirects to MOB-37

#### Scenario: Undoing a reassignment

- **WHEN** Bob confirmed the reassignment of FE-142 to team MOB, which made it MOB-37, and 10 minutes later Bob uses the undo link from the receipt and confirms the undo in the web UI
- **THEN** the request's target team is FE again and its key is FE-142
- **AND** its tracker mirror is the one it had under FE
- **AND** a read or URL that uses MOB-37 redirects to FE-142

#### Scenario: An unconfirmed reassignment changes nothing

- **WHEN** an agent proposes reassigning FE-142 to team MOB and the proposal is still waiting
- **THEN** the request's key is still FE-142 and its target team is still FE

### Requirement: Messages are append-only

Messages in a request's thread SHALL be append-only. Editing a message SHALL add a new version and SHALL NOT overwrite or remove the earlier one.

Source: design.md, Design rules: Requests and events

#### Scenario: Editing a message

- **WHEN** Bob edits a message they posted on FE-142
- **THEN** a new version of the message is added
- **AND** the earlier version is kept unchanged

### Requirement: Provenance is stamped by the server

Every message SHALL carry provenance: the accountable human; the actor kind (`human`, `agent`, `system`, `integration` or `web_session`); the client (the Client ID Metadata Document URL, the OAuth client or the CLI version); the surface (`web`, `mcp`, `cli`, `api`, `github` or `jira`); and the team. Tiehall SHALL stamp all of it from the caller's token or session and SHALL ignore any provenance that the payload supplies. An action taken through a web session, including the confirmation of a proposal and the undo of a commitment, SHALL be recorded with the actor kind `web_session` and the surface `web`, because the server cannot tell a person from an agent that drives a browser. In v1, Tiehall SHALL NOT record anything with the actor kind `human`; the value stays reserved for a later confirmation that proves a person acted. A call to `/api/v1` that does not come through the `tiehall` CLI, such as a call made with a personal access token, SHALL be recorded with the surface `api`. A call made with an OAuth token or a personal access token, on any surface, SHALL be recorded with the actor kind `agent`. A request that a CI caller's contract report opens, and the packet revisions and system messages that Tiehall adds from such a report, SHALL be recorded with the actor kind `system` and the surface `github`.

Source: D28 #19; D30 (3); design.md, Decisions this change rests on; design.md, Design rules: Requests and events; design.md, Self-hosting decisions: S7

#### Scenario: A payload cannot fake provenance

- **WHEN** an MCP client holding a token that Bob approved posts a message whose payload claims the surface `web` and the actor kind `human`
- **THEN** the message is recorded with the actor kind `agent`, the surface `mcp`, the token's client and Bob as the accountable human
- **AND** the provenance fields in the payload are ignored

#### Scenario: A web action is recorded as a web session

- **WHEN** Bob posts a message on FE-142 in the web UI
- **THEN** the message's provenance has the actor kind `web_session` and the surface `web`
- **AND** Bob is its accountable human

#### Scenario: A confirmation is recorded as a web session

- **WHEN** Bob confirms a decline proposal for FE-142 on its confirm page
- **THEN** the confirmation's event records the actor kind `web_session`, the surface `web` and Bob
- **AND** nothing about it is recorded with the actor kind `human`

#### Scenario: A system message

- **WHEN** Tiehall posts a system message such as "diff updated: 2 → 3 breaking" on a contract-change request
- **THEN** the message's actor kind is `system`

#### Scenario: A direct API call is recorded as api

- **WHEN** Bob's script posts a message on FE-142 through `/api/v1` with a personal access token that Bob created
- **THEN** the message's provenance has the actor kind `agent`, the surface `api` and Bob as its accountable human

#### Scenario: A request that CI opens

- **WHEN** a signed contract report from the provider's CI opens the contract-change request FE-150
- **THEN** the opening of FE-150 is recorded with the actor kind `system` and the surface `github`

### Requirement: The event log

Every committed change to a request, namely its creation, messages, packet revisions, claims and state changes, proposals, their confirmations and how they ended, undos of commitments, the setting and clearing of the `needs_human` flag, PR links and contract changes, SHALL append a domain event to the install's event log in the same transaction as the change, so that an event exists if and only if its change committed. Each event SHALL take the next number of one sequence kept for the install, and sequence order SHALL equal commit order. Events SHALL be in the domain class or the security class; this capability defines the domain events about requests, and the activity-log capability defines the security events and how admins see and export the log.

Source: D30 (4); design.md, Decisions this change rests on; design.md, Design rules: Requests and events; design.md, Self-hosting decisions: S14

#### Scenario: A failed change leaves no event

- **WHEN** opening a request fails and nothing is stored
- **THEN** no event about it appears in the event log

#### Scenario: A rejected proposal leaves an event

- **WHEN** Bob rejects the pending decline proposal for FE-142
- **THEN** the event log has an event for FE-142 that names the proposal as rejected

#### Scenario: A late commit is never skipped

- **WHEN** two changes commit concurrently
- **THEN** a reader that has received event 57 never later receives an unseen event numbered 57 or lower

### Requirement: Events carry ids, not bodies

An event SHALL refer to requests, messages and packet revisions by id and SHALL NOT carry message or packet bodies. A reader SHALL fetch the content through a read operation.

Source: design.md, Design rules: Requests and events

#### Scenario: A message event

- **WHEN** Bob posts a question on FE-142
- **THEN** the resulting event names FE-142 and the message id
- **AND** it does not contain the question's text

### Requirement: Read cursors move only on acknowledgement

Tiehall SHALL keep a read cursor per user and per client. A cursor SHALL advance only when its reader acknowledges events; reading without acknowledging SHALL leave it where it was.

Source: design.md, Design rules: Requests and events

#### Scenario: Reading without acknowledging

- **WHEN** Alice's agent reads their new events without acknowledging them
- **THEN** its next read returns the same events again

#### Scenario: Acknowledging

- **WHEN** Alice's agent acknowledges events up to number 60
- **THEN** its next read starts after event 60

#### Scenario: Each client has its own cursor

- **WHEN** Alice acknowledges events up to number 60 through the `tiehall` CLI
- **THEN** the cursor of Alice's MCP client does not move

### Requirement: Readers get only domain events they may see

Event reads, long-poll wake-ups and read cursors SHALL serve only domain events about requests the reader may see. Which of those events a reader of the requester loop gets is narrowed further by the requester-loop capability. Security events SHALL NOT be served through them; the activity-log capability shows those to admins.

Source: D28 #58; design.md, Decisions this change rests on; design.md, Design rules: Requests and events; design.md, Self-hosting decisions: S14

#### Scenario: A role change is not an update

- **WHEN** an admin changes a member's role
- **THEN** no event about the change appears in any member's event reads
- **AND** it does not wake a waiting long-poll

#### Scenario: A removed member reads no events

- **WHEN** Dana has been removed from the install and Dana's agent asks for new events with a token Dana approved earlier
- **THEN** Tiehall answers 403
- **AND** no event is returned

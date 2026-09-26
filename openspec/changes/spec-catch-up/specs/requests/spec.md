# Spec Delta: requests

## Purpose

Brings the requests capability up to what the code does: the request title and its bounds; a release, a reassignment and a departed member's release while the request waits on a question; the bounds of a message body; the read of one message with all its versions; and the state-change event.

## MODIFIED Requirements

### Requirement: A request is addressed to a team of the install

Every request SHALL be addressed to exactly one target team of the install. Tiehall SHALL record the requesting user and the requesting team, except where the contract-changes capability names a different requester. Every request SHALL carry a title, which its requester writes when they open it: one line of 1 to 200 characters, after leading and trailing blanks are removed, with no line break or other control character. The title is user text: every read SHALL return it under the request's `untrusted` object, as the agent-safety capability defines, apart from the key, the state and the ids Tiehall writes. A request opened without a title, or with a title outside these bounds, SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema, and nothing SHALL be created. A request addressed to a team the install does not have SHALL be refused with 404, as the public-api capability's error model defines for a record that does not exist, and nothing SHALL be created. An install serves one company, so requests between companies do not exist in v1.

Source: D25; D45 (1), (2); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S1; design.md, Decisions: D45 (1), (2)

#### Scenario: Opening a request to another team

- **WHEN** Alice, a member of team BE, opens a request addressed to team FE
- **THEN** a request is created with FE as its target team
- **AND** Alice and team BE are recorded as the requester
- **AND** the request is in state `open`

#### Scenario: A team the install does not have

- **WHEN** Alice opens a request through `/api/v1` addressed to the team key `ZZ`, which names no team of the install
- **THEN** Tiehall answers 404 with an RFC 9457 problem
- **AND** no request is created

#### Scenario: The title is returned as user text

- **WHEN** Alice opens a request to team FE with the title "Add a dark mode", and Carol, a member of team OPS, reads it through `/api/v1`
- **THEN** the title "Add a dark mode" sits under the request's `untrusted` object
- **AND** the request's key, state and ids sit outside it

#### Scenario: A title outside its bounds

- **WHEN** Alice's agent opens a request to team FE through `/api/v1` whose title is 201 characters long, or holds a line break, or is blanks only, or is missing
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** no request is created

### Requirement: Allowed state changes

Tiehall SHALL allow these state changes, besides the ones the other requirements of this capability define:
- a decline and a withdrawal SHALL be allowed from any state that is not terminal;
- a move to `done` SHALL be allowed only from `claimed`, `in_progress` or `needs_info`;
- the claimant SHALL be able to release their claim without a proposal, which returns the request to `open` with no claimant, except while the request is `needs_info`: then the release SHALL keep it in `needs_info` with no claimant, and once every blocking question on it has an answer the request SHALL return to `open`, as the requirement on thread messages defines for a request that no longer has a claimant;
- when the claimant is no longer a member of the install, any member of the request's target team SHALL be able to release that claim in the same way, without a proposal.

A change that the request's current state does not allow, such as claiming a request that is not `open`, marking an `open` request done, or releasing a request in `needs_info` that nobody holds, SHALL be refused with 409, as the public-api capability's error model defines for a state conflict; the request SHALL NOT change and no proposal SHALL be created. Only the claimant SHALL be able to release a claim, except that any member of the target team MAY release a claim held by someone who is no longer a member of the install; anyone else who tries SHALL be refused with 403.

Source: D28 #10, #13; D29 (3); D46 (1); design.md, Decisions this change rests on; design.md, Decisions: D46 (1)

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

#### Scenario: A release while the request waits on a question

- **WHEN** FE-142 is `needs_info` after Bob's agent posted a blocking question while FE-142 was `in_progress`, and Bob's agent releases the claim
- **THEN** FE-142 stays `needs_info` with no claimant
- **AND** Erin's request through `/api/v1` to claim FE-142 while it waits is answered 409
- **AND** when the requester's agent answers the question, FE-142 is `open` with no claimant

#### Scenario: Nobody holds a request blocked during triage

- **WHEN** FE-143 is `needs_info` after a blocking question posted while it was `open`, and Erin, a member of team FE, asks through `/api/v1` to release it
- **THEN** Tiehall answers 409 with an RFC 9457 problem
- **AND** FE-143 stays `needs_info`

### Requirement: Thread messages and blocking questions

A message in a request's thread SHALL be a comment, a question or an answer, and a question SHALL be markable as blocking. Only the two sides of the request, the requester side and the members of the target team, SHALL be able to post messages on it; a member who is on neither side SHALL be refused with 403, as the public-api capability's error model defines for a caller whose part in the request does not allow the action, and nothing SHALL be added. Tiehall's own system messages and notices are not posted by a caller and are not limited by this. A message's body SHALL be 1 to 65,536 characters, not all blank, with no NUL character, and SHALL be kept exactly as written; a body outside these bounds SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema, and nothing SHALL be added. Every answer SHALL name the question it answers; an answer that names no question SHALL be refused with 400. A blocking question SHALL move a request that is `open`, `claimed` or `in_progress` to `needs_info`. The request SHALL stay in `needs_info` until every blocking question on it has an answer, and SHALL then return to the state it was in before the first of those questions moved it, or to `open` when it no longer has a claimant, because its claim was released or it was reassigned while it waited. A comment or a non-blocking question SHALL NOT change the request's state. How often an agent may make a request flip between `needs_info` and `in_progress` is limited by the agent-safety capability.

Source: D9; D11; D28 #3, #17; D45 (2); D46 (1); design.md, Decisions this change rests on; design.md, Design rules: Requests and events; design.md, Decisions: D45 (2); design.md, Decisions: D46 (1)

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

#### Scenario: A body outside its bounds

- **WHEN** Alice's agent posts a comment on FE-142 through `/api/v1` whose body is 65,537 characters long, or is empty, or is blanks only, or holds a NUL character
- **THEN** Tiehall answers 400 with an RFC 9457 problem
- **AND** nothing is added to the thread of FE-142

#### Scenario: The last answer after a release returns the request to open

- **WHEN** Bob's agent posted a blocking question on FE-142 while it was `in_progress`, Bob's agent then released the claim, and the requester's agent answers the question
- **THEN** FE-142 is `open` with no claimant

### Requirement: A removed member's claims stay and their proposals are cancelled

When a member is removed from the install, whether an admin removed them, as the teams-and-roles capability defines, or they lost access by leaving the GitHub organization through which they joined, as the sign-in capability defines, the requests they have claimed SHALL stay claimed by them, and the target team SHALL still be able to reassign those requests. Any member of the target team SHALL also be able to release such a claim without a proposal, which returns the request to `open` with no claimant, or keeps it in `needs_info` with no claimant while it waits on a blocking question, as the requirement on allowed state changes defines, so that another member can claim it once it is `open`. Every pending proposal whose accountable human is the removed member SHALL be cancelled. Any later call the removed member makes SHALL be refused with 403.

Source: D28 #10; D29 (3); D46 (1); design.md, Decisions this change rests on; design.md, Design rules: Teams and roles; design.md, Self-hosting decisions: S5; design.md, Decisions: D46 (1)

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

#### Scenario: The team takes over a removed member's request that waits on a question

- **WHEN** Dana has been removed from the install while claiming FE-142, which is `needs_info` after Dana's agent posted a blocking question while it was `in_progress`, and Bob, a member of team FE, releases Dana's claim
- **THEN** FE-142 stays `needs_info` with no claimant and no proposal is created
- **AND** when the requester's agent answers the question, FE-142 is `open` with no claimant
- **AND** Bob can then claim FE-142 for themselves

### Requirement: Reassignment gives a new key and the old key redirects

Reassigning a request to another team of the install SHALL be a commitment that members of the current target team propose. When the reassignment is confirmed, the new team SHALL become the request's target team, it SHALL get a new key from the new team's counter, and the old key SHALL redirect to the new key. The request SHALL return to `open` with no claimant, or, while it waits on a blocking question, SHALL stay in `needs_info` with no claimant and return to `open` in the new team once every blocking question has an answer, as the requirement on thread messages defines. Confirming a reassignment SHALL also cancel every other pending proposal on the request, as the requirement on how a proposal ends defines, so that no proposal made while the old team owned the request can be confirmed for the new team. Undoing a confirmed reassignment within the undo window SHALL restore the old team, the old key and the old tracker mirror, and the new key SHALL then redirect to the old key; the proposals the reassignment cancelled SHALL stay cancelled. How the tracker mirror moves is defined by the tracker-mirrors capability.

Source: D23; D28 #18; D30 (4); D46 (1); design.md, Decisions this change rests on; design.md, Design rules: Requests and events; design.md, Decisions: D46 (1)

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

#### Scenario: A reassignment confirmed while the request waits on a question

- **WHEN** FE-142 is `needs_info` after Bob's agent posted a blocking question while it was `in_progress`, and a reassignment of FE-142 to team MOB is confirmed while MOB's last request was MOB-36
- **THEN** the request's key becomes MOB-37 and its target team is MOB
- **AND** MOB-37 stays `needs_info` with no claimant, and the event log gains no state-change event for it
- **AND** when the requester's agent answers the question, MOB-37 is `open` with no claimant

### Requirement: Messages are append-only

Messages in a request's thread SHALL be append-only. Editing a message SHALL add a new version and SHALL NOT overwrite or remove the earlier one. A message SHALL be readable on its own, by its id, by every member of the install, with every version of its text, oldest first, each with its number and the time it was added, and with the request whose thread holds it, named by its id, its key and its target team; the thread of a request shows each message with its latest version and the time it was last edited. An id that names no message of the install SHALL be refused with 404, as the public-api capability's error model defines for a record that does not exist.

Source: D45 (3); design.md, Design rules: Requests and events; design.md, Decisions: D45 (3)

#### Scenario: Editing a message

- **WHEN** Bob edits a message they posted on FE-142
- **THEN** a new version of the message is added
- **AND** the earlier version is kept unchanged

#### Scenario: Reading a message with every version

- **WHEN** Bob posted a comment on FE-142 and edited it once, and Carol, a member of team OPS, reads that message by its id through `/api/v1`
- **THEN** the answer holds version 1 with the text as Bob first wrote it and version 2 with the edited text, in that order
- **AND** it names FE-142 as the request whose thread holds the message
- **AND** the thread of FE-142 shows the message with version 2 and the time it was edited

#### Scenario: A message that does not exist

- **WHEN** Carol reads a message id through `/api/v1` that names no message of the install
- **THEN** Tiehall answers 404 with an RFC 9457 problem

### Requirement: The event log

Every committed change to a request, namely its creation, messages, packet revisions, claims and state changes, proposals, their confirmations and how they ended, undos of commitments, the setting and clearing of the `needs_human` flag, PR links and contract changes, SHALL append a domain event to the install's event log in the same transaction as the change, so that an event exists if and only if its change committed. Each event SHALL take the next number of one sequence kept for the install, and sequence order SHALL equal commit order. Events SHALL be in the domain class or the security class; this capability defines the domain events about requests, and the activity-log capability defines the security events and how admins see and export the log.

A change of state that another change brings about SHALL append its own domain event, which names the request, the state it left and the state it is in now: a blocking question moving a request to `needs_info` and the answer that returns it; a decline, a withdrawal or a done proposal taking effect; a confirmed reassignment that returns the request to `open`; and an undo that restores an earlier state. A claim, the start of work and the release of a claim are recorded by their own events and SHALL add no state-change event.

Source: D30 (4); D45 (4); design.md, Decisions this change rests on; design.md, Design rules: Requests and events; design.md, Self-hosting decisions: S14; design.md, Decisions: D45 (4)

#### Scenario: A failed change leaves no event

- **WHEN** opening a request fails and nothing is stored
- **THEN** no event about it appears in the event log

#### Scenario: A rejected proposal leaves an event

- **WHEN** Bob rejects the pending decline proposal for FE-142
- **THEN** the event log has an event for FE-142 that names the proposal as rejected

#### Scenario: A late commit is never skipped

- **WHEN** two changes commit concurrently
- **THEN** a reader that has received event 57 never later receives an unseen event numbered 57 or lower

#### Scenario: A blocking question's state change is its own event

- **WHEN** Bob's agent posts a blocking question on FE-142 while it is `claimed`, and the requester's agent then answers it
- **THEN** the event log has, after the event for the question, a state-change event for FE-142 from `claimed` to `needs_info`
- **AND** after the event for the answer, a state-change event for FE-142 from `needs_info` to `claimed`
- **AND** neither carries the text of either message

#### Scenario: A claim adds no state-change event

- **WHEN** Bob's agent claims FE-142, starts work on it and then releases the claim
- **THEN** the event log has an event for the claim, one for the start and one for the release
- **AND** no state-change event for FE-142

#### Scenario: A confirmed decline is a state change

- **WHEN** FE-142 is `open` and Bob confirms its decline proposal in the web UI
- **THEN** the event log has, after the confirmation's event, a state-change event for FE-142 from `open` to `declined`

# Spec Delta: requests

## Purpose

States that every confirmation gets a receipt, that an undo keeps a team's required fields, how close on merge reads keys, links and mentions, and where a new reader's cursor starts. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Receipts

After every confirmation, Tiehall SHALL give the person who gave it a receipt that states in server-generated words exactly what was confirmed. This SHALL hold for every action that the agent-safety capability confirms with the confirmation step, not only for proposals: creating a personal access token, approving an agent client or the CLI, a role change, a removal, an invite, a change of the sign-in policy, of the PAT settings or of the write budget, connecting a GitHub installation, uploading the App's private key or storing its webhook secret, connecting or changing the Jira connection, registering an API, a fan-out and an export of the activity log. A receipt SHALL never hold a secret, a key or a token's value. The receipt SHALL be listed in the standing list of their web inbox, as the requester-loop capability defines, and, when email is set up as the self-host-install capability defines for SMTP, SHALL also be sent by email. For a commitment that needs a confirmation from each side, the receipt for the accountable human's confirmation SHALL state that the commitment waits for the other side, and when the other side's confirmation makes the commitment take effect, both people who confirmed it SHALL get a receipt that states what took effect. If the proposal instead ends without taking effect, the receipt in the accountable human's standing list SHALL show how it ended. When a commitment is undone, each person who confirmed it SHALL get a receipt, in the same places, that states what was undone and by whom. Receipt emails are transactional: turning off the daily digest SHALL NOT stop them.

Source: D23; D28 #61; D30 (4); D55 (81); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: Creating a personal access token gives a receipt

- **WHEN** the install has SMTP set, and Lee creates a personal access token in the web UI with the confirmation step
- **THEN** Lee's web inbox lists a receipt stating that Lee created a personal access token and when it expires
- **AND** Lee gets the same receipt by email
- **AND** neither holds the token's value

#### Scenario: A role change gives a receipt

- **WHEN** Pia, an admin, changes Lee's role to `admin` and confirms it on the review page
- **THEN** Pia's web inbox lists a receipt stating that Lee's role was changed to `admin` by Pia's confirmation

### Requirement: The undo window for reversible commitments

Commitments that can be reversed, which are a due date, a scope change, a reassignment and a decline, SHALL get an undo window of 15 minutes that starts when the commitment takes effect, linked from the receipt that states it took effect. Undo SHALL cover only these four commitments. Only a person who confirmed the commitment SHALL be able to undo it, and for a commitment that needed a confirmation from each side, either of the two people who confirmed it MAY undo it alone; anyone else SHALL be refused with 403. An undo SHALL be confirmed in the web UI with the confirmation step, as the agent-safety capability defines; an undo request without a valid confirmation SHALL be refused as that capability defines.

Using undo within the window SHALL restore the state from before the commitment; for a reassignment, that means the old team, the old key and the old tracker mirror, and the new key then redirects to the old one, as the requirement on reassignment defines. Undoing a due date or a scope change SHALL be refused with 409 when the request's current revision is no longer the one the commitment created, such as after a contract report added a revision, so that no later revision is lost. Undoing a due date or a scope change SHALL also be refused, with HTTP 400 and the problem type `invalid-input`, when the packet it would restore, as the next revision, lacks a field that the current revision has and that the team the request is addressed to requires, or, while a reassignment of the request is pending, that the team it would move to requires, as the agent-surfaces capability's requirement on a team's required fields defines; such an undo SHALL restore nothing, and the reassignment SHALL stay pending. After 15 minutes the undo SHALL be refused with 409. An undo and its event SHALL be recorded together or not at all, like a confirmation, with the actor kind `web_session`, and each person who confirmed the commitment SHALL get a receipt for it, as the requirement on receipts defines.

Source: D28 #18, #34; D30 (4); D55 (41); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: An undo that would drop a required field is refused

- **WHEN** Alice and Bob confirmed a due date for FE-142, which had none, a reassignment of FE-142 to MOBILE, which requires a due date, is pending, and 5 minutes later Alice uses the undo link and confirms the undo in the web UI
- **THEN** the undo is refused with HTTP 400 and the problem type `invalid-input`, whose detail names MOBILE and its due date
- **AND** FE-142 keeps its due date
- **AND** the reassignment of FE-142 to MOBILE stays pending

#### Scenario: Other commitments have no undo

- **WHEN** Alice confirms withdrawing FE-142
- **THEN** the receipt for the withdrawal carries no undo link

### Requirement: Linked PRs and done on merge

Tiehall SHALL let an agent acting for its signed-in user link PRs to a request without a proposal. A request SHALL move to `done` as a system action, without a proposal or a confirmation, when a PR merges that meets all three conditions: it was linked to the request by the request's claimant or a member of its target team, or mentioned the request's key in its title, body or branch name, before it merged; it merged after the request was claimed; and it is in a repository that a connected installation of the install's GitHub App covers, as the tracker-mirrors capability defines. Close on merge SHALL apply only while the request is `claimed`, `in_progress` or `needs_info`. Linking a PR that has already merged SHALL create a done proposal instead, when the user who links it is a member of the request's target team and the request's state allows a move to `done`; when anyone else links it, or the state does not allow `done`, the PR SHALL only be linked and no proposal SHALL be created. The provider PR of a contract-change request never closes that request, as the contract-changes capability defines. A tracker "Done" SHALL NOT close a request by itself; the tracker-mirrors capability defines what it does.

A link that anyone else makes SHALL be recorded and shown on the request, but SHALL NOT count for close on merge. A key SHALL count as mentioned only as written: the team key in upper case, a hyphen and the number, such as `FE-142`, not inside a longer word or number, so a branch such as `renovate/node-22`, or text such as `utf-8`, mentions no request. A key in a PR's title or body SHALL count as mentioned before the merge only when Tiehall read it while the PR was open, from a delivery or a poll: the keys that count are those of the latest read that found the PR open, so in polling mode a key written and merged within one poll is missed, and a key read during an earlier open period still counts after the PR is reopened until a later read finds it gone. The name of the PR's head branch cannot change, so a key in it SHALL count even when Tiehall reads it only after the merge. A claim or a link recorded in the same second as the merge SHALL count as made before it, because GitHub gives merge times in whole seconds. Close on merge acts as the integration event that brings the merge, as the agent-access capability defines: for the Tiehall user of the account that merged the PR while that user is a member, and for no user otherwise. A PR in a repository that no connected installation covers SHALL be linked when someone links it, and its merge SHALL close nothing.

Source: D14; D23; D37; D55 (66), (67), (72), (73); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A qualifying PR merges

- **WHEN** the agent of Bob, a member of FE-142's target team FE, links PR #88 to FE-142 after FE-142 was claimed, and PR #88 is in a repository that a connected installation covers
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

#### Scenario: A key in another case mentions nothing

- **WHEN** NODE-22 and UTF-8 are claimed requests, and a PR whose branch is `renovate/node-22` and whose body says "convert the file to utf-8" merges in a repository that a connected installation covers
- **THEN** NODE-22 and UTF-8 keep their states

#### Scenario: A link by the requester side does not close the request

- **WHEN** Alice, the requester of the claimed request FE-142 and not a member of team FE, links PR #88 to FE-142, and PR #88 then merges in a repository that a connected installation covers
- **THEN** PR #88 is shown as linked to FE-142
- **AND** FE-142 keeps its state

#### Scenario: A key written after the merge does not count

- **WHEN** PR #90 merged in a repository that a connected installation covers, and its body is then edited to mention the claimed request FE-142
- **THEN** FE-142 keeps its state

#### Scenario: A claim in the same second as the merge

- **WHEN** Bob claims FE-142 at 10:00:05.200 and a PR that mentions `FE-142` in its branch name merges at 10:00:05, as GitHub gives the time
- **THEN** FE-142 moves to `done` with no proposal

### Requirement: Read cursors move only on acknowledgement

Tiehall SHALL keep a read cursor per user and per client. A cursor SHALL advance only when its reader acknowledges events; reading without acknowledging SHALL leave it where it was. A reader that has no cursor yet, such as a new MCP client of the user or the CLI's first login, SHALL start at the user's web inbox cursor, not at the first event.

Source: D55 (44); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: Reading without acknowledging

- **WHEN** Alice's agent reads their new events without acknowledging them
- **THEN** its next read returns the same events again

#### Scenario: Acknowledging

- **WHEN** Alice's agent acknowledges events up to number 60
- **THEN** its next read starts after event 60

#### Scenario: Each client has its own cursor

- **WHEN** Alice acknowledges events up to number 60 through the `tiehall` CLI
- **THEN** the cursor of Alice's MCP client does not move

#### Scenario: A new client starts at the web inbox's place

- **WHEN** Alice has acknowledged events up to number 60 in their web inbox, and a new MCP client of Alice's reads its events for the first time
- **THEN** its first read starts after event 60

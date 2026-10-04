# Spec Delta: tracker-mirrors

## Purpose

States what a removed webhook does to GitHub's mode and its banner, how mappings and their issues relate, that a close as a duplicate is not a tracker "Done", how dead-lettered and gone mirrors are handled, and what an undone reassignment writes. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: GitHub and Jira each run in webhook mode or polling mode

GitHub and Jira SHALL each run in webhook mode or in polling mode, and both modes SHALL feed the same processing, so a change has the same effect whichever way it arrives. When the setup screen stores the credentials of the install's GitHub App, in setup or in a step that `setup reopen` opened, as the self-host-install capability defines, GitHub's mode SHALL be set from them as they are stored: polling mode for an App created without a webhook, and webhook mode for an App created with one. For an App created with a webhook, Tiehall SHALL, after the first installation, read the App's webhook delivery log through GitHub's API, and a failed delivery to the install SHALL put GitHub in polling mode. Only deliveries made after the App's credentials were stored SHALL count, because the install accepts deliveries from then on; the delivery for the installation made during setup SHALL be the first that counts. An App without a webhook has no delivery log, and GitHub answers a request for it with 404: while no webhook secret is stored, Tiehall SHALL NOT take that answer for a failed delivery, SHALL NOT change the mode for it, and SHALL NOT report it to admins as a broken integration. While GitHub runs in webhook mode and a webhook secret is stored, a 404 for the delivery log SHALL mean that GitHub holds no webhook for the App any more, as when someone removed it in the App's settings: Tiehall SHALL then put GitHub in polling mode, whoever last set the mode, because no delivery can arrive, and SHALL show the banner that the requirement on broken integrations defines. Jira SHALL run in polling mode until a Jira webhook has delivered an event that Tiehall accepted, and in webhook mode after that. The admin page SHALL show each integration's mode, and an admin SHALL be able to switch either integration to the other mode in the web UI. In webhook mode, when Tiehall gives up a GitHub delivery, as the requirement on redelivery defines, it SHALL put GitHub in polling mode, as a failed delivery after the first installation does, unless the latest change of GitHub's mode was an admin's switch to webhook mode for the App in use, which Tiehall SHALL NOT undo; either way it SHALL show the banner that the requirement on broken integrations defines. A change of GitHub's mode that Tiehall makes on its own SHALL be recorded as a security event for a changed integration that names no user, as the activity-log capability defines. GitHub SHALL NOT be switched to webhook mode while no webhook secret is stored: such a switch SHALL be refused with 409, as the public-api capability's error model defines for a state conflict, and SHALL change nothing. While no webhook secret is stored and `TIEHALL_URL` is not a trial URL, as the self-host-install capability defines trial URLs, the admin page SHALL show the steps that move GitHub to webhook mode: in the App's settings on GitHub, make the webhook active with the URL `TIEHALL_URL/webhooks/github` and a secret, and subscribe to the events that the requirement on the App's permissions lists; in Tiehall, store the same secret; then switch GitHub to webhook mode. On a trial URL, the admin page SHALL say instead that GitHub cannot deliver webhooks to it. An admin SHALL store the App's webhook secret in the web UI with the confirmation step, as the agent-safety capability defines; a request to store it from a member who is not an admin SHALL be refused with 403, and one with an empty secret, or with a secret of more than 1,024 characters, with 400, as the public-api capability's error model defines, and neither SHALL store anything. The secret SHALL be stored as the self-host-install capability defines for stored integration secrets, SHALL replace any webhook secret stored before, SHALL NOT appear in any URL, and SHALL NOT be shown on any page, the review page included; storing it SHALL be recorded as a security event for a changed integration, as the activity-log capability defines. In polling mode, Tiehall SHALL poll every 60 seconds: on GitHub, the PRs linked to open requests, the PRs in covered repositories updated since the last poll, for key mentions and provider PRs, and the mirror issues; on Jira, the issues in the mapped projects updated in the last 2 minutes. In polling mode a change SHALL be picked up within 2 minutes, within the rate limits of GitHub and Jira.

Source: D28 #4, #48; D49; D50 (13), (15); D55 (6); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: An install GitHub cannot reach polls GitHub

- **WHEN** the install at `https://tiehall.example.com` is reachable only inside the company network, and after the first installation the App's delivery log shows a failed delivery to `https://tiehall.example.com/webhooks/github`
- **THEN** GitHub runs in polling mode and the admin page says so
- **AND** a PR that mentions `FE-142` and merges after the claim moves `FE-142` to `done` within 2 minutes of the merge

#### Scenario: A reachable install stays in webhook mode

- **WHEN** the install at `https://tiehall.example.com` is reachable from the internet, and the App's delivery log shows one failed delivery made before the setup screen stored the App's credentials and a successful delivery of the `installation` event for `acme` made during setup
- **THEN** GitHub runs in webhook mode

#### Scenario: Jira polls until a webhook arrives

- **WHEN** an admin has connected Jira and mapped the DATA team to the project `DAT`, and no Jira webhook has delivered an event
- **THEN** Jira runs in polling mode
- **AND** an assignee change on the Jira mirror issue of `DATA-9` is recorded on `DATA-9` within 2 minutes

#### Scenario: A delivered Jira webhook switches Jira to webhook mode

- **WHEN** Jira runs in polling mode and a Jira webhook delivers an event that Tiehall accepts
- **THEN** Jira runs in webhook mode and the admin page says so

#### Scenario: An admin switches the mode

- **WHEN** GitHub runs in webhook mode and an admin switches it to polling mode in the web UI
- **THEN** Tiehall polls GitHub every 60 seconds
- **AND** it stops asking GitHub to redeliver failed deliveries

#### Scenario: An App without a webhook polls from the start

- **WHEN** `TIEHALL_URL` is `http://localhost:3000`, the setup screen has stored the credentials of the App, which has no webhook, and Omar has completed setup
- **THEN** GitHub runs in polling mode and the admin page says so
- **AND** a PR that mentions `FE-142` and merges after the claim moves `FE-142` to `done` within 2 minutes of the merge

#### Scenario: No delivery log is no failure

- **WHEN** GitHub runs in polling mode for an App created without a webhook, and GitHub answers a request for the App's delivery log with 404
- **THEN** GitHub stays in polling mode
- **AND** no admin sees a banner or gets an email about a broken integration

#### Scenario: The admin page shows the steps to webhook mode

- **WHEN** the install at `https://tiehall.example.com` has an App without a webhook, and Ada, an admin, opens the admin page
- **THEN** the page shows that GitHub runs in polling mode
- **AND** it shows the steps: in the App's settings on GitHub, the active webhook with the URL `https://tiehall.example.com/webhooks/github` and a secret, and the events `pull_request`, `issues` and `organization`; in Tiehall, the same secret; then the switch to webhook mode

#### Scenario: The admin page of a trial install

- **WHEN** `TIEHALL_URL` is `http://localhost:3000`, and Ada, an admin, opens the admin page
- **THEN** the page shows that GitHub runs in polling mode
- **AND** it says that GitHub cannot deliver webhooks to `http://localhost:3000`, and shows no steps to webhook mode

#### Scenario: An admin moves the App to webhook mode

- **WHEN** Ada has added the webhook and the three events in the App's settings on GitHub, enters the same secret in the web UI and confirms it on its review page, and switches GitHub to webhook mode
- **THEN** GitHub runs in webhook mode
- **AND** a delivery signed with that secret is stored, answered with a 2xx status and processed
- **AND** the activity log gains a security event for the changed integration
- **AND** no page, the review page included, shows the secret, and no URL carries it

#### Scenario: No switch to webhook mode without a secret

- **WHEN** no webhook secret is stored, and Ada asks to switch GitHub to webhook mode
- **THEN** the switch is refused with 409 and an RFC 9457 problem
- **AND** GitHub stays in polling mode

#### Scenario: A member who is not an admin cannot store the webhook secret

- **WHEN** Mehmet, a member who is not an admin, asks to store a webhook secret for the install's GitHub App
- **THEN** the request is refused with 403 and an RFC 9457 problem
- **AND** no webhook secret is stored

#### Scenario: A new App stored after `setup reopen` sets the mode

- **WHEN** GitHub runs in polling mode for an App created without a webhook, Omar runs `setup reopen`, and the setup screen stores the credentials of a new App created with a webhook for `https://tiehall.example.com`
- **THEN** GitHub runs in webhook mode
- **AND** after the new App's first installation, a failed delivery to the install in its delivery log puts GitHub in polling mode

#### Scenario: A webhook that breaks later falls back to polling

- **WHEN** GitHub has run in webhook mode since the check after the first installation, and Tiehall gives up a delivery made later
- **THEN** GitHub runs in polling mode and the admin page says so
- **AND** the activity log gains a security event for the changed integration that names no user
- **AND** a PR that mentions `FE-142` and merges after the claim moves `FE-142` to `done` within 2 minutes of the merge

#### Scenario: An admin's switch to webhook mode is not undone

- **WHEN** Ada switched GitHub to webhook mode in the web UI, and Tiehall later gives up a delivery made after the switch
- **THEN** GitHub stays in webhook mode
- **AND** Ada and every other admin see a banner about GitHub's webhook

#### Scenario: A webhook secret longer than its bound

- **WHEN** Ada enters a webhook secret of 1,025 characters for the install's GitHub App and confirms it on its review page
- **THEN** the request is refused with 400
- **AND** no webhook secret is stored

#### Scenario: A webhook secret at its bound

- **WHEN** Ada enters a webhook secret of 1,024 characters for the install's GitHub App and confirms it on its review page
- **THEN** the secret is stored

#### Scenario: A webhook removed on GitHub moves GitHub to polling

- **WHEN** Ada switched GitHub to webhook mode in the web UI with a webhook secret stored, and the App's webhook is then removed in its settings on GitHub, so that GitHub answers a request for the delivery log with 404
- **THEN** GitHub runs in polling mode and the admin page says so
- **AND** the activity log gains a security event for the changed integration that names no user
- **AND** Ada and every other admin see a banner about GitHub's webhook

### Requirement: Each team maps to one tracker

Team mappings SHALL be set by admins, in the web UI only. Because a GitHub issue always belongs to one repository, each team that mirrors into GitHub Issues SHALL map to one intake repository that a connected installation covers, and the team's mirror issues SHALL be created there; a mapping to a repository that no connected installation covers SHALL be refused with 409, as the public-api capability's error model defines for a state conflict. Each team that mirrors into Jira Cloud SHALL map to a project on the install's connected Jira site and to an issue type in that project, which the admin who makes the mapping picks, and its mirror issues SHALL be created in that project with that issue type. Tiehall SHALL refuse a Jira mapping whose project requires fields, for the picked issue type, that Tiehall does not fill, with 409. Each team SHALL mirror into one tracker only: it SHALL map either an intake repository or a Jira project, never both, and a request to add a second mapping for a team that already has one SHALL be refused with 409. A team with neither mapping SHALL get no mirror issues. Removing a team's mapping SHALL stop every write to the mirror issues that mapping made. A new mapping, to the same tracker or to another, SHALL mirror from then on: it SHALL open new issues only for the requests that reach the point at which the team mirrors after the mapping was made, and SHALL make no issue for a request claimed, or in a terminal state, before it existed. A member who is not an admin who asks to change a mapping SHALL be refused with 403.

Source: D28 #1, #4, #48, #81; D55 (75); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: FE's mirrors go to its intake repository

- **WHEN** an admin maps `acme/fe-intake`, which the connected `acme` installation covers, as FE's intake repository, and `FE-142` is claimed
- **THEN** the mirror issue for `FE-142` is created in `acme/fe-intake`

#### Scenario: A repository no connected installation covers is refused

- **WHEN** an admin tries to map `acme/secret-intake`, which no connected installation covers, as FE's intake repository
- **THEN** Tiehall refuses the mapping with 409 and an RFC 9457 problem

#### Scenario: A team mapped to a Jira project gets its mirrors there

- **WHEN** an admin maps the DATA team to the Jira project `DAT` on the install's connected Jira site with the issue type `Task`, and `DATA-9` is claimed
- **THEN** the mirror issue for `DATA-9` is created in the Jira project `DAT` as a `Task`

#### Scenario: A project that requires extra fields is refused

- **WHEN** an admin tries to map DATA to the Jira project `OPS`, whose `Task` issue type requires a custom field that Tiehall does not fill
- **THEN** Tiehall refuses the mapping with 409 and an RFC 9457 problem
- **AND** no mirror issue for DATA's requests is created in `OPS`

#### Scenario: A team mirrors into one tracker only

- **WHEN** FE maps `acme/fe-intake` as its intake repository, and an admin then asks to map FE to the Jira project `FEJ` as well
- **THEN** Tiehall refuses the second mapping with 409 and an RFC 9457 problem
- **AND** FE's mirror issues keep being created in `acme/fe-intake` only

#### Scenario: An unmapped team gets no mirror

- **WHEN** MOBILE has mapped neither an intake repository nor a Jira project, and `MOBILE-17` is claimed
- **THEN** no mirror issue is created for `MOBILE-17`

#### Scenario: A member cannot change a mapping

- **WHEN** Ayşe, a member of FE who is not an admin, asks to map FE to `acme/other-intake`
- **THEN** Tiehall refuses with 403 and an RFC 9457 problem
- **AND** FE's mapping does not change

#### Scenario: Removing a mapping stops the writes

- **WHEN** `FE-142` has a mirror issue in `acme/fe-intake`, an admin removes FE's mapping, and `FE-142` then moves to `in_progress`
- **THEN** Tiehall writes nothing to that issue

#### Scenario: A new mapping fills nothing in

- **WHEN** `FE-142` was claimed before an admin mapped `acme/fe-intake` as FE's intake repository, and `FE-150` is claimed after it
- **THEN** no mirror issue is created for `FE-142`
- **AND** a mirror issue is created for `FE-150` in `acme/fe-intake`

### Requirement: A tracker "Done" never closes a request by itself

A tracker "Done", meaning a closed GitHub mirror issue or a Jira mirror issue moved into the Done status category, SHALL NOT move a request to done by itself. A close that the tracker marks as not planned SHALL NOT count as a tracker "Done": on GitHub, an issue closed with the `state_reason` `not_planned` or `duplicate`; on Jira, an issue moved into the target status of the "not planned" transition that the team's Jira mapping has mapped. While a team's Jira mapping has no "not planned" transition mapped, every move of its Jira mirror issue into the Done status category SHALL count as a tracker "Done". A tracker account SHALL count as mapped to a Tiehall user only when it is the GitHub account that user signs in with, as the sign-in capability defines, or an Atlassian account that user has linked, as the requirement on linking an Atlassian account defines. When the actor of a tracker "Done" is mapped to a Tiehall user who is a member of the request's target team, the side that marks a request done, as the requests capability defines, and an admin has turned on the setting for tracker "Done" proposals in that team's mapping, Tiehall SHALL create a done proposal for that user, who confirms it in the web UI, as the requests capability defines, when the request's state allows a move to `done`. Otherwise, including when the request is in a state from which a move to `done` is not allowed, Tiehall SHALL only add a notice to the request's thread. The setting SHALL be off until an admin turns it on.

Source: D23; D28 #4, #13, #80; D30 (3); D55 (74); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: With the setting off, Done only adds a notice

- **WHEN** the setting is off for FE, and Ayşe, a member of FE, closes the GitHub mirror issue of `FE-142` with the GitHub account they sign in with
- **THEN** `FE-142` keeps its state
- **AND** its thread gets a notice that the tracker issue was closed

#### Scenario: With the setting on, a mapped member's Done becomes a proposal

- **WHEN** the setting is on for FE, and the Atlassian account that Ayşe, a member of FE, linked moves the Jira mirror issue of `FE-142`, which is `in_progress`, into the Done status category
- **THEN** Tiehall creates a done proposal for Ayşe
- **AND** `FE-142` keeps its state until Ayşe confirms the proposal in the web UI

#### Scenario: A Done on an open request only adds a notice

- **WHEN** FE mirrors on open and the setting is on for FE, `FE-143` is `open`, and the Atlassian account that Ayşe, a member of FE, linked moves the Jira mirror issue of `FE-143` into the Done status category
- **THEN** no done proposal is created and `FE-143` stays `open`
- **AND** the thread of `FE-143` gets a notice

#### Scenario: A Done by someone outside the target team only adds a notice

- **WHEN** the setting is on for FE, and Alice, the requester of `FE-142` and not a member of FE, closes the GitHub mirror issue of `FE-142` with the GitHub account they sign in with
- **THEN** no proposal is created and `FE-142` keeps its state
- **AND** the thread of `FE-142` gets a notice

#### Scenario: An unmapped actor's Done only adds a notice

- **WHEN** the setting is on for FE, and a tracker account that is not mapped to any Tiehall user closes the mirror issue of `FE-142`
- **THEN** no proposal is created
- **AND** the thread of `FE-142` gets a notice

#### Scenario: A not-planned close is not a Done

- **WHEN** the setting is on for FE, and Ayşe closes the GitHub mirror issue of `FE-142` with the `state_reason` `not_planned`, using the GitHub account they sign in with
- **THEN** no done proposal is created and `FE-142` keeps its state
- **AND** an event on `FE-142` records the close with the surface `github`

#### Scenario: A move into the mapped not-planned status is not a Done

- **WHEN** FE maps the Jira project `WEB`, an admin has mapped the transition `Won't do`, which moves an issue into the status `Won't Do` in the Done status category, as FE's "not planned" transition, the setting is on for FE, and the Atlassian account that Ayşe, a member of FE, linked moves the Jira mirror issue of `FE-142` into `Won't Do`
- **THEN** no done proposal is created and `FE-142` keeps its state
- **AND** an event on `FE-142` records the move with the surface `jira`

#### Scenario: Without a mapped not-planned transition, every Done-category move is a Done

- **WHEN** FE maps the Jira project `WEB` with no "not planned" transition mapped, the setting is on for FE, and the Atlassian account that Ayşe, a member of FE, linked moves the Jira mirror issue of `FE-142`, which is `in_progress`, into the status `Won't Do` in the Done status category
- **THEN** Tiehall creates a done proposal for Ayşe

#### Scenario: A close as a duplicate is not a Done

- **WHEN** the setting is on for FE, and Ayşe closes the GitHub mirror issue of `FE-142` with the `state_reason` `duplicate`, using the GitHub account they sign in with
- **THEN** no done proposal is created and `FE-142` keeps its state
- **AND** an event on `FE-142` records the close with the surface `github`

### Requirement: Failed mirror jobs are shown with a Retry button

A mirror job SHALL move to a dead-letter queue after its fifth failed attempt, with the 5 attempts spread over about 1 hour: the fifth attempt SHALL come no earlier than 50 and no later than 70 minutes after the first. Tiehall SHALL show each job in the dead-letter queue as a banner in the web UI with a Retry button. The banner SHALL be shown to the install's admins and to the members of the team whose request the job mirrors, and to no one else. Retry SHALL run the job again, and the banner SHALL go away once the job succeeds. A mirror job of a request in the dead-letter queue SHALL NOT hold back that request's later mirror jobs: a newer job SHALL run, SHALL project the request as it is then, including the comments the failed job did not write, and, when it succeeds, SHALL clear the dead-lettered job and its banner. When GitHub answers a write to a mirror issue with 404 or 410, as for an issue deleted or moved out of reach, Tiehall SHALL mark that mirror gone, SHALL write to it no more, SHALL add one notice to the request's thread, and SHALL clear the job's dead letter and its banner; it SHALL NOT open the issue again.

Source: D28 #41, #83; D55 (76), (79); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: Four failures are retried, the fifth goes to the dead-letter queue

- **WHEN** the mirror job for `FE-142` fails on each of its first 4 attempts
- **THEN** the job is not in the dead-letter queue and is tried again
- **AND** when its fifth attempt, between 50 and 70 minutes after the first, also fails, the job moves to the dead-letter queue

#### Scenario: Retry after a fix

- **WHEN** the mirror job for `FE-142` has failed until it moved to the dead-letter queue
- **THEN** the admins and the members of FE see a banner for it in the web UI with a Retry button, and a member of MOBILE who is not an admin does not
- **AND** after someone presses Retry and the job succeeds, the banner is gone

#### Scenario: A newer job supersedes a dead-lettered one

- **WHEN** the mirror job for `FE-142` has failed until it moved to the dead-letter queue, and `FE-142` then moves to `in_progress` while GitHub answers again
- **THEN** a new mirror job for `FE-142` runs without waiting for anyone to press Retry
- **AND** once it succeeds, the mirror issue shows `in_progress` and the banner is gone

#### Scenario: A mirror issue deleted on GitHub

- **WHEN** the mirror issue of `FE-142` was deleted on GitHub, and GitHub answers Tiehall's next write to it with 404
- **THEN** Tiehall writes to that issue no more
- **AND** the thread of `FE-142` gets one notice about it
- **AND** no banner for the mirror job of `FE-142` remains

### Requirement: Broken integrations are surfaced

When a connected GitHub installation stops working, because it is suspended or deleted on GitHub, or the Jira site answers the bot's calls with 401 or 403, Tiehall SHALL show a banner in the web UI to the install's admins and to the members of each team whose mirrors go through that installation or Jira site, and to no one else. When Tiehall gives up a GitHub delivery, as the requirement on redelivery defines, or finds that GitHub holds no webhook for the App any more, as the requirement on GitHub's modes defines, it SHALL show a banner about GitHub's webhook in the same way, to the install's admins and to the members of each team whose mirrors go through GitHub, and to no one else, until an admin next switches GitHub's mode or a delivery that reaches the install after the give-up is verified. When SMTP is set, Tiehall SHALL also email every admin about it; without SMTP, the banner is the only alert. The email about GitHub's webhook SHALL be sent once while its banner shows, however many deliveries Tiehall gives up in that time.

Source: D28 #41, #83; D50 (15); D55 (6); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A rejected Jira token is surfaced

- **WHEN** DATA maps the Jira project `DAT`, SMTP is set, and Jira answers a call with the bot's token with 401
- **THEN** the admins and the members of DATA see a banner about the broken Jira connection in the web UI, and a member of FE who is not an admin does not
- **AND** every admin gets an email about it

#### Scenario: A suspended GitHub installation is surfaced without SMTP

- **WHEN** FE maps `acme/fe-intake` as its intake repository, SMTP is not set, and the `acme` installation is suspended on GitHub
- **THEN** the admins and the members of FE see a banner about it in the web UI, and a member of DATA who is not an admin does not
- **AND** no email is sent

#### Scenario: A given-up delivery is surfaced

- **WHEN** FE maps `acme/fe-intake` as its intake repository, DATA maps the Jira project `DAT`, SMTP is set, and Tiehall gives up two GitHub deliveries an hour apart
- **THEN** the admins and the members of FE see a banner about GitHub's webhook in the web UI, and a member of DATA who is not an admin does not
- **AND** every admin gets one email about it
- **AND** the banner stays until an admin next switches GitHub's mode or a delivery that reaches the install after the give-up is verified

#### Scenario: The webhook banner goes once a delivery arrives

- **WHEN** Ada switched GitHub to webhook mode, Tiehall gave up a delivery made after the switch, and a later delivery from GitHub reaches the install and is verified
- **THEN** no one sees the banner about GitHub's webhook any more
- **AND** GitHub stays in webhook mode

#### Scenario: A removed webhook is surfaced

- **WHEN** FE maps `acme/fe-intake` as its intake repository, SMTP is set, and GitHub answers a request for the delivery log with 404 while GitHub runs in webhook mode with a webhook secret stored
- **THEN** the admins and the members of FE see a banner about GitHub's webhook in the web UI, and a member of DATA who is not an admin does not
- **AND** every admin gets one email about it

### Requirement: Reassignment moves the mirror

When a confirmed reassignment moves a request that has a mirror issue to another team, as the requests capability defines, its tracker mirror SHALL move to the new team's tracker. Tiehall SHALL add a notice of the reassignment to the old mirror issue. When the old mirror issue is a GitHub issue, Tiehall SHALL also close it with the `state_reason` `not_planned`. When the old mirror issue is a Jira issue, Tiehall SHALL also apply the old team's "not planned" transition to it if that team's Jira mapping has one mapped, as the requirement on request states in Jira defines; while none is mapped, the old Jira issue SHALL only get the notice and SHALL keep its Jira status. Tiehall SHALL open a new mirror issue for the request, under its new key, in the tracker that the new team maps. Because a reassigned request is `open` and unclaimed in its new team, that new issue SHALL follow the new team's own rule for when mirrors are created: on claim by default, or at once when the new team mirrors on open. Mirror jobs project the request as it is when they run, so when a reassignment and its undo both take effect before the mirror job runs, the job SHALL see no move and SHALL write nothing: no notice on the old mirror issue and no new issue.

When a confirmed reassignment is undone within the undo window that the requests capability defines, Tiehall SHALL restore the request's mirror in the old team's tracker: it SHALL reopen the old mirror issue when it is a GitHub issue, add a notice of the undo to it, and set its state label to the restored state. An old Jira mirror issue SHALL keep its Jira status; its notice and state label show the restored state. A mirror issue that was opened for the new team SHALL get a notice of the undo. When it is a GitHub issue, it SHALL be closed with the `state_reason` `not_planned`. When it is a Jira issue, Tiehall SHALL also apply the new team's "not planned" transition to it if that team's Jira mapping has one mapped; while none is mapped, it SHALL only get the notice and SHALL keep its Jira status.

Source: D28 #18, #34, #82; D29 (1), (2); D30 (3); D55 (78); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A reassigned request is mirrored for its new team

- **WHEN** `FE-142` has a mirror issue in `acme/fe-intake`, and the reassignment of `FE-142` to MOBILE, which maps `acme/mobile-intake` as its intake repository and keeps the default of mirroring on claim, is confirmed
- **THEN** the mirror issue in `acme/fe-intake` gets a notice of the reassignment and is closed with the `state_reason` `not_planned`
- **AND** when a member of MOBILE claims the request, a new mirror issue for it under its new MOBILE key is created in `acme/mobile-intake`

#### Scenario: A new team that mirrors on open

- **WHEN** MOBILE mirrors on open, maps `acme/mobile-intake`, and a reassignment of `FE-142` to MOBILE is confirmed
- **THEN** a new mirror issue for the request under its new MOBILE key is created in `acme/mobile-intake` without waiting for a claim

#### Scenario: A new team that mirrors on claim waits for the claim

- **WHEN** MOBILE keeps the default of mirroring on claim, maps `acme/mobile-intake`, and a reassignment of `FE-142` to MOBILE is confirmed
- **THEN** no mirror issue for the request exists in `acme/mobile-intake` while it is `open` and unclaimed in MOBILE
- **AND** when a member of MOBILE claims it, Tiehall creates its mirror issue in `acme/mobile-intake`

#### Scenario: Without a not-planned transition, the old Jira issue only gets a notice

- **WHEN** `DATA-9` has a Jira mirror issue in the project `DAT`, no admin has mapped a "not planned" transition for DATA, and a reassignment of `DATA-9` to FE is confirmed
- **THEN** the Jira mirror issue of `DATA-9` gets a notice of the reassignment
- **AND** its Jira status does not change

#### Scenario: A mapped not-planned transition is applied to the old Jira issue

- **WHEN** an admin has mapped the `DAT` project's transition `Won't do` as DATA's "not planned" transition, `DATA-9` has a Jira mirror issue in `DAT`, and a reassignment of `DATA-9` to FE is confirmed
- **THEN** the Jira mirror issue of `DATA-9` gets a notice of the reassignment
- **AND** Tiehall applies the `Won't do` transition to it

#### Scenario: Undoing a reassignment restores the old mirror

- **WHEN** a reassignment of `FE-142` to MOBILE, which mirrors on open, was confirmed, so the issue in `acme/fe-intake` was closed and a new issue was opened in `acme/mobile-intake`, and the reassignment is undone 10 minutes later
- **THEN** the issue in `acme/fe-intake` is reopened, gets a notice of the undo and carries the state label of the restored state
- **AND** the issue in `acme/mobile-intake` gets a notice of the undo and is closed with the `state_reason` `not_planned`

#### Scenario: Undoing a reassignment applies the new team's not-planned transition

- **WHEN** DATA maps the Jira project `DAT` with the transition `Won't do` mapped as its "not planned" transition and mirrors on open, a reassignment of `FE-142` to DATA was confirmed, so a Jira mirror issue was opened in `DAT`, and the reassignment is undone 10 minutes later
- **THEN** the Jira mirror issue in `DAT` gets a notice of the undo
- **AND** Tiehall applies the `Won't do` transition to it

#### Scenario: Without a not-planned transition, the new team's Jira issue only gets a notice of the undo

- **WHEN** DATA maps the Jira project `DAT` with no "not planned" transition mapped and mirrors on open, a reassignment of `FE-142` to DATA was confirmed, so a Jira mirror issue was opened in `DAT`, and the reassignment is undone 10 minutes later
- **THEN** the Jira mirror issue in `DAT` gets a notice of the undo
- **AND** its Jira status does not change

#### Scenario: A reassignment undone before its mirror job runs writes nothing

- **WHEN** `FE-142` has a mirror issue in `acme/fe-intake`, and a reassignment of `FE-142` to MOBILE, which mirrors on open, is confirmed and undone before the mirror job runs
- **THEN** the issue in `acme/fe-intake` gets no notice and stays open
- **AND** no issue is created in `acme/mobile-intake`

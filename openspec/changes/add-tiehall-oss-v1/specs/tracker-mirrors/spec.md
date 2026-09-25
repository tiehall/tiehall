# Spec Delta: tracker-mirrors

## Purpose

Tracker mirrors make each request visible where the target team plans its work, in GitHub Issues or Jira Cloud, as a projection of the Tiehall request. This capability also defines the install's GitHub App permissions and installations, and how GitHub and Jira changes reach Tiehall by webhook or by polling. Tiehall stays the source of truth, and only a few tracker changes come back.

## ADDED Requirements

### Requirement: The GitHub App asks for narrow permissions and every event up front

The GitHub App that each install creates, as the self-host-install capability defines, SHALL ask for exactly these permissions: Metadata (read), Pull requests (read), Issues (read and write), the organization permission Members (read) and the account permission Email addresses (read). It SHALL NOT ask for Contents or for any other permission. It SHALL receive the events `pull_request`, `issues`, `installation`, `installation_repositories` and `organization`, and SHALL subscribe to no other event. The App SHALL ask for all of them when it is created, so that an installation never has to approve a new permission for anything v1 does. Whoever installs the App on a GitHub organization SHALL choose which repositories the installation covers. The same App SHALL serve sign-in and the membership checks, as the sign-in capability defines, PR links and close on merge, as the requests capability defines, provider PRs, as the contract-changes capability defines, and the GitHub Issues mirror.

Source: D37; design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors; design.md, Self-hosting decisions: S4; design.md, Self-hosting decisions: S5

#### Scenario: The manifest asks for the narrow permissions only

- **WHEN** the setup screen builds the GitHub App's manifest for `https://tiehall.example.com`
- **THEN** the manifest asks for Metadata read, Pull requests read, Issues read and write, organization Members read and account Email addresses read, and for no other permission
- **AND** the App it creates receives the events `pull_request`, `issues`, `installation`, `installation_repositories` and `organization`, and is subscribed to no other event

#### Scenario: The install screen lists the same permissions

- **WHEN** someone starts installing the install's GitHub App on the GitHub organization `acme`
- **THEN** GitHub asks for those five permissions and for nothing else
- **AND** the installer chooses the repositories the installation covers

### Requirement: Admins connect GitHub installations with the confirmation step

Tiehall SHALL act only on installations of the install's GitHub App that an admin has connected. The installations made while setup completes SHALL be connected as the self-host-install capability defines. Connecting any other installation SHALL be an admin action in the web UI, with the confirmation step, as the agent-safety capability defines; a connection asked for by a member who is not an admin, or without a valid confirmation, SHALL be refused with 403, as the public-api capability's error model defines, and SHALL connect nothing. The admin page SHALL list every installation of the App that is not connected, so that an admin can connect it or leave it ignored. Tiehall SHALL use an installation that is not connected only to list it: its repositories SHALL NOT count as covered, its PRs SHALL NOT link or close requests, no mirror issue SHALL be created in it, and membership of its GitHub organization SHALL NOT let anyone sign in, as the sign-in capability defines. An admin SHALL be able to disconnect an installation in the web UI. Disconnecting SHALL NOT need the confirmation step, because it only narrows what Tiehall acts on, and SHALL remove no member: members who joined through that installation's organization stay, as the sign-in capability defines. Connecting and disconnecting an installation SHALL each be recorded as a security event, as the activity-log capability defines.

Source: D19; D28 #1, #4, #48; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S4; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: An installation nobody connected is listed and ignored

- **WHEN** the install's App has been made public, someone installs it on the GitHub organization `acme-labs`, and no admin connects that installation
- **THEN** the admin page lists the `acme-labs` installation as not connected
- **AND** a PR in `acme-labs/tools` that mentions `FE-142` and merges after the claim does not change `FE-142`

#### Scenario: An admin connects an installation

- **WHEN** an admin connects the `acme-labs` installation and confirms it on its review page in the web UI
- **THEN** the repositories that the installation covers count as covered
- **AND** a security event for the connection is appended to the activity log

#### Scenario: A connection without a confirmation

- **WHEN** an admin asks to connect the `acme-labs` installation without a valid confirmation for that connection
- **THEN** the call is refused with 403 and an RFC 9457 problem
- **AND** the installation stays not connected

#### Scenario: Disconnecting keeps the members

- **WHEN** Lee joined the install through membership of `acme-labs`, and an admin disconnects the `acme-labs` installation
- **THEN** the repositories that installation covers no longer count as covered
- **AND** Lee is still a member of the install
- **AND** a security event for the disconnect is appended to the activity log

#### Scenario: A member who is not an admin cannot connect an installation

- **WHEN** Mehmet, a member who is not an admin, asks to connect the `acme-labs` installation
- **THEN** the call is refused with 403 and an RFC 9457 problem
- **AND** the installation stays not connected

### Requirement: GitHub writes appear as the App's bot

Tiehall SHALL call GitHub only with installation tokens of the install's own GitHub App, never with a user's GitHub token or a token a client presented, as the agent-access capability defines for outbound calls. So every issue, comment, label and issue state change Tiehall writes on GitHub SHALL appear as the App's bot.

Source: D37; design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors; design.md, Design rules: Agent access; design.md, Self-hosting decisions: S4

#### Scenario: A mirrored issue shows the App as its author

- **WHEN** Tiehall creates the mirror issue for `FE-142` in `acme/fe-intake`
- **THEN** GitHub shows the install's App bot as the author of the issue and of every comment Tiehall adds to it

### Requirement: Covered repositories follow each connected installation

The repositories the install covers SHALL be the repositories that its connected installations cover, following each installation's repository selection as `installation_repositories` events report it, or as polling finds it in polling mode. A repository removed from an installation SHALL stop counting as covered for mirrors, for the merged-PR rules that the requests capability defines, and for the provider PRs that the contract-changes capability follows. An installation that is deleted or suspended on GitHub SHALL stop covering its repositories while it is deleted or suspended.

Source: design.md, Design rules: Tracker mirrors; design.md, Design rules: Requests and events; design.md, Self-hosting decisions: S4; design.md, Self-hosting decisions: S9

#### Scenario: A repository removed from the installation no longer closes requests

- **WHEN** someone removes `acme/web` from the `acme` installation on GitHub, and later a PR in `acme/web` that mentions `FE-142` merges after the claim
- **THEN** the merge does not move `FE-142` to done

#### Scenario: A repository added to the installation starts counting

- **WHEN** someone adds `acme/api` to the connected `acme` installation, and later a PR in `acme/api` whose branch name mentions `FE-142` merges after `FE-142` was claimed
- **THEN** `FE-142` moves to `done`

### Requirement: GitHub webhooks are verified, deduplicated and processed in the background

Tiehall SHALL receive GitHub deliveries at `https://<install>/webhooks/github`. For each delivery, Tiehall SHALL verify its signature with the App's webhook secret, store it deduplicated by its delivery id, answer with a 2xx status, and only then process it in a background job. A delivery that fails verification SHALL be neither stored nor processed. A delivery id seen before SHALL be answered with a 2xx status and not processed again. Deliveries from an installation that is not connected SHALL change nothing except the list of installations that the admin page shows. Tiehall SHALL accept deliveries in this way from the moment the setup screen has stored the App's credentials, before setup completes, as the self-host-install capability defines, and SHALL process the ones that arrive before setup completes once it does.

Source: design.md, Design rules: Tracker mirrors; design.md, Design rules: Agent access; design.md, Technical decisions: T16; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S4

#### Scenario: A forged delivery is dropped

- **WHEN** a request arrives at `https://tiehall.example.com/webhooks/github` with a signature that does not match the App's webhook secret
- **THEN** Tiehall does not store or process it

#### Scenario: A repeated delivery is processed once

- **WHEN** GitHub sends the same delivery id twice
- **THEN** Tiehall answers both with a 2xx status
- **AND** processes the delivery only once

### Requirement: Failed GitHub deliveries are redelivered

Because GitHub does not retry failed deliveries on its own, Tiehall SHALL, while GitHub runs in webhook mode, ask GitHub to redeliver failed deliveries every 10 to 15 minutes.

Source: design.md, Design rules: Tracker mirrors; design.md, Self-hosting decisions: S9

#### Scenario: A delivery missed during a restart arrives later

- **WHEN** GitHub runs in webhook mode, GitHub records a delivery to the install as failed because the install was restarting, and the install is up again
- **THEN** within 15 minutes Tiehall asks GitHub to redeliver it
- **AND** processes it once

### Requirement: GitHub and Jira each run in webhook mode or polling mode

GitHub and Jira SHALL each run in webhook mode or in polling mode, and both modes SHALL feed the same processing, so a change has the same effect whichever way it arrives. After the first installation, Tiehall SHALL read the App's webhook delivery log through GitHub's API, and a failed delivery to the install SHALL put GitHub in polling mode. Only deliveries made after the App's credentials were stored SHALL count, because the install accepts deliveries from then on; the delivery for the installation made during setup SHALL be the first that counts. Jira SHALL run in polling mode until a Jira webhook has delivered an event that Tiehall accepted, and in webhook mode after that. The admin page SHALL show each integration's mode, and an admin SHALL be able to switch either integration to the other mode in the web UI. In polling mode, Tiehall SHALL poll every 60 seconds: on GitHub, the PRs linked to open requests, the PRs in covered repositories updated since the last poll, for key mentions and provider PRs, and the mirror issues; on Jira, the issues in the mapped projects updated in the last 2 minutes. In polling mode a change SHALL be picked up within 2 minutes, within the rate limits of GitHub and Jira.

Source: D28 #4, #48; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S9

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

### Requirement: Reconciliation catches missed changes

In both modes, Tiehall SHALL run a reconciliation every 15 minutes that finds inbound changes it missed: on GitHub, the mirror issues updated since the previous run; on Jira, the issues in the mapped projects updated in the last 20 minutes. It SHALL handle each change it finds as if its webhook had arrived, and SHALL handle a change only once even when a webhook or a poll and the reconciliation both see it.

Source: design.md, Design rules: Tracker mirrors; design.md, Self-hosting decisions: S9

#### Scenario: A missed close arrives through reconciliation

- **WHEN** someone closes the GitHub mirror issue of `FE-142` and its webhook never reaches the install
- **THEN** within 15 minutes an event on `FE-142` records the close

#### Scenario: A change seen twice is handled once

- **WHEN** a Jira assignee change on the mirror issue of `FE-142` arrives by webhook and is also found by the next reconciliation run
- **THEN** `FE-142` has exactly one event for that change

### Requirement: A mirror is a projection of the request

Tiehall SHALL be the source of truth for a request, and a tracker issue SHALL be a projection of it. v1 SHALL mirror into GitHub Issues and Jira Cloud only. A mirror issue SHALL carry the request's title, a summary that Tiehall writes, a link to the request on the install's own host, and a label that names the request's current state. It SHALL carry no packet body and no thread text, under the mirror rule that the agent-safety capability defines. On Jira, the issue body SHALL be a minimal Atlassian Document Format document.

Source: D5; D17; design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors; design.md, Design rules: Agent safety; design.md, Self-hosting decisions: S15

#### Scenario: The mirror shows a summary and a link, not the packet

- **WHEN** Tiehall creates the mirror issue for `FE-142`
- **THEN** the issue carries the request's title, a summary Tiehall wrote, the link `https://tiehall.example.com/FE-142` and a label naming the state `claimed`
- **AND** it carries no text from the packet or the thread of `FE-142`

### Requirement: Mirror issues are created on claim by default

Tiehall SHALL create a request's mirror issue when the request is claimed. An admin SHALL be able to turn on, in a team's mapping, a switch that makes Tiehall create the mirror issue when a request to that team is opened instead. A request reassigned to a team SHALL get its mirror issue in that team's tracker under that team's own rule, as the requirement on reassignment defines.

Source: D28 #4, #82; D29 (2); design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors

#### Scenario: The default waits for the claim

- **WHEN** FE keeps the default and a request `FE-142` is opened
- **THEN** no mirror issue exists for `FE-142`
- **AND** when someone claims `FE-142`, Tiehall creates its mirror issue

#### Scenario: The per-team switch mirrors on open

- **WHEN** an admin has turned on mirroring on open for FE, and a request `FE-143` is opened
- **THEN** Tiehall creates the mirror issue for `FE-143` without waiting for a claim

### Requirement: One comment per state change and per question notice

Each state change of a mirrored request, and each question notice on it, SHALL add one comment to the mirror issue. The comment SHALL be a notice that Tiehall writes, as the agent-safety capability requires, and the state label SHALL follow the new state.

Source: design.md, Design rules: Tracker mirrors; design.md, Design rules: Agent safety

#### Scenario: A state change adds one comment

- **WHEN** mirrored request `FE-142` moves from `claimed` to `in_progress`
- **THEN** its mirror issue gets exactly one new comment, written by Tiehall, that names the new state
- **AND** the issue's state label names `in_progress`

#### Scenario: A question adds a notice, not the question

- **WHEN** a blocking question is posted on `FE-142`
- **THEN** its mirror issue gets exactly one comment, written by Tiehall, that says a question is waiting and links to the request
- **AND** the comment does not contain the question's text

### Requirement: Terminal requests close their GitHub mirror issue

When a request that has a GitHub mirror issue reaches a terminal state, Tiehall SHALL close that issue with a `state_reason`: `completed` when the request is `done`, and `not_planned` when it is `declined` or `withdrawn`. When a confirmed decline is undone within the undo window that the requests capability defines, Tiehall SHALL reopen the request's GitHub mirror issue, and the state label SHALL follow the restored state.

Source: D28 #34, #78; design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors

#### Scenario: A done request closes its issue as completed

- **WHEN** mirrored request `FE-142` moves to `done`
- **THEN** Tiehall closes its GitHub mirror issue with the `state_reason` `completed`

#### Scenario: A withdrawn request closes its issue as not planned

- **WHEN** mirrored request `FE-143` moves to `withdrawn`
- **THEN** Tiehall closes its GitHub mirror issue with the `state_reason` `not_planned`

#### Scenario: An undone decline reopens the issue

- **WHEN** mirrored request `FE-142` was `claimed`, its decline was confirmed and its GitHub mirror issue closed as `not_planned`, and the decline is undone 10 minutes later
- **THEN** Tiehall reopens the GitHub mirror issue of `FE-142`
- **AND** the issue's state label names `claimed`

### Requirement: Mirror writes are idempotent and never echo

Each mirror update SHALL read the request as it is at that moment and SHALL write nothing when what the mirror shows has not changed since the last write. A retried create SHALL never produce a second issue for the same request in the same tracker. Webhooks, polled changes and reconciled changes caused by Tiehall's own writes SHALL be dropped, so they add nothing to the request.

Source: design.md, Design rules: Tracker mirrors; design.md, Technical decisions: T16

#### Scenario: A retried create makes one issue

- **WHEN** the job that creates the mirror issue for `FE-142` times out after GitHub created the issue, and the job runs again
- **THEN** exactly one mirror issue exists for `FE-142`

#### Scenario: Nothing changed, nothing written

- **WHEN** a mirror update runs for `FE-142` and nothing the mirror shows has changed since the last write
- **THEN** Tiehall makes no write to the tracker

#### Scenario: Tiehall's own label change is not an inbound event

- **WHEN** GitHub sends the `issues` event for the label that Tiehall itself just changed on the mirror issue of `FE-142`
- **THEN** nothing is added to `FE-142`

### Requirement: Each team maps to one tracker

Team mappings SHALL be set by admins, in the web UI only. Because a GitHub issue always belongs to one repository, each team that mirrors into GitHub Issues SHALL map to one intake repository that a connected installation covers, and the team's mirror issues SHALL be created there; a mapping to a repository that no connected installation covers SHALL be refused with 409, as the public-api capability's error model defines for a state conflict. Each team that mirrors into Jira Cloud SHALL map to a project on the install's connected Jira site and to an issue type in that project, which the admin who makes the mapping picks, and its mirror issues SHALL be created in that project with that issue type. Tiehall SHALL refuse a Jira mapping whose project requires fields, for the picked issue type, that Tiehall does not fill, with 409. Each team SHALL mirror into one tracker only: it SHALL map either an intake repository or a Jira project, never both, and a request to add a second mapping for a team that already has one SHALL be refused with 409. A team with neither mapping SHALL get no mirror issues. A member who is not an admin who asks to change a mapping SHALL be refused with 403.

Source: D28 #1, #4, #48, #81; design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors; design.md, Self-hosting decisions: S8

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

### Requirement: Request states reach Jira through labels, comments and mapped transitions

Tiehall SHALL show a request's state on its Jira mirror issue through the state label and the comments this capability describes. Tiehall SHALL NOT change the Jira issue's status, with two exceptions, each of which an admin MAY map for a team's Jira mapping:
- a done transition: while one is mapped, Tiehall SHALL apply it to the Jira mirror issue when a request of that team moves to `done`;
- a "not planned" transition: while one is mapped, Tiehall SHALL apply it to the team's Jira mirror issue of a request that a confirmed reassignment moves away from that team, and to the team's Jira mirror issue of a request whose reassignment to that team is undone, as the requirement on reassignment defines.

A team's Jira mapping SHALL start with neither transition mapped. While no "not planned" transition is mapped, the old Jira mirror issue of a reassigned request, and the new team's Jira mirror issue of a request whose reassignment is undone, SHALL only get a notice. The "not planned" transition SHALL apply only to reassignments and their undo: a decline or a withdrawal SHALL NOT apply it, and on a Jira mirror issue SHALL only change the state label and add a comment.

Source: D17; D28 #79; D29 (1); D30 (3); design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors

#### Scenario: A state change leaves the Jira status alone

- **WHEN** mirrored request `DATA-9`, mirrored as a Jira issue, moves from `claimed` to `in_progress`
- **THEN** the Jira issue's status does not change
- **AND** the issue's state label names `in_progress` and it gets one new comment

#### Scenario: By default, done leaves the Jira status alone

- **WHEN** no admin has mapped a done transition for DATA, and `DATA-9`, mirrored as a Jira issue, moves to `done`
- **THEN** the Jira issue's status does not change
- **AND** the issue's state label names `done` and it gets one new comment

#### Scenario: A mapped done transition is applied on done

- **WHEN** an admin has mapped the `DAT` project's transition `Close` as DATA's done transition, and `DATA-9` moves to `done`
- **THEN** Tiehall applies the `Close` transition to the Jira mirror issue of `DATA-9`

#### Scenario: A new Jira mapping has no transitions

- **WHEN** an admin maps the DATA team to the Jira project `DAT` and maps no transitions
- **THEN** DATA's Jira mapping has neither a done transition nor a "not planned" transition

#### Scenario: A decline does not apply the not-planned transition

- **WHEN** an admin has mapped the `DAT` project's transition `Won't do` as DATA's "not planned" transition, and the decline of `DATA-9`, mirrored as a Jira issue in `DAT`, is confirmed
- **THEN** the Jira issue's status does not change
- **AND** the issue's state label names `declined` and it gets one new comment

### Requirement: Inbound tracker changes are recorded, not applied

Tiehall SHALL bring back from the tracker only these changes to a mirror issue: close and reopen, the assignee, and the Jira status category. It SHALL record each of them as an event on the request, with the actor kind `integration` and the tracker, `github` or `jira`, as the surface, as the requests capability defines for provenance. Except for a tracker "Done" as the next requirement describes, these changes SHALL NOT change the request. Any other change made in the tracker SHALL NOT change the request.

Source: D17; design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors; design.md, Design rules: Requests and events; design.md, Design rules: Agent access

#### Scenario: A reopen is recorded without changing the request

- **WHEN** someone reopens the closed GitHub mirror issue of `FE-142`
- **THEN** an event on `FE-142` records the reopen with the surface `github`
- **AND** the state of `FE-142` does not change

#### Scenario: A Jira assignee change is recorded

- **WHEN** someone changes the assignee of the Jira mirror issue of `DATA-9`
- **THEN** an event on `DATA-9` records the new assignee with the surface `jira`

#### Scenario: A title edited in the tracker does not change the request

- **WHEN** someone edits the title of the mirror issue of `FE-142` in the tracker
- **THEN** the title of `FE-142` does not change

### Requirement: A tracker "Done" never closes a request by itself

A tracker "Done", meaning a closed GitHub mirror issue or a Jira mirror issue moved into the Done status category, SHALL NOT move a request to done by itself. A close that the tracker marks as not planned SHALL NOT count as a tracker "Done": on GitHub, an issue closed with the `state_reason` `not_planned`; on Jira, an issue moved into the target status of the "not planned" transition that the team's Jira mapping has mapped. While a team's Jira mapping has no "not planned" transition mapped, every move of its Jira mirror issue into the Done status category SHALL count as a tracker "Done". A tracker account SHALL count as mapped to a Tiehall user only when it is the GitHub account that user signs in with, as the sign-in capability defines, or an Atlassian account that user has linked, as the requirement on linking an Atlassian account defines. When the actor of a tracker "Done" is mapped to a Tiehall user who is a member of the request's target team, the side that marks a request done, as the requests capability defines, and an admin has turned on the setting for tracker "Done" proposals in that team's mapping, Tiehall SHALL create a done proposal for that user, who confirms it in the web UI, as the requests capability defines, when the request's state allows a move to `done`. Otherwise, including when the request is in a state from which a move to `done` is not allowed, Tiehall SHALL only add a notice to the request's thread. The setting SHALL be off until an admin turns it on.

Source: D23; D28 #4, #13, #80; D30 (3); design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S8

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

### Requirement: Tracker comments are not imported

In v1, Tiehall SHALL NOT import comments made on a mirror issue into the request's thread.

Source: D17; design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors

#### Scenario: A tracker comment stays in the tracker

- **WHEN** someone comments on the mirror issue of `FE-142` in GitHub or Jira
- **THEN** nothing is added to the thread of `FE-142`

### Requirement: Failed mirror jobs are shown with a Retry button

A mirror job SHALL move to a dead-letter queue after its fifth failed attempt, with the 5 attempts spread over about 1 hour: the fifth attempt SHALL come no earlier than 50 and no later than 70 minutes after the first. Tiehall SHALL show each job in the dead-letter queue as a banner in the web UI with a Retry button. The banner SHALL be shown to the install's admins and to the members of the team whose request the job mirrors, and to no one else. Retry SHALL run the job again, and the banner SHALL go away once the job succeeds.

Source: D28 #41, #83; design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors

#### Scenario: Four failures are retried, the fifth goes to the dead-letter queue

- **WHEN** the mirror job for `FE-142` fails on each of its first 4 attempts
- **THEN** the job is not in the dead-letter queue and is tried again
- **AND** when its fifth attempt, between 50 and 70 minutes after the first, also fails, the job moves to the dead-letter queue

#### Scenario: Retry after a fix

- **WHEN** the mirror job for `FE-142` has failed until it moved to the dead-letter queue
- **THEN** the admins and the members of FE see a banner for it in the web UI with a Retry button, and a member of MOBILE who is not an admin does not
- **AND** after someone presses Retry and the job succeeds, the banner is gone

### Requirement: Broken integrations are surfaced

When a connected GitHub installation stops working, because it is suspended or deleted on GitHub, or the Jira site answers the bot's calls with 401 or 403, Tiehall SHALL show a banner in the web UI to the install's admins and to the members of each team whose mirrors go through that installation or Jira site, and to no one else. When SMTP is set, Tiehall SHALL also email every admin about it; without SMTP, the banner is the only alert.

Source: D28 #41, #83; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S8; design.md, Self-hosting decisions: S10

#### Scenario: A rejected Jira token is surfaced

- **WHEN** DATA maps the Jira project `DAT`, SMTP is set, and Jira answers a call with the bot's token with 401
- **THEN** the admins and the members of DATA see a banner about the broken Jira connection in the web UI, and a member of FE who is not an admin does not
- **AND** every admin gets an email about it

#### Scenario: A suspended GitHub installation is surfaced without SMTP

- **WHEN** FE maps `acme/fe-intake` as its intake repository, SMTP is not set, and the `acme` installation is suspended on GitHub
- **THEN** the admins and the members of FE see a banner about it in the web UI, and a member of DATA who is not an admin does not
- **AND** no email is sent

### Requirement: Jira Cloud connects through a bot account's API token

An install SHALL connect to at most one Jira Cloud site, and to Jira Cloud only. Connecting Jira SHALL be an admin action in the web UI, with the confirmation step, as the agent-safety capability defines, and SHALL take the site URL, which MUST have the form `https://<name>.atlassian.net`, the email address of a dedicated bot account, its API token, and the token's expiry date. Tiehall SHALL check the credentials with one call to the site before storing them, and SHALL refuse the connection, and store nothing, when the site URL has another form or the check fails. Tiehall SHALL store the token encrypted, as the self-host-install capability defines for stored integration secrets, and SHALL never show it again. Every Jira call SHALL use the bot's token, so what Tiehall can do in Jira is what the company's Jira admins grant the bot account. Changing the connection, for example to a new token and expiry date, SHALL follow the same check and confirmation step, and SHALL let mirror updates resume for the issues mirrored before. Changing the site URL while any team maps a project on the connected site SHALL be refused with 409, as the public-api capability's error model defines for a state conflict, and SHALL change nothing; an admin removes those mappings first. A connection or change asked for by a member who is not an admin, or without a valid confirmation, SHALL be refused with 403, as the public-api capability's error model defines. Connecting, changing and disconnecting Jira SHALL each be recorded as a security event, as the activity-log capability defines.

Source: D17; D19; D28 #1, #4, #48; design.md, Decisions this change rests on; design.md, Technical decisions: T14; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S8; design.md, Self-hosting decisions: S14

#### Scenario: An admin connects Jira

- **WHEN** an admin enters `https://acme.atlassian.net`, the bot account's email address, its API token and the expiry date 2027-03-31, the check call succeeds, and the admin confirms on the review page in the web UI
- **THEN** Jira is connected
- **AND** the admin page never shows the token again, and a security event for the connection is appended to the activity log

#### Scenario: A site outside Jira Cloud is refused

- **WHEN** an admin enters the site URL `https://jira.acme.internal`
- **THEN** Tiehall refuses the connection and makes no call to that host
- **AND** nothing is stored

#### Scenario: A token that fails the check is refused

- **WHEN** an admin enters `https://acme.atlassian.net` with an API token that Jira rejects in the check call
- **THEN** Tiehall refuses the connection and says why
- **AND** nothing is stored

#### Scenario: Connecting Jira without a confirmation is refused

- **WHEN** an admin asks to connect Jira without a valid confirmation for that connection
- **THEN** Tiehall refuses with 403 and an RFC 9457 problem
- **AND** the install has no new Jira connection

#### Scenario: The site cannot change under mapped teams

- **WHEN** DATA maps the Jira project `DAT` on `https://acme.atlassian.net`, and an admin asks to change the connection's site URL to `https://acme-new.atlassian.net` and confirms it
- **THEN** Tiehall refuses with 409 and an RFC 9457 problem
- **AND** the connection still points at `https://acme.atlassian.net`

#### Scenario: A new token restores the mirrors

- **WHEN** the bot's token expired, which showed the broken-connection banner, and an admin changes the connection to a new token that passes the check and confirms it
- **THEN** the banner goes away
- **AND** the next state change of `DATA-9` adds a comment to its existing Jira mirror issue

### Requirement: The Jira token's expiry is watched

Tiehall SHALL remind the admins 14 days and 3 days before the recorded expiry date of the Jira bot's token, with a banner shown to admins in the web UI and, when SMTP is set, an email to each admin.

Source: D28 #41; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S8; design.md, Self-hosting decisions: S10

#### Scenario: Reminders before the token expires

- **WHEN** the recorded expiry date of the Jira bot's token is 2027-03-31 and SMTP is set
- **THEN** on 2027-03-17 and on 2027-03-28 the admins see a reminder banner in the web UI and each admin gets a reminder email
- **AND** no member who is not an admin sees the reminder

### Requirement: Jira webhooks are hints

Tiehall SHALL show admins a Jira webhook URL on the install's host that contains a random secret path segment, for a Jira admin to add in Jira's settings, filtered to the mapped projects. Tiehall SHALL accept a Jira webhook only at that URL, and, where Jira sends a signature, only when the signature matches; any other call SHALL be neither stored nor processed. Tiehall SHALL treat every accepted Jira webhook as a hint: before recording anything, it SHALL read the issue again with the bot's token and record only what that read shows, so a forged call changes nothing that the issue does not show. Tiehall SHALL ignore events for issues that do not carry Tiehall's marker label, which Tiehall puts on every Jira mirror issue it creates.

Source: design.md, Technical decisions: T16; design.md, Self-hosting decisions: S8

#### Scenario: A forged Done changes nothing

- **WHEN** a call to the install's Jira webhook URL, with the right secret path segment and no signature, claims that the Jira mirror issue of `DATA-9` moved into the Done status category, and reading the issue with the bot's token shows it still in a status of the In Progress category
- **THEN** nothing is recorded on `DATA-9`

#### Scenario: A wrong secret path is not accepted

- **WHEN** a call arrives at the Jira webhook path with a secret segment that is not the install's
- **THEN** Tiehall neither stores nor processes it

#### Scenario: A bad signature is not accepted

- **WHEN** a Jira webhook arrives at the right URL with a signature that does not match its secret
- **THEN** Tiehall neither stores nor processes it

#### Scenario: Events for issues Tiehall did not create are ignored

- **WHEN** a mapped Jira project has an issue that Tiehall did not create, and someone moves it into the Done status category
- **THEN** no request gets an event, notice or proposal from it

### Requirement: Jira rate limits are respected

Tiehall SHALL make at most 2 concurrent calls to the Jira site, and SHALL honour the `Retry-After` and `RateLimit-Reason` headers that Jira sends.

Source: design.md, Design rules: Tracker mirrors

#### Scenario: Retry-After is honoured

- **WHEN** Jira answers a call with a 429 status and `Retry-After: 30`
- **THEN** Tiehall makes no call to the site for the next 30 seconds

#### Scenario: At most two calls at once

- **WHEN** 50 mirror updates for Jira mirror issues are waiting at the same moment
- **THEN** Tiehall never has more than 2 calls to the site open at once

### Requirement: Users link their Atlassian account through the bot's search

While Jira is connected, a signed-in user SHALL be able to link an Atlassian account to their own Tiehall user by picking it from a user search that Tiehall runs with the bot's token, and to unlink it. An Atlassian account SHALL be linked to at most one Tiehall user, and Tiehall SHALL refuse to link an Atlassian account that is already linked to another user, with 409, as the public-api capability's error model defines for a state conflict. Admins SHALL be able to see every link and remove any link. A link grants nothing its user could not already propose, so linking and unlinking SHALL NOT need the confirmation step; because a link decides whose tracker "Done" becomes a done proposal, each link, each unlink and each removal by an admin SHALL be recorded as a security event, as the activity-log capability defines. An Atlassian account SHALL NOT be a way to sign in. A link's only effect SHALL be to let a tracker "Done" by that account become a done proposal, which the linked user must still confirm, as the requirement on tracker "Done" defines.

Source: D28 #1, #80; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S8; design.md, Self-hosting decisions: S14

#### Scenario: A user links their Atlassian account

- **WHEN** Ayşe searches for their name, and the search run with the bot's token lists their Atlassian account, which Ayşe picks
- **THEN** the Atlassian account is linked to Ayşe's Tiehall user
- **AND** the admins see the link on the admin page
- **AND** the activity log gains a security event for the link

#### Scenario: A user unlinks their own account

- **WHEN** Ayşe unlinks their Atlassian account
- **THEN** a later tracker "Done" by that Atlassian account only adds a notice
- **AND** the activity log gains a security event for the unlink

#### Scenario: An Atlassian account already linked to someone else is refused

- **WHEN** Mehmet picks an Atlassian account that is already linked to Ayşe
- **THEN** Tiehall refuses with 409 and an RFC 9457 problem
- **AND** the Atlassian account stays linked to Ayşe only

#### Scenario: An admin removes a wrong link

- **WHEN** an admin removes the link between an Atlassian account and Mehmet's Tiehall user
- **THEN** a later tracker "Done" by that Atlassian account only adds a notice

#### Scenario: An Atlassian account does not sign in

- **WHEN** anyone opens the sign-in page of `https://tiehall.example.com`
- **THEN** no sign-in with an Atlassian account is offered

### Requirement: Reassignment moves the mirror

When a confirmed reassignment moves a request that has a mirror issue to another team, as the requests capability defines, its tracker mirror SHALL move to the new team's tracker. Tiehall SHALL add a notice of the reassignment to the old mirror issue. When the old mirror issue is a GitHub issue, Tiehall SHALL also close it with the `state_reason` `not_planned`. When the old mirror issue is a Jira issue, Tiehall SHALL also apply the old team's "not planned" transition to it if that team's Jira mapping has one mapped, as the requirement on request states in Jira defines; while none is mapped, the old Jira issue SHALL only get the notice and SHALL keep its Jira status. Tiehall SHALL open a new mirror issue for the request, under its new key, in the tracker that the new team maps. Because a reassigned request is `open` and unclaimed in its new team, that new issue SHALL follow the new team's own rule for when mirrors are created: on claim by default, or at once when the new team mirrors on open.

When a confirmed reassignment is undone within the undo window that the requests capability defines, Tiehall SHALL restore the request's mirror in the old team's tracker: it SHALL reopen the old mirror issue when it is a GitHub issue, add a notice of the undo to it, and set its state label to the restored state. An old Jira mirror issue SHALL keep its Jira status; its notice and state label show the restored state. A mirror issue that was opened for the new team SHALL get a notice of the undo. When it is a GitHub issue, it SHALL be closed with the `state_reason` `not_planned`. When it is a Jira issue, Tiehall SHALL also apply the new team's "not planned" transition to it if that team's Jira mapping has one mapped; while none is mapped, it SHALL only get the notice and SHALL keep its Jira status.

Source: D28 #18, #34, #82; D29 (1), (2); D30 (3); design.md, Decisions this change rests on; design.md, Design rules: Tracker mirrors; design.md, Design rules: Requests and events

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

# Spec Delta: contract-changes

## Purpose

Contract changes turn a provider PR's breaking OpenAPI changes, found by the contract Action in the provider's own CI, into typed requests for every team of the install that declared it consumes the API. The requests follow the PR as it changes, questions go back to the PR's author, and each consumer closes its own request with its own PR.

## ADDED Requirements

### Requirement: Contract diffs run only where the specs already are

Tiehall SHALL NOT fetch, receive, parse or diff OpenAPI documents. Contract diffs SHALL run only in the provider's CI, through the contract Action, and on developers' machines, through the `tiehall` CLI. v1 SHALL support OpenAPI contracts only. The install's GitHub App has no access to repository contents, as the tracker-mirrors capability defines, so Tiehall SHALL NOT read an OpenAPI document from a repository either.

Source: D3; D14; design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Technical decisions: T12

#### Scenario: A repository without the Action gets no contract requests

- **WHEN** a connected installation of the install's GitHub App covers `acme/payments`, no workflow in `acme/payments` runs the contract Action, and a PR there changes the OpenAPI document in a breaking way
- **THEN** Tiehall opens no contract-change request for that PR
- **AND** Tiehall reads no file from `acme/payments`

### Requirement: One report operation that never takes a whole spec

Contract changes SHALL reach Tiehall only through the `contract.report` operation. A report SHALL carry the registered API, the provider PR, the base and head refs with their commit SHAs, the diff engine's name and version, and the engine's classified change list, where each change has its engine id, its level and its operation. `contract.report` SHALL NOT accept an OpenAPI document, and Tiehall SHALL NOT parse one.

Source: D14; design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Design rules: Handoff packet

#### Scenario: A report carries refs and classified changes only

- **WHEN** the contract Action reports a provider PR that has two ERR-level changes
- **THEN** the body it sends to `contract.report` holds the registered API, the PR, the base and head refs and SHAs, the engine name and version, and the two classified changes
- **AND** the body holds no OpenAPI document

#### Scenario: The published operation has no field for a spec

- **WHEN** a client reads the input schema of `contract.report` in `https://tiehall.example.com/api/v1/openapi.json`
- **THEN** the schema has no field that holds an OpenAPI document

### Requirement: Admins register APIs, each bound to one repository

Each API that can receive contract reports SHALL be registered in Tiehall to one provider team of the install and bound to one GitHub repository, which a connected installation of the install's GitHub App SHALL cover, so that Tiehall learns when the provider PR merges or closes and who wrote it; a registration bound to a repository that no connected installation covers SHALL be refused with 409, as the public-api capability's error model defines for a state conflict. Only an admin SHALL register an API, and only in the web UI, with the confirmation step, as the agent-safety capability defines; no MCP tool, CLI command or REST operation SHALL register one. A registration asked for by a member who is not an admin, or without a valid confirmation, SHALL be refused with 403, as the public-api capability's error model defines, and SHALL register nothing. The admin who registers an API MAY bind it to one `job_workflow_ref`. Tiehall SHALL accept a report for a registered API only from a CI run in the repository bound to it, authenticated with the GitHub Actions OIDC token that the agent-access capability defines, and, for an API bound to a `job_workflow_ref`, only from a run of that workflow. A report from a CI run in any other repository, or from another workflow than the one a bound API names, SHALL be refused with 403, the status that the public-api capability's error model gives a CI caller acting outside what it may call, and SHALL open or update no request. Registering an API SHALL be recorded as a security event, as the activity-log capability defines.

Source: D14; D19; D28 #1, #4, #44, #48; design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Design rules: Agent access; design.md, Design rules: Tracker mirrors; design.md, Self-hosting decisions: S7

#### Scenario: A report from another repository is refused

- **WHEN** a CI run in `acme/web` sends a report for the API `payments-api`, which is bound to `acme/payments`
- **THEN** Tiehall refuses the report with 403 and an RFC 9457 problem
- **AND** no request is opened or updated

#### Scenario: A report from the bound repository is accepted

- **WHEN** a CI run in `acme/payments` sends a report for `payments-api` with one ERR-level change
- **THEN** Tiehall accepts the report and routes it under the rules in this capability

#### Scenario: An admin registers an API with the confirmation step

- **WHEN** an admin registers `payments-api` for the PAY team, bound to `acme/payments`, and confirms the registration on its review page in the web UI
- **THEN** `payments-api` is registered
- **AND** a security event for the registration is appended to the activity log

#### Scenario: A repository no connected installation covers

- **WHEN** an admin asks to register `payments-api` bound to `acme/payments`, which no connected installation covers, and confirms it on the review page
- **THEN** the registration is refused with 409 and an RFC 9457 problem
- **AND** `payments-api` is not registered

#### Scenario: A registration without a confirmation

- **WHEN** an admin asks to register `payments-api` without a valid confirmation for that registration
- **THEN** the call is refused with 403 and an RFC 9457 problem
- **AND** `payments-api` is not registered

#### Scenario: A member who is not an admin cannot register an API

- **WHEN** Deniz, a member of PAY who is not an admin, asks to register `payments-api`
- **THEN** the call is refused with 403 and an RFC 9457 problem
- **AND** `payments-api` is not registered

#### Scenario: No agent surface registers an API

- **WHEN** a client lists the tools of `https://tiehall.example.com/mcp`, reads `https://tiehall.example.com/api/v1/openapi.json` and reads the help of the `tiehall` CLI
- **THEN** none of them offers an operation that registers an API

#### Scenario: A report from another workflow of a bound API

- **WHEN** the admin who registered `payments-api` bound it to the workflow `acme/payments/.github/workflows/contract.yml@refs/heads/main`, and a run of another workflow in `acme/payments` sends a report for `payments-api`
- **THEN** Tiehall refuses the report with 403 and an RFC 9457 problem
- **AND** no request is opened or updated

### Requirement: Admins unregister APIs

An admin SHALL be able to unregister an API in the web UI. Unregistering SHALL NOT need the confirmation step, because it only stops reports; it SHALL be recorded as a security event, as the activity-log capability defines. From then on, a report for that API SHALL be refused with 403, as for an API that is not registered to the caller's repository, and the API's consumer-map declarations SHALL route nothing. The requests that its reports opened SHALL stay as they are. A request by a user whose role is `member` to unregister an API SHALL be refused with 403 and SHALL change nothing. Changing an API's provider team, repository or workflow binding SHALL be done by unregistering it and registering it again.

Source: D14; D28 #4; design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Self-hosting decisions: S6; design.md, Self-hosting decisions: S14

#### Scenario: An unregistered API takes no reports

- **WHEN** an admin unregisters `payments-api`, and a CI run in `acme/payments` then reports for it
- **THEN** Tiehall refuses the report with 403 and an RFC 9457 problem
- **AND** `FE-142`, which an earlier report for `payments-api` opened, keeps its state
- **AND** the activity log holds a security event for the unregistration

#### Scenario: A member cannot unregister an API

- **WHEN** Deniz, a member of PAY who is not an admin, asks to unregister `payments-api`
- **THEN** the call is refused with 403 and an RFC 9457 problem
- **AND** `payments-api` stays registered

### Requirement: The contract Action

The contract Action SHALL run on `pull_request` events of the types opened, synchronize, reopened and ready_for_review, and SHALL skip draft PRs unless the workflow turns that default off. It SHALL install the diff engine at the version Tiehall pins, verify the downloaded binary against its pinned checksum before running it, compute the breaking changes and the changelog between the PR's base and head, and report them with a pinned version of the `tiehall` CLI (`tiehall contract report`). It SHALL NOT upload the OpenAPI documents to Tiehall or to any other service. The Action SHALL NOT fail the PR check because the PR has breaking changes, unless the workflow sets an input of the Action that asks for that. Its documentation SHALL show pinning the Action by commit SHA with a version comment, so that dependency-update tools can bump it.

Source: D14; D28 #76; design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Technical decisions: T12

#### Scenario: Draft PRs are skipped by default

- **WHEN** a developer opens a draft PR in `acme/payments` that changes the OpenAPI document in a breaking way
- **THEN** the Action sends no report
- **AND** when the developer marks the PR ready for review, the Action reports the changes

#### Scenario: An engine binary with the wrong checksum is not run

- **WHEN** the engine binary the Action downloads does not match its pinned checksum
- **THEN** the Action does not run it
- **AND** the Action sends no report

#### Scenario: Breaking changes do not fail the check by default

- **WHEN** the Action reports a PR in `acme/payments` that has two ERR-level changes, and the workflow sets no input that asks the Action to fail on breaking changes
- **THEN** the Action's job succeeds
- **AND** the PR check is not marked failed

#### Scenario: An input makes breaking changes fail the check

- **WHEN** the workflow sets the Action's input that asks it to fail on breaking changes, and the PR has one ERR-level change
- **THEN** the Action marks the PR check as failed

### Requirement: The Action reports to the install its workflow names

The contract Action SHALL take the install's URL as an input and SHALL send its report only to that install, authenticated with a GitHub Actions OIDC token whose audience is that URL; the install accepts only a token whose audience is its own `TIEHALL_URL`, as the agent-access capability defines. The Action's documentation SHALL say that a workflow on a GitHub-hosted runner needs an install that is reachable from the internet, and that for an install reachable only inside a company network the workflow must run on a self-hosted runner inside that network. When the runner cannot reach the install, the Action fails open, as the requirement on failing open defines.

Source: D28 #76; design.md, Decisions this change rests on; design.md, Technical decisions: T12; design.md, Self-hosting decisions: S9; design.md, Self-hosting decisions: S15

#### Scenario: The report goes to the install in the input

- **WHEN** the workflow in `acme/payments` sets the Action's install URL input to `https://tiehall.example.com`, and the Action reports a PR with one ERR-level change
- **THEN** the report reaches `https://tiehall.example.com`
- **AND** the OIDC token it carries has the audience `https://tiehall.example.com`

#### Scenario: A GitHub-hosted runner cannot reach an internal install

- **WHEN** the install at `https://tiehall.example.com` is reachable only inside the company network, and the workflow runs the Action on a GitHub-hosted runner for a PR with one ERR-level change
- **THEN** the Action's job succeeds and the PR check is not marked failed
- **AND** no request is opened for the PR

#### Scenario: A self-hosted runner inside the network reaches the install

- **WHEN** the same workflow runs the Action on a self-hosted runner inside the company network
- **THEN** the report reaches the install and opens requests under the rules in this capability

### Requirement: The Action fails open

The contract Action SHALL fail open: it SHALL NOT mark the PR check as failed because Tiehall could not take its report. A check that the workflow asked to fail on breaking changes SHALL still fail for them, because that result comes from the diff the Action computed and not from Tiehall. When the Action cannot reach the install, or the install answers with an error, the Action SHALL finish its job successfully. `contract.report` is stable from its first release and keeps its own CLI version floor, as the public-api capability defines, because the Action runs a pinned CLI. When the install answers a report with 400 and the problem type `upgrade-required`, as the public-api capability's error model defines, the Action SHALL finish its job successfully, with a warning annotation and a job summary that say how to upgrade.

Source: D28 #1, #76; design.md, Decisions this change rests on; design.md, Design rules: Public API; design.md, Self-hosting decisions: S12

#### Scenario: An outdated pinned CLI warns instead of failing

- **WHEN** the Action's pinned CLI is below the contract report floor and the install answers the report with 400 and the problem type `upgrade-required`
- **THEN** the Action's job succeeds
- **AND** the run shows a warning annotation and a job summary that explain how to upgrade

#### Scenario: The install cannot be reached

- **WHEN** the Action runs on a PR in `acme/payments` while the install cannot be reached
- **THEN** the Action's job succeeds
- **AND** the PR check is not marked failed

#### Scenario: Failing on breaking changes does not depend on the install

- **WHEN** the workflow sets the Action's input that asks it to fail on breaking changes, the PR has one ERR-level change, and the install cannot be reached
- **THEN** the Action marks the PR check as failed, because of the breaking change
- **AND** its job summary says that the report could not be delivered

#### Scenario: The install is restarting for an upgrade

- **WHEN** the Action reports while the install is restarting for an upgrade and answers 503
- **THEN** the Action's job succeeds
- **AND** the PR check is not marked failed

### Requirement: Attaching a contract diff to a request by hand

`tiehall contract diff` SHALL run the diff engine from the developer's PATH on the developer's own machine, SHALL refuse engine versions below the version Tiehall pins, and SHALL let the developer attach the classified result to a request as the contract section of its packet, as the handoff-packet capability defines. The result SHALL be attached through the `attach_contract_changes` MCP tool or the matching REST operation, and both SHALL need the `contracts:report` scope, as the agent-access capability defines; a caller whose token lacks it SHALL be refused with 403 `insufficient_scope`. Attaching SHALL follow the rules for packet changes that the requests and handoff-packet capabilities define: only the requester side may attach, the call carries the revision it expects and a missing or stale one is refused, and because the contract section is part of a request's scope, attaching to a claimed request SHALL become a scope-change proposal instead of taking effect at once. Attaching SHALL NOT route the changes to the teams that consume the API: it SHALL open or update no other request and SHALL add nothing to any digest.

Source: D14; D23; D28 #3, #15, #77; D30 (3); design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Design rules: Handoff packet

#### Scenario: A developer attaches a classified diff to a request

- **WHEN** Deniz, a member of PAY, opened `FE-142` to FE, it is `open` and unclaimed, and Deniz runs `tiehall contract diff` between two refs of the `payments-api` OpenAPI document and attaches the result to `FE-142`
- **THEN** `FE-142` gets a new packet revision whose contract section carries the classified changes, the base and head refs, and the engine name and version

#### Scenario: An attached diff is not routed to consuming teams

- **WHEN** MOBILE has declared that it consumes `payments-api`, and Deniz attaches a `tiehall contract diff` result for `payments-api` with two ERR-level changes to `FE-142`
- **THEN** the packet of `FE-142` carries the two changes
- **AND** MOBILE gets no request and no digest entry for them

#### Scenario: Attaching to a claimed request becomes a proposal

- **WHEN** Mehmet, a member of FE, has claimed `FE-142`, and Deniz attaches a `tiehall contract diff` result to it
- **THEN** the call returns a scope-change proposal, as the requests capability defines
- **AND** the packet of `FE-142` keeps its current revision until the proposal takes effect

#### Scenario: Attaching without the contracts:report scope

- **WHEN** Deniz attaches a `tiehall contract diff` result to `FE-142` with a token that does not carry `contracts:report`
- **THEN** the call is refused with 403 `insufficient_scope`
- **AND** the packet of `FE-142` is unchanged

#### Scenario: An outdated engine is refused

- **WHEN** the diff engine on the developer's PATH is older than the version Tiehall pins
- **THEN** `tiehall contract diff` refuses to run, names the minimum version, and attaches nothing

### Requirement: Teams declare the APIs they consume

The consumer map SHALL consist of declarations made in Tiehall, each stating that one team of the install consumes one registered API. Any member of a team SHALL be able to declare that the team consumes a registered API. A user who is not a member of that team, whatever their role, SHALL be refused with 403 and an RFC 9457 problem, as the public-api capability's error model defines for a role that does not allow the operation. Each declaration SHALL record who declared it (`declared_by`) and when it was last confirmed (`last_confirmed_at`). Any member of the team SHALL also be able to remove the team's declaration when the team stops consuming the API, after which contract changes to it SHALL no longer route to that team; a user who is not a member of that team SHALL be refused with 403 in the same way. In v1 the map SHALL come only from these declarations; imports from other sources come later. Contract-change routing SHALL use only the declared map.

Source: D15; D28 #1, #4, #72; design.md, Decisions this change rests on; design.md, Design rules: Contract changes

#### Scenario: A declaration records its author and time

- **WHEN** Ayşe, a member of the FE team, declares on 2026-11-02 that FE consumes `payments-api`
- **THEN** the declaration shows Ayşe as its declarer and 2026-11-02 as its last confirmation
- **AND** the next report for `payments-api` with an ERR-level change opens a request to FE

#### Scenario: Undeclared consumers get nothing

- **WHEN** the MOBILE team calls `payments-api` but has not declared it, and a report for `payments-api` has an ERR-level change
- **THEN** MOBILE gets no request for it

#### Scenario: A team removes its declaration

- **WHEN** Ayşe, a member of FE, removes FE's declaration for `payments-api`, and a report for `payments-api` then has an ERR-level change
- **THEN** FE gets no request for it

#### Scenario: A member of another team cannot declare for FE

- **WHEN** Zeynep, a member of MOBILE who is not a member of FE, asks to declare that FE consumes `payments-api`
- **THEN** Tiehall refuses with 403 and an RFC 9457 problem
- **AND** FE has no declaration for `payments-api`

### Requirement: Declarations are re-confirmed every 90 days

Tiehall SHALL ask the consuming team to re-confirm each declaration once 90 days have passed since it was last confirmed, with a re-confirmation request in the team's inbox, which lists it in the web inbox of each member of the team until the declaration is re-confirmed, as the requester-loop capability defines, and, when SMTP is set, by email to each member of the team. A member who has turned the daily digest off, as the requester-loop capability defines, SHALL still get the re-confirmation email. Any member of the consuming team SHALL be able to re-confirm the declaration; anyone else SHALL be refused with 403 and an RFC 9457 problem, as the public-api capability's error model defines for a role that does not allow the operation. Re-confirming SHALL set the last-confirmed time to the time of re-confirmation and SHALL keep the original declarer. A declaration left unconfirmed for 30 more days after it came due, that is 120 days after its last confirmation, SHALL be marked stale until it is re-confirmed. A stale declaration SHALL keep routing contract changes to its team like any other declaration.

Source: D15; D28 #1, #61, #72, #73; D29 (6); design.md, Decisions this change rests on; design.md, Design rules: Requester loop; design.md, Self-hosting decisions: S10

#### Scenario: A declaration comes due after 90 days

- **WHEN** SMTP is set, and FE's declaration for `payments-api` was last confirmed on 2026-10-01
- **THEN** FE is not asked to re-confirm it on 2026-12-29
- **AND** on 2026-12-30 a re-confirmation request for it reaches FE's inbox and, by email, each FE member

#### Scenario: Without SMTP the request stays in the inbox

- **WHEN** SMTP is not set, and FE's declaration for `payments-api` comes due for re-confirmation
- **THEN** the re-confirmation request is listed in the web inbox of each FE member
- **AND** no email is sent

#### Scenario: The digest switch does not stop re-confirmation emails

- **WHEN** SMTP is set, Mehmet, an FE member, has turned the daily digest off, and FE's declaration for `payments-api` comes due for re-confirmation
- **THEN** Mehmet gets the re-confirmation email

#### Scenario: Re-confirming updates only the confirmation time

- **WHEN** Mehmet, an FE member, re-confirms on 2026-12-31 a declaration that Ayşe made
- **THEN** the declaration shows Ayşe as its declarer and 2026-12-31 as its last confirmation
- **AND** the re-confirmation request leaves the web inbox of each FE member

#### Scenario: A member of another team cannot re-confirm

- **WHEN** Zeynep, a member of MOBILE who is not a member of FE, asks to re-confirm FE's declaration for `payments-api`
- **THEN** Tiehall refuses with 403 and an RFC 9457 problem
- **AND** the declaration's last confirmation does not change

#### Scenario: An unconfirmed declaration goes stale but keeps routing

- **WHEN** FE's declaration for `payments-api` was last confirmed on 2026-10-01 and no one re-confirms it
- **THEN** the declaration is not marked stale on 2027-01-28 and is marked stale on 2027-01-29
- **AND** a report for `payments-api` with an ERR-level change on 2027-02-01 still opens a request to FE

### Requirement: Breaking changes open one request per consuming team

For a report with ERR-level changes, Tiehall SHALL open one request to each team that the consumer map lists for the API, with the classified changes in the packet's contract section. A change set is the set of changes reported for one provider PR against one registered API, so a PR that changes several registered APIs makes several change sets. Each request SHALL be keyed by its change set and its team, so that a rerun or a later report for the same change set updates the existing request and does not open a second one, except after the provider PR is reopened, as the requirement on PRs that close unmerged defines. The number of teams one PR reaches SHALL stay within the fan-out limit that the agent-safety capability defines. Opening a request from a report SHALL be recorded with the actor kind `system` and the surface `github`, as the requests capability defines for provenance.

Source: D14; D28 #70, #74; D30 (3); design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Design rules: Agent safety

#### Scenario: Two consuming teams each get one request

- **WHEN** FE and MOBILE have declared that they consume `payments-api`, and a report for PR #310 in `acme/payments` has two ERR-level changes
- **THEN** FE gets one new request, such as `FE-142`, and MOBILE gets one new request, such as `MOBILE-17`
- **AND** the packet of each carries both classified changes

#### Scenario: A request opened from a report is recorded as a system action

- **WHEN** a report for PR #310 opens `FE-142`
- **THEN** the event for the opening of `FE-142` has the actor kind `system` and the surface `github`

#### Scenario: A rerun opens nothing new

- **WHEN** the same workflow run for PR #310 is re-run and reports the same two changes
- **THEN** FE and MOBILE each still have exactly one request for that change set

#### Scenario: One PR against two APIs makes two change sets

- **WHEN** FE has declared that it consumes both `payments-api` and `billing-api`, and a report for each API from PR #310 has one ERR-level change
- **THEN** FE gets two requests, one for each change set

### Requirement: Potentially breaking changes go to a daily digest

WARN-level changes SHALL NOT open requests by default. Tiehall SHALL list them in a daily digest for each consuming team, delivered to the team's inbox, which lists it in the web inbox of each member of the team, as the requester-loop capability defines, and, when SMTP is set, by email to each member of the team. A member who has turned the daily digest off, as the requester-loop capability defines, SHALL NOT get the WARN digest by email; the team's inbox SHALL still list it. Each registered API SHALL have a WARN switch that, when on, routes its WARN-level changes the same way as ERR-level changes, opening or updating requests instead of going to the digest. An admin or a member of the API's provider team SHALL be able to turn the switch on or off; anyone else SHALL be refused with 403 and an RFC 9457 problem, as the public-api capability's error model defines for a role that does not allow the operation.

Source: D28 #1, #61, #72, #73; D29 (6); design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Self-hosting decisions: S10

#### Scenario: WARN-level changes reach the digest only

- **WHEN** SMTP is set, a report for `payments-api` has one WARN-level change and no ERR-level change, and the API's WARN switch is off
- **THEN** no request is opened
- **AND** FE's next daily digest lists the change with its provider PR, both in FE's inbox and in the email to each FE member

#### Scenario: A member who turned the digest off gets no WARN digest email

- **WHEN** SMTP is set, Mehmet, an FE member, has turned the daily digest off, and a report for `payments-api` has one WARN-level change while the API's WARN switch is off
- **THEN** Mehmet gets no WARN digest email for it
- **AND** FE's inbox still lists the change in FE's next daily digest

#### Scenario: The per-API switch opens requests for WARN-level changes

- **WHEN** the WARN switch of `payments-api` is on and a report has one WARN-level change
- **THEN** FE and MOBILE each get one request for that change set

#### Scenario: The provider team or an admin flips the switch

- **WHEN** Deniz, a member of PAY, the team that `payments-api` is registered to, turns the WARN switch of `payments-api` on
- **THEN** the switch is on
- **AND** when an admin who is in no team turns it off again, the switch is off

#### Scenario: A consuming team's member cannot flip the switch

- **WHEN** Ayşe, a member of FE who is neither an admin nor a member of PAY, asks to turn the WARN switch of `payments-api` on
- **THEN** Tiehall refuses with 403 and an RFC 9457 problem
- **AND** the switch stays off

### Requirement: INFO-level changes appear only on existing requests

INFO-level changes SHALL NOT open requests and SHALL NOT appear in any digest. Tiehall SHALL show them only in the list of classified changes in the contract section of the requests that other changes of the same change set have opened.

Source: D28 #71; design.md, Decisions this change rests on; design.md, Design rules: Contract changes

#### Scenario: A report with only INFO-level changes opens nothing

- **WHEN** FE has declared that it consumes `payments-api`, and a report for `payments-api` has only INFO-level changes
- **THEN** no request is opened
- **AND** FE's next daily digest does not list those changes

#### Scenario: INFO-level changes are listed on an existing request

- **WHEN** `FE-142` exists for the change set of PR #310, and a new report for that change set has two ERR-level changes and one INFO-level change
- **THEN** the new packet revision of `FE-142` lists all three changes, each with its level

### Requirement: Bursts of reports are merged into one update

Tiehall SHALL merge reports for the same change set that arrive within 2 minutes of each other into a single update, which reflects the latest of those reports. The 2 minutes SHALL start with the first report of a burst: Tiehall SHALL apply the update 2 minutes after that report, with the latest report received by then, and a report that arrives later SHALL start the next burst. So a change set's update SHALL never wait more than 2 minutes, however often reports arrive.

Source: design.md, Design rules: Contract changes

#### Scenario: Two quick pushes produce one revision

- **WHEN** `FE-142` exists for the change set of PR #310, and two reports for it arrive at 09:00:00 and 09:00:40 UTC with no further report after them
- **THEN** at 09:02:00 UTC `FE-142` gets exactly one new packet revision
- **AND** that revision matches the second report

#### Scenario: A steady stream of reports is not merged forever

- **WHEN** reports for the change set of PR #310 arrive every 90 seconds from 09:00:00 UTC
- **THEN** `FE-142` gets a revision at 09:02:00 UTC that matches the report of 09:01:30
- **AND** the report of 09:03:00 starts the next burst, whose revision follows at 09:05:00

### Requirement: Each update adds a packet revision and a system message

Each update to a change set SHALL add a new packet revision to each request for that change set that is not in a terminal state, and a system message, written by Tiehall, that states how the number of breaking changes changed. A request for the change set that is in a terminal state (`done`, `declined` or `withdrawn`) SHALL get only a notice of the update, and no new packet revision. These revisions follow a signed report from the provider's CI, not an agent's decision, so they SHALL be system actions rather than commitments, also while the request is claimed: they SHALL take effect at once, with no proposal and no confirmation, as the requests capability defines for system actions, and SHALL be recorded, like the system message, with the actor kind `system` and the surface `github`. A pending proposal to change the packet of such a request SHALL then be cancelled as stale, as the requests capability defines, because the current revision has moved past its base revision.

Source: D28 #74; D30 (3), (4); design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Design rules: Requests and events

#### Scenario: A push that adds a breaking change

- **WHEN** `FE-142` is claimed, its packet is at revision 1 with 2 breaking changes, and a new push to PR #310 reports 3 breaking changes
- **THEN** `FE-142` gets packet revision 2 with the 3 changes, with no proposal and no confirmation
- **AND** its thread gets one system message, with the actor kind `system` and the surface `github`, that states the earlier count of 2 breaking changes and the new count of 3, for example "diff updated: 2 → 3 breaking"

#### Scenario: A pending packet change goes stale

- **WHEN** `FE-142` is claimed, its packet is at revision 1, a scope-change proposal based on revision 1 is waiting for confirmation, and a new report for PR #310 adds revision 2
- **THEN** the scope-change proposal is cancelled as stale

#### Scenario: A request in a terminal state gets only a notice

- **WHEN** `FE-142` is `done` with its packet at revision 2, and a new push to PR #310 reports 3 breaking changes instead of 2
- **THEN** `FE-142` gets a notice of the update
- **AND** its packet stays at revision 2 and it stays `done`

### Requirement: Requests are withdrawn when the breaking changes disappear

When a later update for a change set no longer contains any change that opens requests under these rules, Tiehall SHALL withdraw each request for it that is unclaimed, and SHALL add a notice to each claimed request without changing that request's state. These withdrawals follow a signed report from the provider's CI, not an agent's decision, so they SHALL be system withdrawals, as the requests capability defines: they SHALL need no proposal and no confirmation, and SHALL never touch a claimed request.

Source: D23; design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Design rules: Requests and events

#### Scenario: A fix on the provider PR withdraws unclaimed requests only

- **WHEN** `FE-142` is open and unclaimed, `MOBILE-17` is claimed, and a new push to PR #310 reports no ERR-level change while the WARN switch of `payments-api` is off
- **THEN** `FE-142` moves to `withdrawn` with no proposal and no confirmation
- **AND** `MOBILE-17` stays claimed and gets a notice that the breaking changes are gone

### Requirement: Requests are withdrawn when the provider PR closes unmerged

When Tiehall learns that a provider PR closed without merging, through the GitHub App's events or polling as the tracker-mirrors capability defines, it SHALL withdraw each request for the PR's change sets that is unclaimed, as a system withdrawal that needs no proposal and no confirmation. It SHALL NOT change the state of any claimed request, and SHALL add to each claimed request a notice that the provider PR closed without merging. A request in a terminal state SHALL only get that notice. When the provider PR is reopened, the next report for it SHALL open, under the routing rules of this capability, a new request for each consuming team whose request was withdrawn when the PR closed; requests that stayed claimed SHALL be updated by that report as usual. Tiehall learns of closes and merges only for provider PRs in repositories that a connected installation covers, as the tracker-mirrors capability defines.

Source: D23; D28 #74; design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Design rules: Requests and events; design.md, Self-hosting decisions: S9

#### Scenario: Closing the PR unmerged

- **WHEN** PR #310 closes without merging while `FE-142` is open and unclaimed and `MOBILE-17` is `in_progress`
- **THEN** `FE-142` moves to `withdrawn` with no proposal
- **AND** `MOBILE-17` stays `in_progress` and gets a notice that PR #310 closed without merging

#### Scenario: A reopened PR brings new requests through the next report

- **WHEN** PR #310 closed without merging, which withdrew `FE-142` while `MOBILE-17` stayed `in_progress`, and PR #310 is then reopened and the Action reports its two ERR-level changes
- **THEN** FE gets a new request, such as `FE-150`, for the change set, and `FE-142` stays `withdrawn`
- **AND** `MOBILE-17` gets a new packet revision, and MOBILE gets no second request

#### Scenario: A close found by polling

- **WHEN** GitHub runs in polling mode, as the tracker-mirrors capability defines, and PR #310 closes without merging while `FE-142` is open and unclaimed
- **THEN** within 2 minutes `FE-142` moves to `withdrawn`

### Requirement: Merging the provider PR marks the change shipped

When Tiehall learns that the provider PR merged, through the GitHub App's events or polling as the tracker-mirrors capability defines, it SHALL mark the provider change as shipped on every request for its change sets and update those requests' tracker mirrors. The merge SHALL NOT move those requests to done; each consumer closes its own request with its own PR.

Source: D14; design.md, Decisions this change rests on; design.md, Design rules: Contract changes

#### Scenario: The provider merges first

- **WHEN** PR #310 merges while `FE-142` is `in_progress`
- **THEN** `FE-142` shows the provider change as shipped
- **AND** `FE-142` stays `in_progress` until FE's own PR closes it

#### Scenario: The merge reaches the tracker mirror

- **WHEN** PR #310 merges while `FE-142` has a mirror issue
- **THEN** Tiehall updates the mirror issue of `FE-142` after the merge

### Requirement: The provider PR's author is the requester

The requester of a contract-change request SHALL be the Tiehall user whose GitHub account, as the sign-in capability defines, authored the provider PR, when that user is a member of the install. That user SHALL be recorded as the request's requesting user, and the provider team that the API is registered to SHALL be recorded as its requesting team. Consumers' questions SHALL reach that user through the requester loop, as the requester-loop capability defines. When the author's GitHub account belongs to no Tiehall user, or to a user who is not a member of the install, the provider team SHALL be the requester, and the requester loop then reaches that team's inbox and, when SMTP is set, by email the members of that team who opt in, as the requester-loop capability defines. In that case the contract Action SHALL comment on the provider PR using the workflow's own `GITHUB_TOKEN`. The Action SHALL post that comment once per PR and SHALL update it in place on later runs instead of posting another.

Source: D14; D28 #62, #75, #76; D37; design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Self-hosting decisions: S5

#### Scenario: A member's PR makes them the requester

- **WHEN** Deniz, a member of the install who signs in with the GitHub account that opened PR #310, belongs to PAY, `payments-api` is registered to PAY, and `FE-142` is opened for that PR
- **THEN** Deniz is the requesting user of `FE-142` and PAY is its requesting team
- **AND** a blocking question that FE's agent posts on `FE-142` reaches Deniz through the requester loop, in Deniz's `whats_new`

#### Scenario: An author with no Tiehall user falls back to the provider team

- **WHEN** the GitHub account that opened PR #310 has never signed in to the install, and the API is registered to the PAY team
- **THEN** PAY is the requester of `FE-142`
- **AND** the Action posts a comment on PR #310 with the workflow's `GITHUB_TOKEN`

#### Scenario: A removed member's PR falls back to the provider team

- **WHEN** the GitHub account that opened PR #310 belongs to a Tiehall user who was removed from the install, and the API is registered to the PAY team
- **THEN** PAY is the requester of `FE-142`
- **AND** the Action posts a comment on PR #310 with the workflow's `GITHUB_TOKEN`

#### Scenario: The fallback comment is updated in place

- **WHEN** PAY is the requester for the change set of PR #310, the Action has already commented on PR #310, and the Action runs again after a new push
- **THEN** PR #310 still has exactly one comment from the Action
- **AND** that comment shows the latest run

### Requirement: Consumers close requests with their own PR

A contract-change request SHALL be closed by the consuming team's own PR, one that mentions the request's key or was linked to it, under the close-on-merge rules that the requests capability defines. Nothing on the provider side, neither a report nor the provider PR's merge, SHALL move a contract-change request to done. So the provider PR of a request's own change set SHALL NOT count as a qualifying merged PR for that request, even when its title, body or branch name mentions the request's key or it was linked to the request; its merge marks the provider change shipped, as the requirement on merging the provider PR defines.

Source: D14; D23; design.md, Decisions this change rests on; design.md, Design rules: Contract changes; design.md, Design rules: Requests and events

#### Scenario: The consumer's PR closes the request on merge

- **WHEN** `FE-142` was claimed, and a PR with the branch `FE-142-new-payment-fields` in `acme/web`, a repository that a connected installation covers, merges after the claim
- **THEN** `FE-142` moves to `done` with no proposal and no confirmation

#### Scenario: The provider PR does not close a request it mentions

- **WHEN** `FE-142` is `in_progress` for the change set of PR #310 in `acme/payments`, the body of PR #310 mentions `FE-142`, and PR #310 merges
- **THEN** `FE-142` shows the provider change as shipped
- **AND** `FE-142` stays `in_progress`

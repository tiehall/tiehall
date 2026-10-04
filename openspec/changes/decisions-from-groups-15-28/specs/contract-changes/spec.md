# Spec Delta: contract-changes

## Purpose

States `contract.report`'s input, the workflow binding, re-registration under an old name, the Action's failures, hand-attached sections without a PR, events for the consumer map, the WARN digest's content and lifetime, reports that change nothing, changes that return after a withdrawal, reopened PRs, and the provider merge's message. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: One report operation that never takes a whole spec

Contract changes SHALL reach Tiehall only through the `contract.report` operation. A report SHALL carry the registered API, the provider PR, the base and head refs with their commit SHAs, the diff engine's name and version, and the engine's classified change list, where each change has its engine id, its level and its operation. `contract.report` SHALL NOT accept an OpenAPI document, and Tiehall SHALL NOT parse one. `contract.report` SHALL refuse with 400, as input that fails the schema, a field it does not define at any level of its input; SHALL take at most 1,000 changes; SHALL name the provider PR by its number alone, the repository being the one the API is bound to; and SHALL name the API by its registered name, which has 1 to 100 characters of lower-case letters, digits, `.`, `_` and `-`. A report body SHALL be at most 16 MiB, the limit the public-api capability sets for `contract.report`; a larger body SHALL be refused with 413 and the problem type `payload-too-large`, as the public-api capability's error model defines, before it is parsed, and SHALL open or update no request.

Source: D14; D43; D55 (59); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A report carries refs and classified changes only

- **WHEN** the contract Action reports a provider PR that has two ERR-level changes
- **THEN** the body it sends to `contract.report` holds the registered API, the PR, the base and head refs and SHAs, the engine name and version, and the two classified changes
- **AND** the body holds no OpenAPI document

#### Scenario: The published operation has no field for a spec

- **WHEN** a client reads the input schema of `contract.report` in `https://tiehall.example.com/api/v1/openapi.json`
- **THEN** the schema has no field that holds an OpenAPI document

#### Scenario: A report over the size limit opens nothing

- **WHEN** the contract Action sends a 17 MiB report to `contract.report`
- **THEN** the API answers 413 with an RFC 9457 problem whose problem type is `payload-too-large`
- **AND** no request is opened or updated

#### Scenario: A field the operation does not define

- **WHEN** the contract Action sends a report one of whose changes carries a field that `contract.report` does not define
- **THEN** the API answers 400 with an RFC 9457 problem
- **AND** no request is opened or updated

#### Scenario: Too many changes

- **WHEN** the contract Action sends a report with 1,001 changes
- **THEN** the API answers 400 with an RFC 9457 problem
- **AND** no request is opened or updated

### Requirement: Admins register APIs, each bound to one repository

Each API that can receive contract reports SHALL be registered in Tiehall to one provider team of the install and bound to one GitHub repository, which a connected installation of the install's GitHub App SHALL cover, so that Tiehall learns when the provider PR merges or closes and who wrote it; a registration bound to a repository that no connected installation covers SHALL be refused with 409, as the public-api capability's error model defines for a state conflict. Only an admin SHALL register an API, and only in the web UI, with the confirmation step, as the agent-safety capability defines; no MCP tool, CLI command or REST operation SHALL register one. A registration asked for by a member who is not an admin, or without a valid confirmation, SHALL be refused with 403, as the public-api capability's error model defines, and SHALL register nothing. An API's name SHALL have 1 to 100 characters of lower-case letters, digits, `.`, `_` and `-`; a registration with any other name SHALL be refused with 400 and SHALL register nothing. The admin who registers an API MAY bind it to one workflow, named by its repository and the path of its workflow file, as the agent-access capability defines. Tiehall SHALL accept a report for a registered API only from a CI run in the repository bound to it, authenticated with the GitHub Actions OIDC token that the agent-access capability defines, and, for an API bound to a `job_workflow_ref`, only from a run of that workflow. A report from a CI run in any other repository, or from another workflow than the one a bound API names, SHALL be refused with 403, the status that the public-api capability's error model gives a CI caller acting outside what it may call, and SHALL open or update no request. Registering an API SHALL be recorded as a security event, as the activity-log capability defines.

Source: D14; D19; D28 #1, #4, #44, #48; D55 (59), (61); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

- **WHEN** the admin who registered `payments-api` bound it to the workflow `acme/payments/.github/workflows/contract.yml`, and a run of another workflow in `acme/payments` sends a report for `payments-api`
- **THEN** Tiehall refuses the report with 403 and an RFC 9457 problem
- **AND** no request is opened or updated

#### Scenario: A bound API takes reports from its workflow's pull request runs

- **WHEN** `payments-api` is bound to the workflow `acme/payments/.github/workflows/contract.yml`, and a run of that workflow for PR #310 reports for `payments-api` about PR #310
- **THEN** Tiehall accepts the report and routes it under the rules in this capability

#### Scenario: A name outside its form

- **WHEN** an admin asks to register an API named `Payments API` and confirms it on the review page
- **THEN** the registration is refused with 400
- **AND** no API is registered

### Requirement: Admins unregister APIs

An admin SHALL be able to unregister an API in the web UI. Unregistering SHALL NOT need the confirmation step, because it only stops reports; it SHALL be recorded as a security event, as the activity-log capability defines. From then on, a report for that API SHALL be refused with 403, as for an API that is not registered to the caller's repository, and the API's consumer-map declarations SHALL route nothing. The requests that its reports opened SHALL stay as they are. A request by a user whose role is `member` to unregister an API SHALL be refused with 403 and SHALL change nothing. Changing an API's provider team, repository or workflow binding SHALL be done by unregistering it and registering it again. Registering an API under the name of an unregistered one SHALL reuse that API, with its earlier consumer-map declarations, only when its repository and its provider team are the same as before; otherwise it SHALL be a new API, to which the earlier declarations SHALL NOT carry over, so that the consuming teams declare it again.

Source: D14; D28 #4; D55 (56); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: An unregistered API takes no reports

- **WHEN** an admin unregisters `payments-api`, and a CI run in `acme/payments` then reports for it
- **THEN** Tiehall refuses the report with 403 and an RFC 9457 problem
- **AND** `FE-142`, which an earlier report for `payments-api` opened, keeps its state
- **AND** the activity log holds a security event for the unregistration

#### Scenario: A member cannot unregister an API

- **WHEN** Deniz, a member of PAY who is not an admin, asks to unregister `payments-api`
- **THEN** the call is refused with 403 and an RFC 9457 problem
- **AND** `payments-api` stays registered

#### Scenario: A name registered again for another repository starts afresh

- **WHEN** `payments-api`, bound to `acme/payments` for PAY and declared by FE, was unregistered, and an admin registers `payments-api` again bound to `acme/billing`
- **THEN** FE has no declaration for the new `payments-api`
- **AND** a report for it with an ERR-level change opens no request to FE

#### Scenario: A name registered again unchanged keeps its declarations

- **WHEN** `payments-api`, bound to `acme/payments` for PAY and declared by FE, was unregistered, and an admin registers it again bound to `acme/payments` for PAY
- **THEN** FE's declaration for `payments-api` holds again
- **AND** the next report for it with an ERR-level change opens a request to FE

### Requirement: The Action fails open

The contract Action SHALL fail open: it SHALL NOT mark the PR check as failed because Tiehall could not take its report. A check that the workflow asked to fail on breaking changes SHALL still fail for them, because that result comes from the diff the Action computed and not from Tiehall. When the Action cannot reach the install, or the install answers with an error, the Action SHALL finish its job successfully. `contract.report` is stable from its first release and keeps its own CLI version floor, as the public-api capability defines, because the Action runs a pinned CLI. When the install answers a report with 400 and the problem type `upgrade-required`, as the public-api capability's error model defines, the Action SHALL finish its job successfully, with a warning annotation and a job summary that say how to upgrade. When the download of the diff engine is blocked, when the OpenAPI document holds external `$ref`s that the Action does not follow, when the PR deletes the document, and when the install refuses the report with another 400, such as for more than 1,000 changes, or with 413, the Action SHALL finish its job successfully, with a warning annotation and a job summary that say what happened. Only a downloaded diff engine whose checksum does not match the pinned one SHALL fail the step. With the input that asks it to fail on breaking changes, the Action SHALL still fail the check for the breaking changes it computed; when it could compute none, it SHALL NOT fail the check for that.

Source: D28 #1, #76; D55 (62); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A blocked download of the diff engine

- **WHEN** the Action runs on a PR in `acme/payments` and the download of the diff engine is blocked
- **THEN** the Action's job succeeds
- **AND** the run shows a warning annotation and a job summary that say that no diff was computed

#### Scenario: A report over 16 MiB

- **WHEN** the install answers the Action's report with 413
- **THEN** the Action's job succeeds
- **AND** the run shows a warning annotation and a job summary that say that the report was too large and that no consuming team was told

#### Scenario: A diff engine whose checksum does not match

- **WHEN** the diff engine the Action downloads does not match the pinned checksum
- **THEN** the step fails
- **AND** the Action does not run that engine

### Requirement: Attaching a contract diff to a request by hand

`tiehall contract diff` SHALL run the diff engine from the developer's PATH on the developer's own machine, SHALL refuse engine versions below the version Tiehall pins, and SHALL let the developer attach the classified result to a request as the contract section of its packet, as the handoff-packet capability defines. The result SHALL be attached through the `attach_contract_changes` MCP tool or the matching REST operation, and both SHALL need the `contracts:report` scope, as the agent-access capability defines; a caller whose token lacks it SHALL be refused with 403 `insufficient_scope`. Attaching SHALL follow the rules for packet changes that the requests and handoff-packet capabilities define: only the requester side may attach, the call carries the revision it expects and a missing or stale one is refused, and because the contract section is part of a request's scope, attaching to a claimed request SHALL become a scope-change proposal instead of taking effect at once. Attaching SHALL NOT route the changes to the teams that consume the API: it SHALL open or update no other request and SHALL add nothing to any digest. In a contract section attached by hand, the provider PR and the provider status MAY be left out, as the handoff-packet capability defines, because a developer may diff two refs that no PR holds yet.

Source: D14; D23; D28 #3, #15, #77; D30 (3); D55 (63); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A diff attached with no provider PR

- **WHEN** Deniz runs `tiehall contract diff` between two refs of the `payments-api` OpenAPI document that no PR holds, and attaches the result to `FE-142`, which is `open` and unclaimed
- **THEN** `FE-142` gets a new packet revision whose contract section carries the classified changes and names no provider PR and no provider status

### Requirement: Teams declare the APIs they consume

The consumer map SHALL consist of declarations made in Tiehall, each stating that one team of the install consumes one registered API. Any member of a team SHALL be able to declare that the team consumes a registered API. A user who is not a member of that team, whatever their role, SHALL be refused with 403 and an RFC 9457 problem, as the public-api capability's error model defines for a role that does not allow the operation. Each declaration SHALL record who declared it (`declared_by`) and when it was last confirmed (`last_confirmed_at`). Any member of the team SHALL also be able to remove the team's declaration when the team stops consuming the API, after which contract changes to it SHALL no longer route to that team; a user who is not a member of that team SHALL be refused with 403 in the same way. In v1 the map SHALL come only from these declarations; imports from other sources come later. Contract-change routing SHALL use only the declared map. Declaring that a team consumes an API, removing that declaration and re-confirming it SHALL each append a domain event in the same transaction as the change, naming the team, the API and the user who acted, which the activity log shows, as the activity-log capability defines; no reader of the requester loop serves these events, because they concern no request. Declarations SHALL be made, removed and re-confirmed only in the web UI; no MCP tool, CLI command or REST operation SHALL offer them.

Source: D15; D28 #1, #4, #72; D55 (60); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: Changes to the map are in the activity log

- **WHEN** Ayşe, a member of FE, declares that FE consumes `payments-api`, and Mehmet, another member of FE, later removes that declaration
- **THEN** the activity log holds a domain event for the declaration that names FE, `payments-api` and Ayşe
- **AND** one for the removal that names FE, `payments-api` and Mehmet

#### Scenario: No agent surface changes the map

- **WHEN** a client lists the tools of `https://tiehall.example.com/mcp`, reads `https://tiehall.example.com/api/v1/openapi.json` and reads the help of the `tiehall` CLI
- **THEN** none of them offers an operation that declares, removes or re-confirms a team's consumption of an API

### Requirement: Breaking changes open one request per consuming team

For a report with ERR-level changes, Tiehall SHALL open one request to each team that the consumer map lists for the API, with the classified changes in the packet's contract section. A change set is the set of changes reported for one provider PR against one registered API, so a PR that changes several registered APIs makes several change sets. Each request SHALL be keyed by its change set and its team, so that a rerun or a later report for the same change set updates the existing request and does not open a second one, except after the provider PR is reopened, as the requirement on PRs that close unmerged defines, and after Tiehall withdrew the team's request because the breaking changes disappeared, as the requirement on that withdrawal defines. The number of teams one PR reaches SHALL stay within the fan-out limit that the agent-safety capability defines. Opening a request from a report SHALL be recorded with the actor kind `system` and the surface `github`, as the requests capability defines for provenance.

Source: D14; D28 #70, #74; D30 (3); D55 (68); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

WARN-level changes SHALL NOT open requests by default. Tiehall SHALL list them in a daily digest for each consuming team, delivered to the team's inbox, which lists it in the web inbox of each member of the team, as the requester-loop capability defines, and, when SMTP is set, by email to each member of the team. A member who has turned the daily digest off, as the requester-loop capability defines, SHALL NOT get the WARN digest by email; the team's inbox SHALL still list it. Each registered API SHALL have a WARN switch that, when on, routes its WARN-level changes the same way as ERR-level changes, opening or updating requests instead of going to the digest. The WARN digest SHALL give, for each API, the number of its WARN-level changes, the API's name and a link to each provider PR, and SHALL NOT give the changes' own text. A team's WARN digest SHALL stay in a member's standing list until that member dismisses it, or until 7 days after it was produced, whichever comes first. An admin or a member of the API's provider team SHALL be able to turn the switch on or off; anyone else SHALL be refused with 403 and an RFC 9457 problem, as the public-api capability's error model defines for a role that does not allow the operation.

Source: D28 #1, #61, #72, #73; D29 (6); D55 (69), (70); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: WARN-level changes reach the digest only

- **WHEN** SMTP is set, a report for `payments-api` has one WARN-level change and no ERR-level change, and the API's WARN switch is off
- **THEN** no request is opened
- **AND** FE's next daily digest gives one WARN-level change for `payments-api` with a link to its provider PR, both in FE's inbox and in the email to each FE member, and not the change's own text

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

#### Scenario: A WARN digest leaves the standing list

- **WHEN** FE's WARN digest was produced on 2026-11-02, Mehmet, a member of FE, dismisses it on 2026-11-03, and Ayşe, another member of FE, does nothing
- **THEN** Mehmet's standing list no longer lists it from 2026-11-03 on
- **AND** Ayşe's standing list lists it until 2026-11-09 and not after

### Requirement: Each update adds a packet revision and a system message

Each update to a change set SHALL add a new packet revision to each request for that change set that is not in a terminal state, and a system message, written by Tiehall, that states how the number of breaking changes changed. A request for the change set that is in a terminal state (`done`, `declined` or `withdrawn`) SHALL get only a notice of the update, and no new packet revision. An update whose classified changes, each change's id, level and operation, equal those of the change set's last update SHALL add no packet revision, no system message and no notice to any request of the change set. These revisions follow a signed report from the provider's CI, not an agent's decision, so they SHALL be system actions rather than commitments, also while the request is claimed: they SHALL take effect at once, with no proposal and no confirmation, as the requests capability defines for system actions, and SHALL be recorded, like the system message, with the actor kind `system` and the surface `github`. A pending proposal to change the packet of such a request SHALL then be cancelled as stale, as the requests capability defines, because the current revision has moved past its base revision.

Source: D28 #74; D30 (3), (4); D55 (64); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A rerun that changes nothing adds nothing

- **WHEN** `FE-142` is claimed with its packet at revision 1, and the same workflow run for PR #310 is re-run and reports the same two changes
- **THEN** `FE-142` stays at revision 1
- **AND** its thread gets no new message

### Requirement: Requests are withdrawn when the breaking changes disappear

When a later update for a change set no longer contains any change that opens requests under these rules, Tiehall SHALL withdraw each request for it that is unclaimed, and SHALL add a notice to each claimed request without changing that request's state. These withdrawals follow a signed report from the provider's CI, not an agent's decision, so they SHALL be system withdrawals, as the requests capability defines: they SHALL need no proposal and no confirmation, and SHALL never touch a claimed request. When a later update for the change set again holds changes that open requests, Tiehall SHALL open a new request for each team whose request it withdrew this way; the withdrawn request SHALL stay withdrawn.

Source: D23; D55 (68); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A fix on the provider PR withdraws unclaimed requests only

- **WHEN** `FE-142` is open and unclaimed, `MOBILE-17` is claimed, and a new push to PR #310 reports no ERR-level change while the WARN switch of `payments-api` is off
- **THEN** `FE-142` moves to `withdrawn` with no proposal and no confirmation
- **AND** `MOBILE-17` stays claimed and gets a notice that the breaking changes are gone

#### Scenario: Breaking changes that come back open a new request

- **WHEN** `FE-142` was withdrawn when a push to PR #310 removed its breaking changes, and a later push to PR #310 brings an ERR-level change back
- **THEN** FE gets a new request for the change set
- **AND** `FE-142` stays `withdrawn`

### Requirement: Requests are withdrawn when the provider PR closes unmerged

When Tiehall learns that a provider PR closed without merging, through the GitHub App's events or polling as the tracker-mirrors capability defines, it SHALL withdraw each request for the PR's change sets that is unclaimed, as a system withdrawal that needs no proposal and no confirmation. It SHALL NOT change the state of any claimed request, and SHALL add to each claimed request a notice that the provider PR closed without merging. A request in a terminal state SHALL only get that notice. When the provider PR is reopened, the first of its later reports whose changes open requests SHALL open, under the routing rules of this capability, a new request for each consuming team whose request was withdrawn when the PR closed; requests that stayed claimed SHALL be updated by that report as usual. Tiehall learns of closes and merges only for provider PRs in repositories that a connected installation covers, as the tracker-mirrors capability defines.

Source: D23; D28 #74; D55 (72); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A reopened PR whose next report has no breaking change

- **WHEN** PR #310 closed without merging, which withdrew `FE-142`, PR #310 is reopened, the first report after that has no ERR-level change, and a later report has two
- **THEN** FE gets a new request from the later report
- **AND** `FE-142` stays `withdrawn`

### Requirement: Merging the provider PR marks the change shipped

When Tiehall learns that the provider PR merged, through the GitHub App's events or polling as the tracker-mirrors capability defines, it SHALL mark the provider change as shipped on every request for its change sets and update those requests' tracker mirrors. The merge SHALL NOT move those requests to done; each consumer closes its own request with its own PR. The packet SHALL keep the provider status that the last report gave, and the request SHALL show the provider change as shipped from the merge on. Each request of the change set that is not in a terminal state SHALL get one system message, in Tiehall's words, that the provider PR merged and the change shipped, recorded with the actor kind `system` and the surface `github`.

Source: D14; D55 (71); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The provider merges first

- **WHEN** PR #310 merges while `FE-142` is `in_progress`
- **THEN** `FE-142` shows the provider change as shipped
- **AND** `FE-142` stays `in_progress` until FE's own PR closes it

#### Scenario: The merge reaches the tracker mirror

- **WHEN** PR #310 merges while `FE-142` has a mirror issue
- **THEN** Tiehall updates the mirror issue of `FE-142` after the merge

#### Scenario: The merge adds a system message, not a revision

- **WHEN** PR #310 merges while `FE-142` is `in_progress` with its packet at revision 2
- **THEN** the thread of `FE-142` gets one system message that PR #310 merged and the change shipped
- **AND** its packet stays at revision 2

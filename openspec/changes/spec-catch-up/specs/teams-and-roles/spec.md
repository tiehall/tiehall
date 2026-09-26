# Spec Delta: teams-and-roles

## Purpose

Brings the teams-and-roles capability up to what the code does: the org exists unnamed from the first start and records when setup completed, every member sees the members list, and a team name is bounded.

## MODIFIED Requirements

### Requirement: One org per install

An install SHALL hold exactly one org. It stands for the company that runs the install and takes the name given on the setup screen, as the self-host-install capability defines. The org SHALL exist from the install's first start, before anyone has named it: its name SHALL be empty until the setup screen names it, and it SHALL record the time at which the first admin's sign-in completed setup, which is empty until then. An install whose org records no completion time is one whose setup is not complete, and it answers as the self-host-install capability defines for that state. Every membership, team, request, message, packet revision, event and setting SHALL belong to that org. No surface SHALL offer an operation that creates, lists, picks or switches orgs, and the org SHALL have no slug: URLs on the install carry no org part, as the agent-surfaces capability defines for request URLs. Requests SHALL go only between teams of the install; requests between companies are not part of v1.

Source: D25; D33; D45 (5); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S1; design.md, Self-hosting decisions: S15; design.md, Decisions: D45 (5)

#### Scenario: Everything belongs to the install's org

- **WHEN** Dana, a member of the install, opens a request from team BE to team FE
- **THEN** the request belongs to the install's one org
- **AND** its messages, packet revisions and events belong to that org too

#### Scenario: No operation manages orgs

- **WHEN** a reader goes through the install's OpenAPI document, its MCP tool list, the `tiehall` CLI's commands and the pages of its web UI
- **THEN** none of them creates, lists, picks or switches an org

#### Scenario: No org part in a request URL

- **WHEN** Tiehall returns the URL of request FE-142 on the install at `https://tiehall.example.com`
- **THEN** the URL is `https://tiehall.example.com/FE-142`

#### Scenario: The org exists unnamed before setup

- **WHEN** the app starts for the first time on a fresh database, and starts once more before anyone has opened the setup screen
- **THEN** the install holds one org, with no name and no time of completed setup
- **AND** the second start adds no org

### Requirement: What admins and members may do

Only admins SHALL be able to:
- create and revoke invites, change members' roles and remove members;
- create teams, change a team's name or key, add people to teams and remove them from teams, and set a team's intake notes and required fields, as the agent-surfaces capability defines;
- set the sign-in policy, as the sign-in capability defines;
- connect and configure integrations: GitHub installations and the GitHub App's private key, as the self-host-install and tracker-mirrors capabilities define, and the Jira connection and team mappings, as the tracker-mirrors capability defines;
- register and unregister APIs, as the contract-changes capability defines;
- turn personal access tokens on or off, set the longest lifetime a personal access token may have, and set the daily write budget, as the agent-access and agent-safety capabilities define;
- set and clear a user's bot flag;
- confirm a contract-change fan-out to more than 10 consumer teams, as the agent-safety capability defines;
- view and export the activity log, as the activity-log capability defines.

These actions SHALL run only in the web UI, on no agent surface, as the agent-safety capability defines. A request for any of them for a user whose role is `member` SHALL be refused with 403, as the public-api capability's error model defines for a role that does not allow the action, and SHALL change nothing. Every member, whatever their role, SHALL be able to see the install's members list in the web UI: each member with their GitHub login, their role, the keys of the teams they belong to and whether they carry the bot flag, ordered by login. The list is offered on no agent surface. Declaring the APIs a team consumes, and re-confirming those declarations, SHALL be done by members of that team, whatever their role, as the contract-changes capability defines. The admin role SHALL NOT stand in for a part in a request: what a person may do on a request because they belong to its target team or its requesting team, or because they claim it, as the requests capability defines, SHALL depend on that membership or part and not on the role.

Source: D28 #3, #4, #26, #52, #94; D45 (3); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S6; design.md, Self-hosting decisions: S7; design.md, Decisions: D45 (3)

#### Scenario: A member cannot create a team

- **WHEN** Dana, whose role is `member`, submits the web UI's form that creates a team with the key `MOB`
- **THEN** the request is refused with 403
- **AND** no team is created

#### Scenario: A member cannot register an API

- **WHEN** Dana, whose role is `member`, submits the web UI's form that registers `payments-api` for team PAY
- **THEN** the request is refused with 403
- **AND** `payments-api` is not registered

#### Scenario: A team member declares a consumed API

- **WHEN** Ayşe, whose role is `member` and who belongs to team FE, declares that FE consumes `payments-api`
- **THEN** the declaration is recorded with Ayşe as its declarer

#### Scenario: The admin role does not make someone part of a team

- **WHEN** Ada, an admin who belongs only to team OPS, tries to claim FE-142, whose target team is FE
- **THEN** the claim is refused with 403
- **AND** FE-142 stays unclaimed

#### Scenario: Every member sees the members list

- **WHEN** Dana, whose role is `member`, opens the members list in the web UI
- **THEN** the list shows every member of the install, ordered by GitHub login
- **AND** the user of the GitHub account `acme-ci-bot` appears with the role `member`, the team key `OPS` and the bot flag, as Ada, an admin, also sees it

### Requirement: Teams

The install SHALL contain teams, kept in Tiehall's own records. Which people belong to a team SHALL be managed in Tiehall by admins, and SHALL NOT be taken from GitHub teams or any other outside source. A user SHALL be able to belong to several teams, and a team SHALL be allowed to have no members. Besides its key, as the requirement on team keys defines, a team SHALL have a name of 1 to 100 characters, after leading and trailing blanks are removed; a name outside these bounds SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema, and SHALL create or change no team. Which team a request comes from, when its requester belongs to several teams, is defined by the requests capability.

Source: D28 #11; D45 (2); design.md, Decisions this change rests on; design.md, Design rules: Teams and roles; design.md, Decisions: D45 (2)

#### Scenario: A member of two teams

- **WHEN** Ada, an admin, adds Dana to team FE while Dana already belongs to team BE
- **THEN** Dana belongs to both FE and BE

#### Scenario: An empty team

- **WHEN** Ada creates a team with the key `MOB` and adds nobody to it
- **THEN** team MOB exists with no members
- **AND** requests can be addressed to MOB

#### Scenario: GitHub teams do not change Tiehall teams

- **WHEN** Dana is added to the GitHub team `frontend` in the GitHub organization `acme`, whose installation is connected
- **THEN** the teams Dana belongs to in Tiehall are unchanged

#### Scenario: A team name outside its bounds

- **WHEN** Ada submits the web UI's form that creates a team with the key `MOB` and a name of 101 characters, or a name of blanks only
- **THEN** the request is refused with 400
- **AND** no team is created

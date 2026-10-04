# Spec Delta: teams-and-roles

## Purpose

States what a removed member's MCP connection still answers, and that changes to who belongs to a team are security events. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Membership is re-checked on every call

Every call made for a user SHALL re-check, at the time of the call, that the user is still a member of the install, whatever session or token it carries, so that a removal takes effect on the removed member's next call. A call made for a removed member, such as one that carries an access token or a personal access token issued to them before the removal, SHALL be refused with 403, as the public-api capability's error model defines for a removed member, and SHALL return no data of the install. On `/mcp`, a removed member's `initialize` and `tools/list` SHALL still answer, because they return nothing of the install's data, and every tool call SHALL return the removed member's tool error. The per-call re-check of the personal-access-token switch is defined by the agent-access capability; ending a removed member's web sessions, and removal through leaving the GitHub organization, by the sign-in capability; and what happens to a removed member's claims and pending proposals, by the requests capability.

Source: D28 #1, #10; D55 (32); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A removed member's agent still holds a valid access token

- **WHEN** Ada, an admin, removes Dana while Dana's agent holds an OAuth access token that has not expired
- **THEN** the agent's next call to `/api/v1` is refused with 403
- **AND** it returns no data of the install

#### Scenario: A removed member's personal access token

- **WHEN** Dana has been removed from the install and their script calls `/api/v1` with a personal access token that has not expired
- **THEN** the call is refused with 403
- **AND** it returns no data of the install

#### Scenario: A removed member's agent over MCP

- **WHEN** Dana has been removed from the install and their agent calls `get_request` over MCP with a token that has not expired
- **THEN** the tool call returns a tool error
- **AND** it returns no data of the install

#### Scenario: A removed member's MCP connection still lists tools

- **WHEN** Dana has been removed from the install, and their MCP client, with a token that has not expired, sends `initialize`, then `tools/list`, then a call of `list_inbox`
- **THEN** `initialize` and `tools/list` answer as for a member
- **AND** the call of `list_inbox` returns a tool error that names the problem type of a removed member, and no data of the install

### Requirement: Teams

The install SHALL contain teams, kept in Tiehall's own records. Which people belong to a team SHALL be managed in Tiehall by admins, and SHALL NOT be taken from GitHub teams or any other outside source. Adding a person to a team and removing one from a team SHALL each be recorded, together with the change, as a security event that names the admin, the person and the team, which the activity log shows to admins only, as the activity-log capability defines for security events; neither SHALL need the confirmation step. A user SHALL be able to belong to several teams, and a team SHALL be allowed to have no members. Besides its key, as the requirement on team keys defines, a team SHALL have a name of 1 to 100 characters, after leading and trailing blanks are removed; a name outside these bounds SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema, and SHALL create or change no team. Which team a request comes from, when its requester belongs to several teams, is defined by the requests capability.

Source: D28 #11; D45 (2); D55 (82); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A team membership change is a security event

- **WHEN** Ada, an admin, adds Lee to team FE, and later removes Dana from team FE
- **THEN** the activity log holds a security event for the addition that names Ada, Lee and FE
- **AND** one for the removal that names Ada, Dana and FE
- **AND** neither change asked Ada for a confirmation

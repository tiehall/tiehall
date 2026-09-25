# Spec Delta: teams-and-roles

## Purpose

Defines the install's single org, the `admin` and `member` roles and what each may do, how people are invited to the install and removed from it, and the teams, with their keys, that requests are addressed to.

## ADDED Requirements

### Requirement: One org per install

An install SHALL hold exactly one org. It stands for the company that runs the install and takes the name given on the setup screen, as the self-host-install capability defines. Every membership, team, request, message, packet revision, event and setting SHALL belong to that org. No surface SHALL offer an operation that creates, lists, picks or switches orgs, and the org SHALL have no slug: URLs on the install carry no org part, as the agent-surfaces capability defines for request URLs. Requests SHALL go only between teams of the install; requests between companies are not part of v1.

Source: D25; D33; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S1; design.md, Self-hosting decisions: S15

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

### Requirement: Two roles, admin and member

Each member of the install SHALL hold exactly one role, `admin` or `member`, and there SHALL be no other role: an invite or a role change that names any other role, such as `owner`, SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema. The person who completes setup SHALL be the first admin, as the self-host-install capability defines; a person who joins later SHALL join as `member` unless their invite names `admin`, as the sign-in capability defines. The install SHALL always keep at least one admin: a role change or a removal that would leave it without an admin SHALL be refused with 409, as the public-api capability's error model defines for a state conflict, and SHALL change nothing. Roles SHALL be set in Tiehall, by admins in the web UI or by the operator command `admin grant` that the self-host-install capability defines, and SHALL NOT be taken from GitHub: owning a GitHub organization, or holding any other role in GitHub, SHALL NOT make a person an admin.

Source: D28 #4; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S6

#### Scenario: The only admin cannot step down

- **WHEN** Ada is the install's only admin and changes their own role to `member`, confirming the change in the web UI
- **THEN** the change is refused with 409
- **AND** Ada's role stays `admin`

#### Scenario: The only admin cannot be removed

- **WHEN** Ada is the install's only admin and removes themselves from the install, confirming the removal in the web UI
- **THEN** the removal is refused with 409
- **AND** Ada stays a member with the role `admin`

#### Scenario: A second admin lets the first step down

- **WHEN** Ada and Omar are both admins, and Ada changes their own role to `member`, confirming the change in the web UI
- **THEN** Ada's role becomes `member`
- **AND** Omar's role stays `admin`

#### Scenario: A GitHub organization owner is not made an admin

- **WHEN** Kim, an owner of the GitHub organization `acme`, whose installation is connected, signs in to the install for the first time without an invite
- **THEN** Kim's role is `member`

#### Scenario: There is no owner role

- **WHEN** Ada, an admin, asks to change Dana's role to `owner`
- **THEN** the change is refused with 400
- **AND** Dana's role is unchanged

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

These actions SHALL run only in the web UI, on no agent surface, as the agent-safety capability defines. A request for any of them for a user whose role is `member` SHALL be refused with 403, as the public-api capability's error model defines for a role that does not allow the action, and SHALL change nothing. Declaring the APIs a team consumes, and re-confirming those declarations, SHALL be done by members of that team, whatever their role, as the contract-changes capability defines. The admin role SHALL NOT stand in for a part in a request: what a person may do on a request because they belong to its target team or its requesting team, or because they claim it, as the requests capability defines, SHALL depend on that membership or part and not on the role.

Source: D28 #3, #4, #26, #52, #94; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S6; design.md, Self-hosting decisions: S7

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

### Requirement: The role bounds every caller acting for a user

Everything done for a user, through a web session or through a token, SHALL be authorized within that user's role. An operation that the user's role does not allow SHALL be refused with 403, as the public-api capability's error model defines for a role that does not allow the action, and SHALL change nothing. How a token's scopes combine with the role is defined by the agent-access capability.

Source: design.md, Design rules: Teams and roles

#### Scenario: A member tries an admin action in the web UI

- **WHEN** Dana, whose role is `member`, submits the web UI's form that turns personal access tokens off
- **THEN** the request is refused with 403
- **AND** personal access tokens stay on

### Requirement: Membership is re-checked on every call

Every call made for a user SHALL re-check, at the time of the call, that the user is still a member of the install, whatever session or token it carries, so that a removal takes effect on the removed member's next call. A call made for a removed member, such as one that carries an access token or a personal access token issued to them before the removal, SHALL be refused with 403, as the public-api capability's error model defines for a removed member, and SHALL return no data of the install. The per-call re-check of the personal-access-token switch is defined by the agent-access capability; ending a removed member's web sessions, and removal through leaving the GitHub organization, by the sign-in capability; and what happens to a removed member's claims and pending proposals, by the requests capability.

Source: D28 #1, #10; design.md, Decisions this change rests on; design.md, Design rules: Teams and roles

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

### Requirement: Invites by GitHub username

An admin SHALL be able to invite a person by their GitHub username. When the invite is created, Tiehall SHALL resolve the username to the GitHub account's numeric id and bind the invite to that account, so the invite stays with that account when its login is renamed and never passes to someone who later takes the old login. A username that names no GitHub account SHALL be refused with 404, as the public-api capability's error model defines for a record that does not exist, and SHALL create no invite. An invite SHALL name a role, which SHALL be `member` unless the invite names `admin`, and SHALL expire 7 days after it is created. Creating an invite SHALL need the confirmation step, as the agent-safety capability defines. An invite SHALL need no email and SHALL work whether or not SMTP is set up: the invitee accepts it by signing in to the install with the bound GitHub account while the invite is valid, which SHALL make them a member with the invite's role, as the sign-in capability defines. A sign-in with any other GitHub account, or after the invite has expired or been revoked, SHALL add no membership through that invite; whether such a person may sign in at all is defined by the sign-in capability. An invite for an account that an admin removed from the install is how that person is admitted again, as the sign-in capability defines. Each invite SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #1, #5; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S10; design.md, Self-hosting decisions: S14

#### Scenario: Joining with an invite

- **WHEN** Ada, an admin, invites the GitHub username `lee-dev` without naming a role, and Lee signs in with that GitHub account 2 days later
- **THEN** Lee becomes a member of the install with the role `member`

#### Scenario: An invite that names the admin role

- **WHEN** Ada invites the GitHub username `lee-dev` with the role `admin`, and Lee signs in with that account 2 days later
- **THEN** Lee becomes a member of the install with the role `admin`

#### Scenario: The invite follows a login rename

- **WHEN** Ada invites the GitHub username `lee-dev`, Lee renames their GitHub login to `lee-k` the next day, and Lee signs in as `lee-k` 3 days after the invite was created
- **THEN** Lee becomes a member of the install through the invite

#### Scenario: A new holder of the old login gains nothing

- **WHEN** Ada invited the GitHub username `lee-dev`, Lee then renamed their login to `lee-k`, and Kim creates a new GitHub account with the login `lee-dev` and signs in with it
- **THEN** Kim gains no membership through Lee's invite
- **AND** the invite stays valid for Lee's account until it expires

#### Scenario: An expired invite

- **WHEN** Ada invited the GitHub username `lee-dev`, and Lee signs in with that account 8 days later
- **THEN** Lee gains no membership through the invite

#### Scenario: A username that names no account

- **WHEN** Ada asks to invite the GitHub username `no-such-user-9f2`, which names no GitHub account, and confirms the invite in the web UI
- **THEN** the request is refused with 404 and an RFC 9457 problem
- **AND** no invite is created

#### Scenario: An invite without email

- **WHEN** the install has no SMTP settings and Ada invites the GitHub username `lee-dev`
- **THEN** the invite is created and no email is sent
- **AND** Lee becomes a member by signing in with that account within 7 days

#### Scenario: An invite without the confirmation step

- **WHEN** Ada asks to invite the GitHub username `lee-dev` without confirming the invite in the web UI
- **THEN** the request is refused with 403
- **AND** no invite is created

### Requirement: Revoking an invite

An admin SHALL be able to revoke a pending invite in the web UI. A revoked invite SHALL admit no one. Revoking SHALL NOT need the confirmation step, because it only narrows who may join, and SHALL be recorded as a security event, as the activity-log capability defines. A request by a user whose role is `member` to revoke an invite SHALL be refused with 403 and SHALL change nothing.

Source: D28 #4, #5; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S6; design.md, Self-hosting decisions: S14

#### Scenario: A revoked invite admits no one

- **WHEN** Ada invited the GitHub username `lee-dev`, revokes the invite the next day, and Lee, who is a member of no organization with a connected installation, then signs in with that account
- **THEN** the sign-in is refused with HTTP 403
- **AND** the activity log holds a security event for the revocation

#### Scenario: A member cannot revoke an invite

- **WHEN** Dana, whose role is `member`, submits the web UI's form that revokes the invite for `lee-dev`
- **THEN** the request is refused with 403
- **AND** the invite stays valid

### Requirement: Changing a member's role

An admin SHALL be able to change a member's role between `member` and `admin`, in the web UI and with the confirmation step for that exact change, as the agent-safety capability defines. A role change without a valid confirmation for it SHALL be refused with 403, as the public-api capability's error model defines for a missing or invalid confirmation, and SHALL change nothing. A new role SHALL apply from the member's next call, through every session and token that acts for them. Each role change SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #4; design.md, Decisions this change rests on; design.md, Design rules: Teams and roles; design.md, Self-hosting decisions: S6; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: A confirmed role change

- **WHEN** Ada, an admin, changes Dana's role from `member` to `admin` and confirms the change in the web UI
- **THEN** Dana's role becomes `admin`
- **AND** the activity log gains a security event for the change

#### Scenario: A confirmation for another change does not apply

- **WHEN** Ada confirmed, on the review page, the change of Dana's role to `admin`, and the request that carries that confirmation asks to change Kim's role instead
- **THEN** the request is refused with 403
- **AND** Kim's role and Dana's role are unchanged

#### Scenario: A lowered role applies at once

- **WHEN** Ada changes Omar's role from `admin` to `member` with the confirmation step, and Omar then submits the web UI's form that creates a team, in a session opened before the change
- **THEN** the request is refused with 403
- **AND** no team is created

### Requirement: Removing a member

An admin SHALL be able to remove a member from the install, in the web UI and with the confirmation step for that removal, as the agent-safety capability defines; a removal without a valid confirmation SHALL be refused with 403, as the public-api capability's error model defines for a missing or invalid confirmation, and SHALL change nothing. An admin MAY remove themselves while another admin remains. A removed person SHALL no longer be a member of the install or of any of its teams, and their access SHALL end as the requirement on membership re-checks defines. A removal, whether by an admin or by leaving the GitHub organization as the sign-in capability defines, SHALL end the person's web sessions and SHALL revoke every agent-client grant and personal access token they hold, so that none of them works again: while the person is not a member, a call with one of them SHALL be refused with 403, as for a removed member, and after the person has been admitted again it SHALL be refused as a revoked token. An admin removal SHALL also block the person from rejoining through organization membership, as the sign-in capability defines. A person admitted again SHALL start with the role their way in gives them, in no team. The requests, messages and events they took part in SHALL stay, with the provenance that names them unchanged, as the requests capability defines. Each removal SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #4, #10; design.md, Decisions this change rests on; design.md, Design rules: Teams and roles; design.md, Design rules: Requests and events; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S6; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: A confirmed removal

- **WHEN** Ada, an admin, removes Dana, a member of teams FE and BE, and confirms the removal in the web UI
- **THEN** Dana is no longer a member of the install
- **AND** Dana is listed as a member of neither FE nor BE
- **AND** the activity log gains a security event for the removal

#### Scenario: A removed member's messages stay

- **WHEN** Dana wrote a message on FE-142 and is then removed from the install
- **THEN** FE-142's thread still holds that message, with Dana named as its author

#### Scenario: A removal revokes grants and tokens

- **WHEN** Dana has approved an MCP client and holds a personal access token, and Ada removes Dana with the confirmation step
- **THEN** a call with Dana's personal access token is refused with 403
- **AND** the MCP client's refresh token is refused with the OAuth error `invalid_grant`
- **AND** if an admin later invites Dana again and Dana rejoins, that personal access token is refused with HTTP 401 and Dana belongs to no team

#### Scenario: A removal without the confirmation step

- **WHEN** Ada asks to remove Dana without confirming the removal in the web UI
- **THEN** the request is refused with 403
- **AND** Dana stays a member of the install

#### Scenario: An admin removes themselves while another admin remains

- **WHEN** Ada and Omar are both admins, and Ada removes themselves from the install with the confirmation step
- **THEN** Ada is no longer a member of the install
- **AND** Omar stays an admin

### Requirement: Teams

The install SHALL contain teams, kept in Tiehall's own records. Which people belong to a team SHALL be managed in Tiehall by admins, and SHALL NOT be taken from GitHub teams or any other outside source. A user SHALL be able to belong to several teams, and a team SHALL be allowed to have no members. Which team a request comes from, when its requester belongs to several teams, is defined by the requests capability.

Source: D28 #11; design.md, Decisions this change rests on; design.md, Design rules: Teams and roles

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

### Requirement: Team keys

Each team SHALL have a key of 2 to 10 characters, made of the uppercase letters `A`–`Z` and the digits `0`–`9`, that starts with a letter, such as `FE` or `PAY2`. A key in any other form SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema. Every key SHALL be unique in the install: a key already used by another team SHALL be refused with 409, as the public-api capability's error model defines for a state conflict, and SHALL change nothing. When a team's key is renamed, the old key SHALL stay an alias of that team and SHALL count as in use by it, so no other team can take it; how request keys and URLs that use the old key keep resolving is defined by the requests capability. Because every app path is lowercase, a team key SHALL never shadow an app path.

Source: design.md, Design rules: Teams and roles; design.md, Self-hosting decisions: S15

#### Scenario: Keys in the allowed form

- **WHEN** Ada, an admin, creates teams with the keys `FE`, `PAY2` and `PLATFORM10`
- **THEN** all three teams are created

#### Scenario: Keys in another form

- **WHEN** Ada tries to create a team with the key `fe`, `F`, `2FA`, `PLATFORM100` or `FE-X`
- **THEN** each attempt is refused with 400
- **AND** no team is created

#### Scenario: A duplicate key

- **WHEN** a team with the key `FE` exists and Ada gives another team the key `FE`
- **THEN** the change is refused with 409
- **AND** the other team keeps its previous key

#### Scenario: A renamed team's old key stays taken

- **WHEN** team FE's key was renamed to `WEB`, so `FE` stays an alias of WEB, and Ada creates a new team with the key `FE`
- **THEN** the key is refused with 409
- **AND** FE-142 still resolves to the request of team WEB

#### Scenario: A key that spells an app path

- **WHEN** Ada creates a team with the key `MCP`
- **THEN** the team is created
- **AND** `https://tiehall.example.com/mcp` is still the MCP endpoint
- **AND** `https://tiehall.example.com/MCP` is team MCP's intake page, as the agent-surfaces capability defines

### Requirement: Bot users

An admin SHALL be able to set and clear a bot flag on a user of the install, in the web UI. A user with the bot flag SHALL stay an identity of kind `human` that carries the flag, SHALL hold a role and team memberships like any other user, and SHALL be able to hold personal access tokens as the agent-access capability defines. Because v1 counts no seats, the flag's only effect SHALL be that it is shown: the web UI SHALL mark the user as a bot wherever it lists or names them, and `whoami` SHALL say that its user is a bot. A request by a user whose role is `member` to set or clear the flag SHALL be refused with 403, as the public-api capability's error model defines for a role that does not allow the action, and SHALL change nothing.

Source: D28 #94; design.md, Decisions this change rests on

#### Scenario: An admin marks a bot user

- **WHEN** Ada, an admin, sets the bot flag on the user of the GitHub account `acme-ci-bot`
- **THEN** that user carries the bot flag
- **AND** its identity kind is still `human`
- **AND** the web UI's member list marks the user as a bot, and `whoami` called with the user's personal access token says it is a bot

#### Scenario: An admin clears the flag

- **WHEN** Ada clears the bot flag on the user of `acme-ci-bot`
- **THEN** that user no longer carries the bot flag
- **AND** its role, teams and personal access tokens are unchanged

#### Scenario: A member cannot set the flag

- **WHEN** Dana, whose role is `member`, submits the web UI's form that sets the bot flag on their own user
- **THEN** the request is refused with 403
- **AND** Dana's user carries no bot flag

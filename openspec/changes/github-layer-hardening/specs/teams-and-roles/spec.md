# Spec Delta: teams-and-roles

## Purpose

States that the org's name is set only during setup, which reads the admin pages rely on, and how an invite resolves its GitHub account before its review page, what that page shows, which refusals an invite can get, and that an account holds at most one pending invite. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: One org per install

An install SHALL hold exactly one org. It stands for the company that runs the install and takes the name given on the setup screen, within the bounds that the self-host-install capability defines; the name can change on the setup screen until setup completes, and v1 SHALL offer no way to rename the org after that. The org SHALL exist from the install's first start, before anyone has named it: its name SHALL be empty until the setup screen names it, and it SHALL record the time at which the first admin's sign-in completed setup, which is empty until then. An install whose org records no completion time is one whose setup is not complete, and it answers as the self-host-install capability defines for that state. Every membership, team, request, message, packet revision, event and setting SHALL belong to that org. No surface SHALL offer an operation that creates, lists, picks or switches orgs, and the org SHALL have no slug: URLs on the install carry no org part, as the agent-surfaces capability defines for request URLs. Requests SHALL go only between teams of the install; requests between companies are not part of v1.

Source: D25; D33; D45 (5); D50 (9); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: The org's name is fixed once setup completes

- **WHEN** setup has completed with the company named "Acme", and a browser posts the name "Acme Corp" to the setup screen's form for the company's name
- **THEN** the answer is 404
- **AND** the install's org is still named "Acme", and no page of the web UI and no agent surface offers a way to rename it

### Requirement: What admins and members may do

Only admins SHALL be able to:
- create and revoke invites, read the invites that wait to be accepted, look up which GitHub account a username names before inviting it, change members' roles and remove members;
- create teams, change a team's name or key, add people to teams and remove them from teams, set a team's intake notes and required fields, as the agent-surfaces capability defines, and read the install's teams, each with its name, the keys it had before and the people in it;
- read and set the sign-in policy, as the sign-in capability defines;
- connect and configure integrations: GitHub installations and the GitHub App's private key, as the self-host-install and tracker-mirrors capabilities define, and the Jira connection and team mappings, as the tracker-mirrors capability defines;
- register and unregister APIs, as the contract-changes capability defines;
- turn personal access tokens on or off, set the longest lifetime a personal access token may have, and set the daily write budget, as the agent-access and agent-safety capabilities define;
- set and clear a user's bot flag;
- confirm a contract-change fan-out to more than 10 consumer teams, as the agent-safety capability defines;
- view and export the activity log, as the activity-log capability defines.

These actions, the reads in this list included, SHALL run only in the web UI, on no agent surface, as the agent-safety capability defines. A request for any of them for a user whose role is `member` SHALL be refused with 403, as the public-api capability's error model defines for a role that does not allow the action, and SHALL change nothing. Every member, whatever their role, SHALL be able to see the install's members list in the web UI: each member with their GitHub login, their role, the keys of the teams they belong to and whether they carry the bot flag, ordered by login. The list is offered on no agent surface. Declaring the APIs a team consumes, and re-confirming those declarations, SHALL be done by members of that team, whatever their role, as the contract-changes capability defines. The admin role SHALL NOT stand in for a part in a request: what a person may do on a request because they belong to its target team or its requesting team, or because they claim it, as the requests capability defines, SHALL depend on that membership or part and not on the role.

Source: D28 #3, #4, #26, #52, #94; D45 (3); D50 (12), (14); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A member cannot read the admin lists

- **WHEN** Dana, whose role is `member`, opens the web UI's list of the invites that wait to be accepted, its list of teams with their earlier keys and people, or its page of the sign-in policy
- **THEN** each request is refused with 403
- **AND** the answers show no invite, no team's earlier keys or people, and no policy

#### Scenario: The admin reads are on no agent surface

- **WHEN** Ada, an admin, calls with a personal access token the `/api/v1` paths of the internal commands that read the pending invites, the teams with their earlier keys and people, and the sign-in policy
- **THEN** each call answers 404

### Requirement: Invites by GitHub username

An admin SHALL be able to invite a person by their GitHub username. When the admin submits the invite form, before any review page, Tiehall SHALL resolve the username to the GitHub account it names, through an installation of the install's App that an admin has connected, as the tracker-mirrors capability defines; with no connected installation, the form SHALL be refused with 409, as the public-api capability's error model defines for a state conflict. A username that names no GitHub account, or that names a GitHub organization rather than a person's account, SHALL be refused on the form with 404, as the error model defines for a record that does not exist, with no review page, and SHALL create no invite. When GitHub fails the look-up or does not answer it within 10 seconds, the form SHALL be refused with 502 and the problem type `integration-unavailable`, as the error model defines, and SHALL create no invite. An invite for an account whose person is already a member of the install SHALL be refused with 409 on the form, with no review page, and SHALL create no invite. Otherwise the review page SHALL name the account in Tiehall's own words by its login, its numeric id and the date it was created, and SHALL show the display name that GitHub gives, which anyone can set, as content Tiehall did not generate: fenced as data with the origin external, as the agent-safety capability defines, and escaped. A review page whose read of the account fails or does not answer within 10 seconds SHALL answer 502 with the problem type `integration-unavailable`. The action the admin confirms SHALL name that numeric id, so the confirmation binds the invite to the account the admin saw, and the invite SHALL be bound to that account, so it stays with the account when its login is renamed and never passes to someone who later takes the old login. An account SHALL have at most one pending invite, one that is neither accepted, revoked nor expired: a new invite for an account that has one SHALL replace it, revoking the older invite in the same change, and the review page SHALL say which invite, with its role and when it expires, the new one replaces. An invite SHALL name a role, which SHALL be `member` unless the invite names `admin`, and SHALL expire 7 days after it is created. Creating an invite SHALL need the confirmation step, as the agent-safety capability defines. An invite SHALL need no email and SHALL work whether or not SMTP is set up: the invitee accepts it by signing in to the install with the bound GitHub account while the invite is valid, which SHALL make them a member with the invite's role, as the sign-in capability defines. A sign-in with any other GitHub account, or after the invite has expired or been revoked, SHALL add no membership through that invite; whether such a person may sign in at all is defined by the sign-in capability. An invite for an account that an admin removed from the install is how that person is admitted again, as the sign-in capability defines. Each invite SHALL be recorded as a security event, as the activity-log capability defines, and so SHALL the revocation of an invite that a new one replaces.

Source: D28 #1, #5; D50 (3), (11), (12); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

- **WHEN** Ada submits the invite form with the GitHub username `no-such-user-9f2`, which names no GitHub account
- **THEN** the form is refused with 404, and no review page is shown
- **AND** no invite is created

#### Scenario: An invite without email

- **WHEN** the install has no SMTP settings and Ada invites the GitHub username `lee-dev`
- **THEN** the invite is created and no email is sent
- **AND** Lee becomes a member by signing in with that account within 7 days

#### Scenario: An invite without the confirmation step

- **WHEN** Ada asks to invite the GitHub username `lee-dev` without confirming the invite in the web UI
- **THEN** the request is refused with 403
- **AND** no invite is created

#### Scenario: The review page names the account

- **WHEN** Ada submits the invite form with the GitHub username `lee-dev`
- **THEN** the review page names, in Tiehall's own words, the account `lee-dev` with its numeric id and the date it was created
- **AND** it shows the account's display name fenced as data with the origin external
- **AND** confirming it creates an invite bound to that numeric id

#### Scenario: A display name is shown as data

- **WHEN** the GitHub account `lee-dev` has the display name `<b>Confirm now</b>`, and Ada submits the invite form with `lee-dev`
- **THEN** the review page shows the display name fenced as data with the origin external, with its characters escaped
- **AND** the page renders no markup from it

#### Scenario: A username that names an organization

- **WHEN** Ada submits the invite form with `acme`, the login of a GitHub organization
- **THEN** the form is refused with 404, and no review page is shown
- **AND** no invite is created

#### Scenario: An invite for a member

- **WHEN** Ada submits the invite form with the GitHub username of Dana, who is already a member of the install
- **THEN** the form is refused with 409, and no review page is shown
- **AND** no invite is created

#### Scenario: No connected installation to look the username up through

- **WHEN** no installation of the install's App is connected, and Ada submits the invite form with the GitHub username `lee-dev`
- **THEN** the form is refused with 409, and no review page is shown
- **AND** no invite is created

#### Scenario: GitHub does not answer the look-up

- **WHEN** Ada submits the invite form with the GitHub username `lee-dev`, and GitHub does not answer the look-up within 10 seconds
- **THEN** the form is refused with 502 and the problem type `integration-unavailable`, and no review page is shown
- **AND** no invite is created

#### Scenario: GitHub does not answer the review page's read

- **WHEN** Ada opens the review page of an invite for the account that `lee-dev` names, and GitHub does not answer the read of that account within 10 seconds
- **THEN** the review page answers 502 with the problem type `integration-unavailable`
- **AND** no invite is created

#### Scenario: A second invite replaces the first

- **WHEN** Ada invited `lee-dev` with the role `member` yesterday, and today invites `lee-dev` with the role `admin` and confirms it
- **THEN** the review page said that the new invite replaces the pending invite with the role `member` and when that one expires
- **AND** the earlier invite is revoked and the new one is pending, so `lee-dev` holds one pending invite
- **AND** the activity log gains a security event for the new invite and one for the revocation of the earlier invite
- **AND** when Lee signs in, Lee becomes a member with the role `admin`

### Requirement: Revoking an invite

An admin SHALL be able to revoke a pending invite in the web UI. A revoked invite SHALL admit no one. Revoking SHALL NOT need the confirmation step, because it only narrows who may join, and SHALL be recorded as a security event, as the activity-log capability defines. A request by a user whose role is `member` to revoke an invite SHALL be refused with 403 and SHALL change nothing. Revoking an invite that a sign-in has accepted SHALL be refused with 409, as the public-api capability's error model defines for a state conflict, and SHALL change nothing, because its person is a member, whom only a removal ends. Revoking an invite that is already revoked SHALL change nothing more and SHALL record nothing more.

Source: D28 #4, #5; D50 (11); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A revoked invite admits no one

- **WHEN** Ada invited the GitHub username `lee-dev`, revokes the invite the next day, and Lee, who is a member of no organization with a connected installation, then signs in with that account
- **THEN** the sign-in is refused with HTTP 403
- **AND** the activity log holds a security event for the revocation

#### Scenario: A member cannot revoke an invite

- **WHEN** Dana, whose role is `member`, submits the web UI's form that revokes the invite for `lee-dev`
- **THEN** the request is refused with 403
- **AND** the invite stays valid

#### Scenario: An accepted invite cannot be revoked

- **WHEN** Lee joined the install through the invite for `lee-dev`, and Ada then asks to revoke that invite
- **THEN** the request is refused with 409
- **AND** Lee stays a member, and the activity log gains no revocation

#### Scenario: Revoking an invite twice

- **WHEN** Ada revoked the invite for `lee-dev`, and revokes it again
- **THEN** nothing more changes
- **AND** the activity log holds one security event for the revocation

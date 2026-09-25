# Spec Delta: sign-in

## Purpose

Defines how people sign in to a Tiehall install: with GitHub only, through the install's own GitHub App, and never with a password or a passkey. It sets who may sign in and the admin's sign-in policy, how one GitHub account maps to one Tiehall user, how leaving the company's GitHub organization ends access, and how web sessions end.

## ADDED Requirements

### Requirement: GitHub is the only way to sign in

Tiehall SHALL let people sign in only with a GitHub account, through the user authorization of the install's own GitHub App, which the self-host-install capability creates during setup. Tiehall MUST NOT offer sign-in with a password, a magic link, an email code, a passkey or any other identity provider, and MUST NOT store passwords. Tiehall SHALL serve no sign-in route other than the GitHub one: a request to any other sign-in route, such as an email-and-password or a passkey sign-in, SHALL answer 404, as the public-api capability's error model defines for a route the install does not serve, and SHALL create no session. An Atlassian account SHALL NOT be a way to sign in; linking one is defined by the tracker-mirrors capability. Before setup is complete, the only sign-in SHALL be the one from the setup session, as the self-host-install capability defines.

Source: D28 #1; D37; design.md, Decisions this change rests on; design.md, Technical decisions: T7; design.md, Technical decisions: T8; design.md, Self-hosting decisions: S5

#### Scenario: The sign-in page offers GitHub only

- **WHEN** a person who is not signed in opens `https://tiehall.example.com` on an install whose setup is complete
- **THEN** they are offered sign-in with GitHub
- **AND** no other way to sign in is offered
- **AND** no page asks them for a password

#### Scenario: No route signs anyone in another way

- **WHEN** the CI route test lists every route of the install's sign-in service
- **THEN** no route accepts an email address and a password, a magic link, an email code or a passkey assertion
- **AND** every sign-in route other than the GitHub one answers 404 and creates no session

#### Scenario: A password sign-in attempt creates no session

- **WHEN** a client sends an email address and a password, or a passkey assertion, to any route of `https://tiehall.example.com` in the form of a sign-in request
- **THEN** no session is created
- **AND** no Tiehall user is created

### Requirement: Tiehall keeps no GitHub user token

Sign-in SHALL use GitHub's user authorization only to learn which GitHub account signed in and that account's primary verified email address. Tiehall MUST NOT keep the GitHub user access token or its refresh token once sign-in has completed, and SHALL make every call to GitHub with the App's installation tokens, never with a user's token.

Source: D37; design.md, Decisions this change rests on; design.md, Technical decisions: T7; design.md, Self-hosting decisions: S4

#### Scenario: No GitHub user token is stored

- **WHEN** Ana completes a sign-in with GitHub
- **THEN** Tiehall's database holds no GitHub user access token and no GitHub refresh token for Ana

#### Scenario: GitHub calls after sign-in use the installation token

- **WHEN** Ana, signed in, links a pull request in a covered repository to FE-142
- **THEN** Tiehall reads the pull request from GitHub with an installation token of the install's App
- **AND** no token that GitHub issued to Ana is used

### Requirement: Who may sign in

A person SHALL be able to sign in only when at least one of these holds for the GitHub account they sign in with:
- GitHub reports, through an installation of the install's App that an admin has connected, as the tracker-mirrors capability defines, that the account is a member of that installation's organization; the sign-in policy admits organization members; and the account is not blocked by an admin removal, as the requirement on admin removals defines;
- it holds a valid invite, as the teams-and-roles capability defines;
- its Tiehall user is already a member of the install;
- it signs in from the setup session while setup completes, which makes it the install's first admin, as the self-host-install capability defines, or, after the operator has reopened setup, it closes the reopened step, which only an account whose user is already an admin may do.

Tiehall SHALL check organization membership through the connected installations at each sign-in. An installation that no admin has connected SHALL admit no one, and an outside collaborator on a repository is not a member of its organization. A membership lookup that fails, or that goes through an installation that is suspended or deleted on GitHub, SHALL admit no one through that organization. Anyone else SHALL be refused with HTTP 403, as the public-api capability's error model defines for a GitHub account that may not sign in, with a message that tells them to ask an admin of the install for an invite; this includes a person whose only way in is an invite that has expired. A refused sign-in SHALL create no session, no Tiehall user and no membership. Every successful sign-in and every refused sign-in SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #1, #5; D37; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S4; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S14

#### Scenario: A member of the connected organization signs in

- **WHEN** an admin has connected the App's installation on the GitHub organization `acme`, and Lee, a member of `acme` who has never used the install, signs in with GitHub
- **THEN** Lee is signed in
- **AND** Lee is a member of the install
- **AND** the activity log gains a security event for the sign-in

#### Scenario: An installation nobody connected admits no one

- **WHEN** the App is also installed on the GitHub organization `acme-labs`, no admin has connected that installation, and Kim, who is a member of `acme-labs` only and holds no invite, signs in with GitHub
- **THEN** the sign-in is refused with HTTP 403
- **AND** the answer tells Kim to ask an admin of the install for an invite
- **AND** no session, Tiehall user or membership is created for Kim
- **AND** the activity log gains a security event for the refused sign-in

#### Scenario: An outside collaborator is refused

- **WHEN** Sam is an outside collaborator on a repository of `acme` but not a member of the `acme` organization, holds no invite, and signs in with GitHub
- **THEN** the sign-in is refused with HTTP 403

#### Scenario: A suspended installation admits no new member

- **WHEN** the connected installation on `acme` is suspended on GitHub, and Lee, a member of `acme` who is not a member of the install and holds no invite, signs in with GitHub
- **THEN** the sign-in is refused with HTTP 403
- **AND** Ana, who joined through `acme` earlier, still signs in, because they are already a member of the install

#### Scenario: An invite admits a person outside the organization

- **WHEN** an admin invited the GitHub username `jo-contracts` 2 days ago, and Jo, who is not a member of any organization with a connected installation, signs in with that GitHub account
- **THEN** Jo is signed in
- **AND** Jo is a member of the install with the invite's role

#### Scenario: An expired invite does not admit

- **WHEN** an admin invited the GitHub username `jo-contracts` 8 days ago, and Jo, who is not a member of any organization with a connected installation, signs in with that account
- **THEN** the sign-in is refused with HTTP 403
- **AND** Jo gains no membership

### Requirement: The sign-in policy

The install SHALL have one sign-in policy with two settings: "organization members and invited people", which a new install starts with, and "invited people only". Under "invited people only", membership of a GitHub organization SHALL NOT admit a person who is not yet a member of the install, while invites and existing memberships still admit. Changing the policy SHALL NOT remove any member. Only an admin SHALL change the policy, only in the web UI and with the confirmation step, as the agent-safety capability defines; no agent surface offers the change. Each change SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #4; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S7; design.md, Self-hosting decisions: S14

#### Scenario: A new install admits organization members

- **WHEN** setup has just completed and no admin has changed the sign-in policy
- **THEN** the policy is "organization members and invited people"

#### Scenario: Invited people only stops new organization members

- **WHEN** an admin has set the policy to "invited people only", and Lee, a member of `acme` who is not a member of the install and holds no invite, signs in with GitHub
- **THEN** the sign-in is refused with HTTP 403
- **AND** the answer tells Lee to ask an admin of the install for an invite

#### Scenario: Existing members keep signing in

- **WHEN** Ana joined through membership of `acme`, and an admin later sets the policy to "invited people only"
- **THEN** Ana is still a member of the install
- **AND** Ana's next sign-in with GitHub succeeds

#### Scenario: A member cannot change the policy

- **WHEN** Dana, whose role is `member`, submits the web UI's form that changes the sign-in policy
- **THEN** the change is refused with HTTP 403
- **AND** the policy is unchanged

#### Scenario: No token can change the policy

- **WHEN** an agent calls the `/api/v1` path of the operation that changes the sign-in policy with a personal access token of Omar, an admin, that carries every scope
- **THEN** the call answers HTTP 404
- **AND** the policy is unchanged

### Requirement: New members join as members

A person admitted through membership of a GitHub organization SHALL join the install with the role `member` and in no team, until an admin changes their role or adds them to teams. A person admitted by an invite SHALL join with the invite's role, as the teams-and-roles capability defines. When a person who holds a valid invite signs in, that sign-in SHALL accept the invite, even when membership of a GitHub organization would also admit them, so they join through the invite. Roles SHALL be set in Tiehall and never taken from GitHub: an owner of a GitHub organization joins as `member` like anyone else. The person who completes setup, by signing in from the setup session, becomes the first admin, as the self-host-install capability defines.

Source: D28 #4, #5, #11; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S6

#### Scenario: A GitHub organization owner joins as a member

- **WHEN** Omar, an owner of the GitHub organization `acme`, signs in to the install for the first time and holds no invite
- **THEN** Omar joins with the role `member`
- **AND** Omar belongs to no team of the install

#### Scenario: An invite's role applies to an organization member

- **WHEN** an admin invited the GitHub username `lee-acme` with the role `admin`, and Lee, who is also a member of `acme`, signs in with that account 3 days later
- **THEN** Lee joins with the role `admin`
- **AND** Lee's later departure from `acme` on GitHub does not end Lee's access, because Lee joined through the invite

### Requirement: One Tiehall user per GitHub account

Tiehall SHALL identify a person by their GitHub account's numeric id, never by the login or an email address. One GitHub account SHALL be one Tiehall user, and a Tiehall user SHALL have exactly one GitHub account; Tiehall SHALL offer no way to link a second GitHub account or any other sign-in identity to a user. When a GitHub account's login is renamed, Tiehall SHALL follow the rename: the renamed account signs in as the same user, with the same membership, role and teams, and Tiehall shows the new login. The GitHub account SHALL also be how Tiehall maps a GitHub user, such as the author of a pull request, to a Tiehall user, as the requests and contract-changes capabilities define.

Source: D37; design.md, Decisions this change rests on; design.md, Technical decisions: T7; design.md, Self-hosting decisions: S5

#### Scenario: A renamed login keeps the user

- **WHEN** Ana signed in as `ana-k`, is an admin and a member of team FE, and then renames their GitHub account to `ana-kaya` and signs in again
- **THEN** they are signed in as the same Tiehall user
- **AND** their role is still `admin` and they are still a member of team FE
- **AND** Tiehall shows the login `ana-kaya`

#### Scenario: A new account that takes an old login is someone else

- **WHEN** Ana has renamed their GitHub account from `ana-k` to `ana-kaya`, and another person creates a GitHub account with the login `ana-k` and signs in with it
- **THEN** that sign-in does not reach Ana's Tiehall user
- **AND** it is admitted or refused as a new person, by the rules of this capability

#### Scenario: A reused work address does not hand over an account

- **WHEN** Dana's GitHub account had the primary verified email `dana@acme.example`, Dana left the company, and a new hire's different GitHub account now has that primary verified email and signs in
- **THEN** the new hire does not reach Dana's Tiehall user, membership, role or teams

#### Scenario: A pull request author is mapped by account id

- **WHEN** a pull request in a covered repository is authored by Ana's GitHub account after its rename to `ana-kaya`
- **THEN** Tiehall maps the author to Ana's Tiehall user

### Requirement: The email address comes from GitHub

The email address Tiehall keeps for a user SHALL be the primary verified email of their GitHub account, read at each sign-in. Tiehall SHALL use it only to send email when SMTP is set up; it SHALL NOT decide who may sign in, whom an invite is for, or which Tiehall user a person is.

Source: design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S10

#### Scenario: A changed primary email is picked up at sign-in

- **WHEN** Ana changes the primary verified email of their GitHub account to `ana@new.example` and then signs in to the install
- **THEN** Tiehall's email address for Ana is `ana@new.example`

#### Scenario: An email address in the company's domain admits no one

- **WHEN** Kim's GitHub account has the primary verified email `kim@acme.example`, Kim is not a member of any organization with a connected installation, and Kim holds no invite
- **THEN** Kim's sign-in is refused with HTTP 403

### Requirement: An admin removal blocks rejoining through the organization

When an admin removes a member, as the teams-and-roles capability defines, Tiehall SHALL record a block on that person's GitHub account id. While the block exists, membership of a GitHub organization SHALL NOT admit that account: a sign-in that only organization membership would admit SHALL be refused with HTTP 403, as the requirement on who may sign in defines, and SHALL tell the person to ask an admin for an invite. Only an invite that an admin creates for that account after the removal SHALL admit it, and the sign-in that accepts that invite SHALL clear the block. A person admitted again this way SHALL join with the invite's role, in no team, and with none of the agent grants and personal access tokens they held before the removal, as the teams-and-roles capability defines. A removal because the person left the GitHub organization SHALL NOT record a block, so the company's GitHub organization keeps deciding who is in it. The block SHALL be recorded in the removal's security event, and its clearing in the security event of the sign-in that clears it, as the activity-log capability defines.

Source: D28 #4, #5, #10; design.md, Decisions this change rests on; design.md, Design rules: Teams and roles; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S14

#### Scenario: A removed organization member cannot rejoin by signing in

- **WHEN** Lee joined through membership of `acme`, an admin removes Lee with the confirmation step, and Lee, still a member of `acme`, signs in with GitHub the next day
- **THEN** the sign-in is refused with HTTP 403
- **AND** the answer tells Lee to ask an admin of the install for an invite
- **AND** Lee is not a member of the install

#### Scenario: An invite readmits a removed person

- **WHEN** an admin removed Lee last week, then invites the GitHub username `lee-acme`, which is Lee's account, and Lee signs in with it the next day
- **THEN** Lee is a member of the install with the invite's role and in no team
- **AND** the block on Lee's account is cleared, and the activity log's security event for that sign-in records the clearing
- **AND** a personal access token Lee created before the removal still does not work

#### Scenario: Leaving the organization records no block

- **WHEN** Lee joined through membership of `acme`, left `acme` on GitHub and was removed from the install for it, and later rejoins `acme` on GitHub and signs in
- **THEN** Lee is signed in and is a member of the install again

### Requirement: Leaving the GitHub organization ends access

A member who joined the install through membership of a GitHub organization SHALL be removed from the install, as if an admin had removed them but without a block, once GitHub positively reports, through a connected installation that is working, that their account is no longer a member of an organization in which Tiehall has seen it, and no working connected installation reports that the account is a member of its organization. The removal SHALL have the effects the teams-and-roles capability defines for a removed member, and the removed member's claims and pending proposals SHALL be handled as the requests capability defines. Tiehall SHALL check for this:
- at every sign-in of such a member, and SHALL refuse that sign-in with HTTP 403 when the check removes them;
- when GitHub reports, through an `organization` event, that the member was removed from an organization with a connected installation;
- in a reconciliation job that runs every 15 minutes, whether GitHub runs in webhook mode or polling mode, as the tracker-mirrors capability defines the modes.

A lookup that fails, and an installation that is suspended or deleted on GitHub, or that an admin has disconnected, SHALL never count as the account leaving: members who joined through such an organization SHALL stay members until an admin removes them or a connected installation that is working reports that they left. A member who joined through an invite, or who became the first admin by completing setup, SHALL NOT be removed this way. Because an install always keeps at least one admin, a removal this way SHALL NOT be made while the member is the install's only admin; the first check after another admin exists SHALL remove them. Each removal this way SHALL be recorded as a security event that names leaving the GitHub organization as its cause, as the activity-log capability defines.

Source: D28 #4, #10; design.md, Decisions this change rests on; design.md, Self-hosting decisions: S5; design.md, Self-hosting decisions: S6; design.md, Self-hosting decisions: S9; design.md, Self-hosting decisions: S14

#### Scenario: The organization event removes the member

- **WHEN** Lee joined through membership of `acme`, belongs to no other organization with a connected installation, claims FE-142, and is the accountable human of a pending due-date proposal on FE-150, and GitHub delivers an `organization` event reporting that Lee was removed from `acme`
- **THEN** Lee is no longer a member of the install
- **AND** the next call of Lee's agent with an unexpired token is refused with HTTP 403
- **AND** FE-142 stays claimed by Lee
- **AND** the due-date proposal on FE-150 is cancelled
- **AND** the activity log gains a security event that names leaving `acme` as the cause

#### Scenario: Reconciliation catches a change no event reported

- **WHEN** GitHub runs in polling mode, and Lee, who joined through membership of `acme`, leaves `acme` on GitHub
- **THEN** Lee is removed from the install no later than the first reconciliation run after Lee left, and that job runs every 15 minutes

#### Scenario: Sign-in checks membership first

- **WHEN** Lee, who joined through membership of `acme`, left `acme` on GitHub a minute ago, no event or reconciliation has reported it yet, and Lee signs in
- **THEN** the sign-in is refused with HTTP 403
- **AND** Lee is no longer a member of the install

#### Scenario: Another connected organization keeps access

- **WHEN** Lee is a member of both `acme` and `acme-labs`, both installations are connected, and Lee leaves `acme`
- **THEN** Lee stays a member of the install

#### Scenario: A suspended installation removes no one

- **WHEN** Lee and 40 other members joined through membership of `acme`, and the `acme` installation is suspended on GitHub for a day, during which the reconciliation runs
- **THEN** all of them stay members of the install

#### Scenario: A failed lookup removes no one

- **WHEN** Lee joined through membership of `acme`, and GitHub answers the reconciliation's membership lookup with a server error
- **THEN** Lee stays a member of the install

#### Scenario: A disconnect removes no one

- **WHEN** Lee joined through membership of `acme`, and an admin disconnects the `acme` installation
- **THEN** Lee stays a member of the install after the next reconciliation run
- **AND** stays one until an admin removes Lee, or until the `acme` installation is connected again and GitHub reports that Lee left `acme`

#### Scenario: Invited members are not affected

- **WHEN** Jo joined through an invite, is also a member of `acme`, and leaves `acme`
- **THEN** Jo stays a member of the install

#### Scenario: The only admin is not removed

- **WHEN** Omar joined through membership of `acme`, is now the install's only admin, and leaves `acme`
- **THEN** Omar stays a member and an admin
- **AND** once an admin makes Kim an admin as well, the next check removes Omar from the install

### Requirement: Signing out and ending sessions

A signed-in user SHALL be able to sign out, which ends that web session at once. Signing out SHALL end only that web session; it SHALL NOT revoke the user's agent grants or tokens, which the agent-access capability lets them list and revoke. When a member is removed, whether by an admin or by leaving the GitHub organization, Tiehall SHALL end every web session they hold, so that no page or operation of the install is served through any of them; a request that still carries one of those sessions SHALL be refused with HTTP 403 and SHALL return no data, as the teams-and-roles capability defines for a removed member, which also defines how the removal revokes their agent grants and personal access tokens.

Source: D37; design.md, Decisions this change rests on; design.md, Design rules: Teams and roles; design.md, Self-hosting decisions: S5

#### Scenario: Signing out ends the web session

- **WHEN** Ana signs out in their browser and then opens `https://tiehall.example.com/FE-142` in the same browser
- **THEN** the browser is treated as not signed in and is sent to sign-in
- **AND** a call of Ana's CLI with its unexpired token still succeeds

#### Scenario: A removed member's sessions end

- **WHEN** an admin removes Dana while Dana is signed in on two browsers
- **THEN** the next request from each browser is refused with HTTP 403
- **AND** neither answer contains data of the install

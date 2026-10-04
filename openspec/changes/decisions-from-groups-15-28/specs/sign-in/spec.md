# Spec Delta: sign-in

## Purpose

States the answer to a sign-in whose membership look-up GitHub fails. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Who may sign in

A person SHALL be able to sign in only when at least one of these holds for the GitHub account they sign in with:
- GitHub reports, through an installation of the install's App that an admin has connected, as the tracker-mirrors capability defines, that the account is a member of that installation's organization; the sign-in policy admits organization members; and the account is not blocked by an admin removal, as the requirement on admin removals defines;
- it holds a valid invite, as the teams-and-roles capability defines;
- its Tiehall user is already a member of the install;
- it signs in from the setup session while setup completes, which makes it the install's first admin, as the self-host-install capability defines, or, after the operator has reopened setup, it closes the reopened step, which only an account whose user is already an admin may do.

Tiehall SHALL check organization membership through the connected installations at each sign-in. An installation that no admin has connected SHALL admit no one, and an outside collaborator on a repository is not a member of its organization. A membership lookup that fails, or that goes through an installation that is suspended or deleted on GitHub, SHALL admit no one through that organization. When a person could be admitted only through an organization's membership, and a look-up through a working connected installation fails, by an error that GitHub gives no answer of its own for or by no answer within 10 seconds, while no other look-up reports the account a member, the sign-in SHALL be answered 502 with the problem type `integration-unavailable`, as the public-api capability's error model defines, and a message that says GitHub could not be reached and to try again; it SHALL admit no one, SHALL create no session, Tiehall user or membership, and SHALL record no security event for a refused sign-in. A browser SHALL get that answer as a page that gives the message and links to the sign-in page. Anyone else SHALL be refused with HTTP 403, as the public-api capability's error model defines for a GitHub account that may not sign in, with a message that tells them to ask an admin of the install for an invite; this includes a person whose only way in is an invite that has expired. A browser SHALL get that refusal as a page that gives the message and links to the sign-in page, as the error model defines for refusals to browsers. A refused sign-in SHALL create no session, no Tiehall user and no membership. Of a refused sign-in, Tiehall SHALL keep only its security event, a record of the refused GitHub account, which the event names (the account's numeric id, the login it had and the time of the refusal, kept as long as the event), and, for 90 days, the IP address and user agent recorded with the event, as the activity-log capability defines. Every successful sign-in and every refused sign-in SHALL be recorded as a security event, as the activity-log capability defines.

Source: D28 #1, #5; D37; D50 (5), (7); D55 (7); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A refused sign-in in a browser is a page

- **WHEN** Kim, who may not sign in, comes back in their browser from GitHub's authorization to the install's sign-in callback, with an `Accept` header that names `text/html`
- **THEN** the answer is HTTP 403 with an HTML page, not an RFC 9457 problem
- **AND** the page tells Kim to ask an admin of the install for an invite, and links to the sign-in page

#### Scenario: What a refused sign-in keeps

- **WHEN** the sign-in of Kim's GitHub account `kim-x` is refused
- **THEN** the activity log gains a security event that names a record of the account `kim-x`
- **AND** that record holds the account's numeric id, the login `kim-x` and the time of the refusal, and nothing else of Kim

#### Scenario: GitHub fails the membership look-up

- **WHEN** an admin has connected the App's installation on the GitHub organization `acme`, and Lee, a member of `acme` who is not a member of the install and holds no invite, signs in with GitHub while GitHub answers the look-up of `acme`'s members with 500
- **THEN** the sign-in is answered 502 with the problem type `integration-unavailable`, telling Lee that GitHub could not be reached and to try again
- **AND** no session, Tiehall user or membership is created for Lee
- **AND** the activity log gains no security event for a refused sign-in

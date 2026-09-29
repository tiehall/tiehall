# Spec Delta: agent-access

## Purpose

States that an integration event acts for a person's Tiehall user only while that user is a member of the install, and which of its own credentials Tiehall uses for each kind of call to GitHub. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Six kinds of caller

Every call to a Tiehall operation SHALL come from exactly one of six kinds of caller, each authorized as follows:
- a web session, which acts for the signed-in user within the user's role, and whose actions are recorded with the actor kind `web_session`, as the requests capability defines;
- an OAuth token, held by an MCP client or by the CLI after its device flow, which acts for the user who approved the client, within the token's scopes and the user's role;
- a personal access token, which acts for the user who created it, within its scopes and the user's role;
- a CI caller, authenticated with a GitHub Actions OIDC token, which acts for a registered API's repository and is limited as the requirement on CI below defines;
- a system job, which acts for no user and runs only Tiehall's internal system commands, which are never commitments;
- an integration event, meaning a verified GitHub or Jira webhook or a change Tiehall reads from GitHub or Jira by polling or reconciliation, as the tracker-mirrors capability defines, which runs only internal commands, and which acts for the mapped user, the Tiehall user of the GitHub account or the linked Atlassian account that the webhook or the change names as the one that made it, only while that user is a member of the install when the command runs. For an account whose user is not a member, whether removed or never admitted, for an account that maps to no user, and for a change that names no account that made it, such as a change Tiehall reads from GitHub by polling, it SHALL act for no user.

A system job or an integration event SHALL NOT be able to run an operation that is offered on REST, MCP or the CLI. An operation that no surface offers, an internal command, SHALL run only for a web session, through the web UI, or for a system job or an integration event, through the worker; an OAuth token, a personal access token or a CI caller SHALL NOT be able to run one. Every action guarded by the confirmation step, as the agent-safety capability defines, SHALL be an internal command, so it runs only for a web session. The operator commands that the self-host-install capability defines run on the host, outside these six kinds of caller, and are the one exception the agent-safety capability makes to the confirmation step.

Source: D23; D28 #75; D50 (10); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A token cannot reach an internal command

- **WHEN** an agent holding a valid OAuth token for Bob calls the `/api/v1` path of an internal command, one that no surface offers
- **THEN** the call answers HTTP 404
- **AND** the command does not run

#### Scenario: A system withdrawal acts for no user

- **WHEN** Tiehall withdraws the unclaimed contract-change request FE-150 because its provider PR closed unmerged
- **THEN** the change is recorded with the actor kind `system`
- **AND** it names no user as the one it acted for

#### Scenario: An unmapped tracker account acts for no user

- **WHEN** a verified Jira webhook reports a change on a mirror issue, made by a Jira account that is linked to no Tiehall user
- **THEN** the event Tiehall records has the actor kind `integration`
- **AND** it names no user as the one it acted for

#### Scenario: A removed member's GitHub activity acts for no user

- **WHEN** an admin has removed Dana from the install, and a verified delivery from a connected installation reports a change that Dana's GitHub account made
- **THEN** what Tiehall records for the change has the actor kind `integration`
- **AND** it names no user as the one it acted for

#### Scenario: A member's GitHub activity acts for them

- **WHEN** a verified delivery from a connected installation reports a change that the GitHub account of Lee, a member of the install, made
- **THEN** what Tiehall records for the change has the actor kind `integration`
- **AND** it names Lee's user as the one it acted for

#### Scenario: A removal while the delivery is processed

- **WHEN** a verified delivery from a connected installation reports a change that Dana's GitHub account made, and an admin removes Dana after Tiehall has read the delivery and before the command the change leads to runs
- **THEN** what Tiehall records for the change has the actor kind `integration`
- **AND** it names no user as the one it acted for

#### Scenario: A change read by polling acts for no user

- **WHEN** GitHub runs in polling mode, and the poll reads a change that Lee, a member of the install, made to a pull request in a covered repository
- **THEN** what Tiehall records for the change has the actor kind `integration`
- **AND** it names no user as the one it acted for

### Requirement: Outbound calls use Tiehall's own credentials

Tiehall SHALL call GitHub only with the install's GitHub App's own credentials: a JSON web token of the App, signed with its private key, for the App's own endpoints, such as listing the App's installations, reading the App, requesting an installation token, reading the App's webhook delivery log and asking GitHub to redeliver a delivery; an installation token for everything done in an installation, such as reading pull requests, users, organization members and the repositories an installation covers, and writing issues, comments and labels; and the App's client id and client secret, only to exchange the code of a sign-in in progress for that sign-in's user token. The exchange of the code that GitHub's manifest flow returns during setup SHALL carry no credential. The only other token Tiehall SHALL ever send to GitHub is the user token of a sign-in in progress, as the sign-in capability defines. Calls to Jira SHALL use the Jira bot account's API token, as the tracker-mirrors capability defines. Tiehall SHALL NOT use or forward a token that a client presented to Tiehall.

Source: D37; D50 (1); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: Linking a PR does not forward the agent's token

- **WHEN** an agent links a PR to a request through `/mcp`
- **THEN** Tiehall reads the PR from GitHub with an installation token of the install's GitHub App
- **AND** the agent's Tiehall token is not sent to GitHub

#### Scenario: A Jira mirror update uses the bot's token

- **WHEN** an agent's claim of FE-142 through `/api/v1` makes Tiehall create or update the Jira mirror issue of FE-142
- **THEN** Tiehall calls Jira with the bot account's API token
- **AND** the agent's token is not sent to Jira

#### Scenario: The App's own endpoints use the App's token

- **WHEN** Tiehall lists the installations of the install's GitHub App
- **THEN** it calls GitHub with a JSON web token of the App
- **AND** the call carries no installation token, no user's token and no token that a client presented to Tiehall

#### Scenario: The manifest's code is exchanged with no credential

- **WHEN** the setup screen exchanges the code that GitHub returned from the manifest flow for the new App's credentials
- **THEN** the call to GitHub carries no credential

#### Scenario: The App's client secret only exchanges a sign-in's code

- **WHEN** Ana completes a sign-in with GitHub, and Tiehall then lists the App's installations and reads a pull request
- **THEN** the App's client secret was sent to GitHub only in the exchange of Ana's sign-in code for that sign-in's user token
- **AND** no other call to GitHub carried it

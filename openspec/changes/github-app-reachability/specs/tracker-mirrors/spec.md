# Spec Delta: tracker-mirrors

## Purpose

Changes what the install's GitHub App subscribes to, how Tiehall finds the App's installations and the repositories they cover, what `/webhooks/github` does while no webhook secret is stored, and how GitHub's mode is chosen for an App without a webhook and moved to webhook mode later. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: The GitHub App asks for narrow permissions and every event up front

The GitHub App that each install creates, as the self-host-install capability defines, SHALL ask for exactly these permissions: Metadata (read), Pull requests (read), Issues (read and write), the organization permission Members (read) and the account permission Email addresses (read). It SHALL NOT ask for Contents or for any other permission. An App created with a webhook SHALL subscribe to the events `pull_request`, `issues` and `organization`, and to no other event. It SHALL also receive `installation` and `installation_repositories`, which every GitHub App receives without subscribing; the manifest SHALL NOT list them among its events, because GitHub refuses them there. An App created without a webhook SHALL subscribe to no event, because GitHub allows event subscriptions only with a webhook, and what those events report SHALL reach Tiehall by polling, by listing the App's installations and by reconciliation, as the requirements on webhook mode and polling mode, on connecting installations and on covered repositories, and the sign-in capability's requirement on leaving the GitHub organization, define. The App SHALL ask for all of its permissions when it is created, so that an installation never has to approve a new permission for anything v1 does, including when an App without a webhook later moves to webhook mode. Whoever installs the App on a GitHub organization SHALL choose which repositories the installation covers. The same App SHALL serve sign-in and the membership checks, as the sign-in capability defines, PR links and close on merge, as the requests capability defines, provider PRs, as the contract-changes capability defines, and the GitHub Issues mirror.

Source: D37; D49; design.md, Decisions this change rests on; design.md, Design rules: The webhook and the install URL; design.md, Design rules: Finding installations; design.md, Rules carried from earlier changes

#### Scenario: The manifest asks for the narrow permissions only

- **WHEN** the setup screen builds the GitHub App's manifest for `https://tiehall.example.com`
- **THEN** the manifest asks for Metadata read, Pull requests read, Issues read and write, organization Members read and account Email addresses read, and for no other permission
- **AND** it subscribes to the events `pull_request`, `issues` and `organization`, and to no other event
- **AND** it lists neither `installation` nor `installation_repositories`

#### Scenario: The install screen lists the same permissions

- **WHEN** someone starts installing the install's GitHub App on the GitHub organization `acme`
- **THEN** GitHub asks for those five permissions and for nothing else
- **AND** the installer chooses the repositories the installation covers

#### Scenario: An App without a webhook subscribes to no event

- **WHEN** the setup screen builds the GitHub App's manifest for `http://localhost:3000`, or for `https://tiehall.example.com` with the option that GitHub cannot reach this address
- **THEN** the manifest asks for the same five permissions and for no other
- **AND** it subscribes to no event

### Requirement: Admins connect GitHub installations with the confirmation step

Tiehall SHALL act only on installations of the install's GitHub App that an admin has connected. The installations made while setup completes SHALL be connected as the self-host-install capability defines. Tiehall SHALL find the App's installations by listing them through GitHub's API with the App's own credentials, in webhook mode and in polling mode, and SHALL NOT need an installation delivery to find one: it SHALL list them when setup completes, at each poll in polling mode, at each 15-minute reconciliation run in either mode, and when a delivery about an installation arrives in webhook mode. Connecting any other installation SHALL be an admin action in the web UI, with the confirmation step, as the agent-safety capability defines; a connection asked for by a member who is not an admin, or without a valid confirmation, SHALL be refused with 403, as the public-api capability's error model defines, and SHALL connect nothing. The admin page SHALL list every installation of the App that is not connected, so that an admin can connect it or leave it ignored. Tiehall SHALL use an installation that is not connected only to list it: its repositories SHALL NOT count as covered, its PRs SHALL NOT link or close requests, no mirror issue SHALL be created in it, and membership of its GitHub organization SHALL NOT let anyone sign in, as the sign-in capability defines. An admin SHALL be able to disconnect an installation in the web UI. Disconnecting SHALL NOT need the confirmation step, because it only narrows what Tiehall acts on, and SHALL remove no member: members who joined through that installation's organization stay, as the sign-in capability defines. Connecting and disconnecting an installation SHALL each be recorded as a security event, as the activity-log capability defines.

Source: D19; D28 #1, #4, #48; D49; design.md, Decisions this change rests on; design.md, Design rules: Finding installations; design.md, Rules carried from earlier changes

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

#### Scenario: An installation found by polling

- **WHEN** GitHub runs in polling mode, the install's App has been made public, and someone installs it on the GitHub organization `acme-labs`
- **THEN** within 2 minutes the admin page lists the `acme-labs` installation as not connected

#### Scenario: An installation whose delivery was lost

- **WHEN** GitHub runs in webhook mode, the install's App has been made public, someone installs it on `acme-labs`, and the delivery for that installation never reaches the install
- **THEN** within 15 minutes the admin page lists the `acme-labs` installation as not connected

### Requirement: Covered repositories follow each connected installation

The repositories the install covers SHALL be the repositories that its connected installations cover, following each installation's repository selection as `installation_repositories` events report it, or as polling finds it in polling mode. A repository removed from an installation SHALL stop counting as covered for mirrors, for the merged-PR rules that the requests capability defines, and for the provider PRs that the contract-changes capability follows. An installation that is deleted or suspended on GitHub SHALL stop covering its repositories while it is deleted or suspended. Tiehall SHALL read the repositories each connected installation covers through GitHub's API with an installation token when the installation is connected, at each poll in polling mode and at each 15-minute reconciliation run in either mode, so that it needs no delivery to learn them; an installation that the listing of the App's installations shows as suspended, or no longer holds, SHALL count as suspended or deleted, for this requirement and for the requirement on broken integrations.

Source: D49; design.md, Decisions this change rests on; design.md, Design rules: Finding installations; design.md, Rules carried from earlier changes

#### Scenario: A repository removed from the installation no longer closes requests

- **WHEN** someone removes `acme/web` from the `acme` installation on GitHub, and later a PR in `acme/web` that mentions `FE-142` merges after the claim
- **THEN** the merge does not move `FE-142` to done

#### Scenario: A repository added to the installation starts counting

- **WHEN** someone adds `acme/api` to the connected `acme` installation, and later a PR in `acme/api` whose branch name mentions `FE-142` merges after `FE-142` was claimed
- **THEN** `FE-142` moves to `done`

#### Scenario: A trial install's repositories count without any delivery

- **WHEN** `TIEHALL_URL` is `http://localhost:3000`, Omar installed the App, which has no webhook, on the GitHub organization `acme` with the repositories `acme/web` and `acme/api` during setup, and completed setup, and no webhook delivery has reached the install
- **THEN** right after setup completes, `acme/web` and `acme/api` count as covered

#### Scenario: A repository added in polling mode

- **WHEN** GitHub runs in polling mode, and someone adds `acme/tools` to the connected `acme` installation on GitHub
- **THEN** within 2 minutes `acme/tools` counts as covered

#### Scenario: A suspended installation is found by listing

- **WHEN** GitHub runs in polling mode, and the connected `acme` installation is suspended on GitHub
- **THEN** within 2 minutes the repositories of the `acme` installation no longer count as covered
- **AND** the `acme` installation counts as suspended, as the requirement on broken integrations defines

### Requirement: GitHub webhooks are verified, deduplicated and processed in the background

Tiehall SHALL receive GitHub deliveries at `https://<install>/webhooks/github`. For each delivery, Tiehall SHALL verify its signature with the App's webhook secret, store it deduplicated by its delivery id, answer with a 2xx status, and only then process it in a background job. A delivery that fails verification SHALL be answered with 401, and SHALL be neither stored nor processed. While no webhook secret is stored, as for an App created without a webhook until an admin stores one, as the requirement on webhook mode and polling mode defines, every delivery SHALL fail verification, whatever it carries. A delivery id seen before SHALL be answered with a 2xx status and not processed again. Deliveries from an installation that is not connected SHALL change nothing except the list of installations that the admin page shows. Tiehall SHALL accept deliveries in this way from the moment the setup screen has stored the App's credentials, with or without a webhook secret, before setup completes, as the self-host-install capability defines, and SHALL process the ones that arrive before setup completes once it does.

Source: D49; design.md, Decisions this change rests on; design.md, Design rules: An App without a webhook; design.md, Rules carried from earlier changes

#### Scenario: A forged delivery is dropped

- **WHEN** a request arrives at `https://tiehall.example.com/webhooks/github` with a signature that does not match the App's webhook secret
- **THEN** Tiehall does not store or process it
- **AND** answers with 401

#### Scenario: A repeated delivery is processed once

- **WHEN** GitHub sends the same delivery id twice
- **THEN** Tiehall answers both with a 2xx status
- **AND** processes the delivery only once

#### Scenario: No delivery is accepted while no webhook secret is stored

- **WHEN** the install at `http://localhost:3000` has stored the credentials of an App created without a webhook, and a request that carries a signature arrives at `http://localhost:3000/webhooks/github`
- **THEN** Tiehall answers with 401
- **AND** does not store or process it

### Requirement: GitHub and Jira each run in webhook mode or polling mode

GitHub and Jira SHALL each run in webhook mode or in polling mode, and both modes SHALL feed the same processing, so a change has the same effect whichever way it arrives. When the setup screen stores the credentials of the install's GitHub App, in setup or in a step that `setup reopen` opened, as the self-host-install capability defines, GitHub's mode SHALL be set from them as they are stored: polling mode for an App created without a webhook, and webhook mode for an App created with one. For an App created with a webhook, Tiehall SHALL, after the first installation, read the App's webhook delivery log through GitHub's API, and a failed delivery to the install SHALL put GitHub in polling mode. Only deliveries made after the App's credentials were stored SHALL count, because the install accepts deliveries from then on; the delivery for the installation made during setup SHALL be the first that counts. An App without a webhook has no delivery log, and GitHub answers a request for it with 404: Tiehall SHALL NOT take that answer for a failed delivery, SHALL NOT change the mode for it, and SHALL NOT report it to admins as a broken integration. Jira SHALL run in polling mode until a Jira webhook has delivered an event that Tiehall accepted, and in webhook mode after that. The admin page SHALL show each integration's mode, and an admin SHALL be able to switch either integration to the other mode in the web UI. GitHub SHALL NOT be switched to webhook mode while no webhook secret is stored: such a switch SHALL be refused with 409, as the public-api capability's error model defines for a state conflict, and SHALL change nothing. While no webhook secret is stored and `TIEHALL_URL` is not a trial URL, as the self-host-install capability defines trial URLs, the admin page SHALL show the steps that move GitHub to webhook mode: in the App's settings on GitHub, make the webhook active with the URL `TIEHALL_URL/webhooks/github` and a secret, and subscribe to the events that the requirement on the App's permissions lists; in Tiehall, store the same secret; then switch GitHub to webhook mode. On a trial URL, the admin page SHALL say instead that GitHub cannot deliver webhooks to it. An admin SHALL store the App's webhook secret in the web UI with the confirmation step, as the agent-safety capability defines; a request to store it from a member who is not an admin SHALL be refused with 403, and one with an empty secret with 400, as the public-api capability's error model defines, and neither SHALL store anything. The secret SHALL be stored as the self-host-install capability defines for stored integration secrets, SHALL replace any webhook secret stored before, SHALL NOT appear in any URL, and SHALL NOT be shown on any page, the review page included; storing it SHALL be recorded as a security event for a changed integration, as the activity-log capability defines. In polling mode, Tiehall SHALL poll every 60 seconds: on GitHub, the PRs linked to open requests, the PRs in covered repositories updated since the last poll, for key mentions and provider PRs, and the mirror issues; on Jira, the issues in the mapped projects updated in the last 2 minutes. In polling mode a change SHALL be picked up within 2 minutes, within the rate limits of GitHub and Jira.

Source: D28 #4, #48; D49; design.md, Decisions this change rests on; design.md, Design rules: The webhook and the install URL; design.md, Design rules: An App without a webhook; design.md, Design rules: Moving to webhook mode; design.md, Rules carried from earlier changes

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

#### Scenario: An App without a webhook polls from the start

- **WHEN** `TIEHALL_URL` is `http://localhost:3000`, the setup screen has stored the credentials of the App, which has no webhook, and Omar has completed setup
- **THEN** GitHub runs in polling mode and the admin page says so
- **AND** a PR that mentions `FE-142` and merges after the claim moves `FE-142` to `done` within 2 minutes of the merge

#### Scenario: No delivery log is no failure

- **WHEN** GitHub runs in polling mode for an App created without a webhook, and GitHub answers a request for the App's delivery log with 404
- **THEN** GitHub stays in polling mode
- **AND** no admin sees a banner or gets an email about a broken integration

#### Scenario: The admin page shows the steps to webhook mode

- **WHEN** the install at `https://tiehall.example.com` has an App without a webhook, and Ada, an admin, opens the admin page
- **THEN** the page shows that GitHub runs in polling mode
- **AND** it shows the steps: in the App's settings on GitHub, the active webhook with the URL `https://tiehall.example.com/webhooks/github` and a secret, and the events `pull_request`, `issues` and `organization`; in Tiehall, the same secret; then the switch to webhook mode

#### Scenario: The admin page of a trial install

- **WHEN** `TIEHALL_URL` is `http://localhost:3000`, and Ada, an admin, opens the admin page
- **THEN** the page shows that GitHub runs in polling mode
- **AND** it says that GitHub cannot deliver webhooks to `http://localhost:3000`, and shows no steps to webhook mode

#### Scenario: An admin moves the App to webhook mode

- **WHEN** Ada has added the webhook and the three events in the App's settings on GitHub, enters the same secret in the web UI and confirms it on its review page, and switches GitHub to webhook mode
- **THEN** GitHub runs in webhook mode
- **AND** a delivery signed with that secret is stored, answered with a 2xx status and processed
- **AND** the activity log gains a security event for the changed integration
- **AND** no page, the review page included, shows the secret, and no URL carries it

#### Scenario: No switch to webhook mode without a secret

- **WHEN** no webhook secret is stored, and Ada asks to switch GitHub to webhook mode
- **THEN** the switch is refused with 409 and an RFC 9457 problem
- **AND** GitHub stays in polling mode

#### Scenario: A member who is not an admin cannot store the webhook secret

- **WHEN** Mehmet, a member who is not an admin, asks to store a webhook secret for the install's GitHub App
- **THEN** the request is refused with 403 and an RFC 9457 problem
- **AND** no webhook secret is stored

#### Scenario: A new App stored after `setup reopen` sets the mode

- **WHEN** GitHub runs in polling mode for an App created without a webhook, Omar runs `setup reopen`, and the setup screen stores the credentials of a new App created with a webhook for `https://tiehall.example.com`
- **THEN** GitHub runs in webhook mode
- **AND** after the new App's first installation, a failed delivery to the install in its delivery log puts GitHub in polling mode

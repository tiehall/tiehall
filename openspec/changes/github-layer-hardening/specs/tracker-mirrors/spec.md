# Spec Delta: tracker-mirrors

## Purpose

States which of the App's credentials Tiehall writes to GitHub with, the size limit on a GitHub delivery and how long Tiehall keeps deliveries, how often it asks for a failed delivery and what happens when it gives one up, who sees that and for how long, and the bound on a stored webhook secret. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: GitHub writes appear as the App's bot

Tiehall SHALL write issues, comments, labels and issue states on GitHub only with installation tokens of the install's own GitHub App, never with a user's GitHub token or a token a client presented, and SHALL make every other call to GitHub with the App's own credentials, as the agent-access capability defines for outbound calls. So every issue, comment, label and issue state change Tiehall writes on GitHub SHALL appear as the App's bot.

Source: D37; D50 (1); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A mirrored issue shows the App as its author

- **WHEN** Tiehall creates the mirror issue for `FE-142` in `acme/fe-intake`
- **THEN** GitHub shows the install's App bot as the author of the issue and of every comment Tiehall adds to it

#### Scenario: A mirror write carries an installation token

- **WHEN** Tiehall adds a comment to the mirror issue for `FE-142` in `acme/fe-intake`
- **THEN** the call carries an installation token of the App's installation on `acme`
- **AND** it carries no JSON web token of the App, no user's token and no token that a client presented to Tiehall

### Requirement: GitHub webhooks are verified, deduplicated and processed in the background

Tiehall SHALL receive GitHub deliveries at `https://<install>/webhooks/github`. For each delivery, Tiehall SHALL verify its signature with the App's webhook secret, store it deduplicated by its delivery id, answer with a 2xx status, and only then process it in a background job. A delivery whose body is larger than 25 MiB (26,214,400 bytes) SHALL be refused with 413 and the problem type `payload-too-large` before its signature is checked and before its body is read past that limit, as the public-api capability defines for request bodies, and SHALL be neither stored nor processed. A delivery that fails verification SHALL be answered with 401, and SHALL be neither stored nor processed. While no webhook secret is stored, as for an App created without a webhook until an admin stores one, as the requirement on webhook mode and polling mode defines, every delivery SHALL fail verification, whatever it carries. A delivery id seen before SHALL be answered with a 2xx status and not processed again, as long as Tiehall still holds that delivery. Deliveries from an installation that is not connected SHALL change nothing except the list of installations that the admin page shows. Tiehall SHALL accept deliveries in this way from the moment the setup screen has stored the App's credentials, with or without a webhook secret, before setup completes, as the self-host-install capability defines, and SHALL process the ones that arrive before setup completes, and that it still holds, once it does. Tiehall SHALL keep a stored delivery, its payload included, until 7 days after it was processed, and SHALL then delete it. A delivery that has not been processed, such as one that arrived before setup completed or one whose processing failed, SHALL be kept until it is processed, and SHALL be deleted 30 days after it arrived if it never is, whether or not setup has completed. The changes that polling mode reads from GitHub and stores for the same processing SHALL be kept by the same rule.

Source: D49; D50 (4), (19); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A processed delivery is deleted after 7 days

- **WHEN** 8 days have passed since Tiehall processed a delivery of a `pull_request` event
- **THEN** the database no longer holds that delivery or its payload

#### Scenario: A redelivery within GitHub's window is still recognized

- **WHEN** Tiehall processed a delivery 2 days ago, and GitHub delivers it again with the same delivery id
- **THEN** Tiehall answers with a 2xx status
- **AND** does not process it again

#### Scenario: A delivery that is never processed is deleted after 30 days

- **WHEN** a delivery arrived at `https://tiehall.example.com/webhooks/github` before setup completed, and setup has still not completed 31 days later
- **THEN** the database no longer holds that delivery or its payload

#### Scenario: A delivery over 25 MiB is refused unread

- **WHEN** a request to `https://tiehall.example.com/webhooks/github` declares a body of 26 MiB
- **THEN** Tiehall answers 413 with the problem type `payload-too-large` before reading any byte of its body
- **AND** does not store or process it

### Requirement: Failed GitHub deliveries are redelivered

Because GitHub does not retry failed deliveries on its own, Tiehall SHALL, while GitHub runs in webhook mode, ask GitHub to redeliver failed deliveries every 10 to 15 minutes. Only deliveries made after the App's credentials were stored SHALL count, as the requirement on webhook mode and polling mode defines. Tiehall SHALL ask GitHub to redeliver each failed delivery a limited number of times, and only while GitHub still redelivers it. A delivery that is still failed after Tiehall's last request to redeliver it is given up: Tiehall SHALL stop asking for it, SHALL surface it as the requirement on broken integrations defines, and SHALL change GitHub's mode as the requirement on webhook mode and polling mode defines.

Source: D28 #41; D50 (15); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A delivery missed during a restart arrives later

- **WHEN** GitHub runs in webhook mode, GitHub records a delivery to the install as failed because the install was restarting, and the install is up again
- **THEN** within 15 minutes Tiehall asks GitHub to redeliver it
- **AND** processes it once

#### Scenario: A delivery that keeps failing is given up

- **WHEN** GitHub runs in webhook mode, a delivery made after the App's credentials were stored failed, and it fails again after each of Tiehall's requests to redeliver it
- **THEN** Tiehall stops asking GitHub to redeliver it
- **AND** the admins see a banner about GitHub's webhook

### Requirement: GitHub and Jira each run in webhook mode or polling mode

GitHub and Jira SHALL each run in webhook mode or in polling mode, and both modes SHALL feed the same processing, so a change has the same effect whichever way it arrives. When the setup screen stores the credentials of the install's GitHub App, in setup or in a step that `setup reopen` opened, as the self-host-install capability defines, GitHub's mode SHALL be set from them as they are stored: polling mode for an App created without a webhook, and webhook mode for an App created with one. For an App created with a webhook, Tiehall SHALL, after the first installation, read the App's webhook delivery log through GitHub's API, and a failed delivery to the install SHALL put GitHub in polling mode. Only deliveries made after the App's credentials were stored SHALL count, because the install accepts deliveries from then on; the delivery for the installation made during setup SHALL be the first that counts. An App without a webhook has no delivery log, and GitHub answers a request for it with 404: Tiehall SHALL NOT take that answer for a failed delivery, SHALL NOT change the mode for it, and SHALL NOT report it to admins as a broken integration. Jira SHALL run in polling mode until a Jira webhook has delivered an event that Tiehall accepted, and in webhook mode after that. The admin page SHALL show each integration's mode, and an admin SHALL be able to switch either integration to the other mode in the web UI. In webhook mode, when Tiehall gives up a GitHub delivery, as the requirement on redelivery defines, it SHALL put GitHub in polling mode, as a failed delivery after the first installation does, unless the latest change of GitHub's mode was an admin's switch to webhook mode for the App in use, which Tiehall SHALL NOT undo; either way it SHALL show the banner that the requirement on broken integrations defines. A change of GitHub's mode that Tiehall makes on its own SHALL be recorded as a security event for a changed integration that names no user, as the activity-log capability defines. GitHub SHALL NOT be switched to webhook mode while no webhook secret is stored: such a switch SHALL be refused with 409, as the public-api capability's error model defines for a state conflict, and SHALL change nothing. While no webhook secret is stored and `TIEHALL_URL` is not a trial URL, as the self-host-install capability defines trial URLs, the admin page SHALL show the steps that move GitHub to webhook mode: in the App's settings on GitHub, make the webhook active with the URL `TIEHALL_URL/webhooks/github` and a secret, and subscribe to the events that the requirement on the App's permissions lists; in Tiehall, store the same secret; then switch GitHub to webhook mode. On a trial URL, the admin page SHALL say instead that GitHub cannot deliver webhooks to it. An admin SHALL store the App's webhook secret in the web UI with the confirmation step, as the agent-safety capability defines; a request to store it from a member who is not an admin SHALL be refused with 403, and one with an empty secret, or with a secret of more than 1,024 characters, with 400, as the public-api capability's error model defines, and neither SHALL store anything. The secret SHALL be stored as the self-host-install capability defines for stored integration secrets, SHALL replace any webhook secret stored before, SHALL NOT appear in any URL, and SHALL NOT be shown on any page, the review page included; storing it SHALL be recorded as a security event for a changed integration, as the activity-log capability defines. In polling mode, Tiehall SHALL poll every 60 seconds: on GitHub, the PRs linked to open requests, the PRs in covered repositories updated since the last poll, for key mentions and provider PRs, and the mirror issues; on Jira, the issues in the mapped projects updated in the last 2 minutes. In polling mode a change SHALL be picked up within 2 minutes, within the rate limits of GitHub and Jira.

Source: D28 #4, #48; D49; D50 (13), (15); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A webhook that breaks later falls back to polling

- **WHEN** GitHub has run in webhook mode since the check after the first installation, and Tiehall gives up a delivery made later
- **THEN** GitHub runs in polling mode and the admin page says so
- **AND** the activity log gains a security event for the changed integration that names no user
- **AND** a PR that mentions `FE-142` and merges after the claim moves `FE-142` to `done` within 2 minutes of the merge

#### Scenario: An admin's switch to webhook mode is not undone

- **WHEN** Ada switched GitHub to webhook mode in the web UI, and Tiehall later gives up a delivery made after the switch
- **THEN** GitHub stays in webhook mode
- **AND** Ada and every other admin see a banner about GitHub's webhook

#### Scenario: A webhook secret longer than its bound

- **WHEN** Ada enters a webhook secret of 1,025 characters for the install's GitHub App and confirms it on its review page
- **THEN** the request is refused with 400
- **AND** no webhook secret is stored

#### Scenario: A webhook secret at its bound

- **WHEN** Ada enters a webhook secret of 1,024 characters for the install's GitHub App and confirms it on its review page
- **THEN** the secret is stored

### Requirement: Broken integrations are surfaced

When a connected GitHub installation stops working, because it is suspended or deleted on GitHub, or the Jira site answers the bot's calls with 401 or 403, Tiehall SHALL show a banner in the web UI to the install's admins and to the members of each team whose mirrors go through that installation or Jira site, and to no one else. When Tiehall gives up a GitHub delivery, as the requirement on redelivery defines, it SHALL show a banner about GitHub's webhook in the same way, to the install's admins and to the members of each team whose mirrors go through GitHub, and to no one else, until an admin next switches GitHub's mode or a delivery that reaches the install after the give-up is verified. When SMTP is set, Tiehall SHALL also email every admin about it; without SMTP, the banner is the only alert. The email about GitHub's webhook SHALL be sent once while its banner shows, however many deliveries Tiehall gives up in that time.

Source: D28 #41, #83; D50 (15); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A rejected Jira token is surfaced

- **WHEN** DATA maps the Jira project `DAT`, SMTP is set, and Jira answers a call with the bot's token with 401
- **THEN** the admins and the members of DATA see a banner about the broken Jira connection in the web UI, and a member of FE who is not an admin does not
- **AND** every admin gets an email about it

#### Scenario: A suspended GitHub installation is surfaced without SMTP

- **WHEN** FE maps `acme/fe-intake` as its intake repository, SMTP is not set, and the `acme` installation is suspended on GitHub
- **THEN** the admins and the members of FE see a banner about it in the web UI, and a member of DATA who is not an admin does not
- **AND** no email is sent

#### Scenario: A given-up delivery is surfaced

- **WHEN** FE maps `acme/fe-intake` as its intake repository, DATA maps the Jira project `DAT`, SMTP is set, and Tiehall gives up two GitHub deliveries an hour apart
- **THEN** the admins and the members of FE see a banner about GitHub's webhook in the web UI, and a member of DATA who is not an admin does not
- **AND** every admin gets one email about it
- **AND** the banner stays until an admin next switches GitHub's mode or a delivery that reaches the install after the give-up is verified

#### Scenario: The webhook banner goes once a delivery arrives

- **WHEN** Ada switched GitHub to webhook mode, Tiehall gave up a delivery made after the switch, and a later delivery from GitHub reaches the install and is verified
- **THEN** no one sees the banner about GitHub's webhook any more
- **AND** GitHub stays in webhook mode

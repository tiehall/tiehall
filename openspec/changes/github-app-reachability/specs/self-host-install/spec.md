# Spec Delta: self-host-install

## Purpose

Changes how the setup screen creates the install's GitHub App: the webhook follows the install's URL, with no webhook on a trial URL and an option to create the App without one on any other URL, and setup completes without any webhook delivery. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Setup names the company and makes the first admin

The setup screen SHALL ask for the company's name, which becomes the name of the install's one org, which has none until then, as the teams-and-roles capability defines. It SHALL then create the install's GitHub App as the requirement on the manifest flow defines, send the operator to install the App on their GitHub organization, and have them sign in with GitHub from the setup session. The person who signs in SHALL become the install's first admin, and the App installations they made during setup SHALL be connected, as the tracker-mirrors capability defines connected installations. Tiehall SHALL find those installations by listing the App's installations through GitHub's API with the App's own credentials, as the tracker-mirrors capability defines, whether or not the App has a webhook: they are the installations that the list holds when the sign-in completes setup, because the App is new and only its owner can install it. Completing setup SHALL NOT wait for, or need, any webhook delivery. Setup SHALL then close for good: the org SHALL record the time setup completed, the setup code SHALL stop working, every setup session SHALL stop working, `/setup` SHALL answer 404, and pages and API calls SHALL be served. Only the operator command `setup reopen` SHALL open it again. The completion of setup SHALL be recorded as a security event, as the activity-log capability defines.

Source: D36; D37; D45 (5), (7); D49; design.md, Decisions this change rests on; design.md, Design rules: Finding installations; design.md, Rules carried from earlier changes

#### Scenario: The operator becomes the first admin

- **WHEN** Omar enters the setup code, names the company "Acme", creates the App, installs it on the GitHub organization `acme`, and signs in with GitHub from the setup session
- **THEN** the install's org is named "Acme"
- **AND** Omar is a member with the role `admin`
- **AND** the installation on `acme` is connected
- **AND** the activity log gains a security event for the completion of setup

#### Scenario: Setup closes for good

- **WHEN** setup has completed and someone opens `https://tiehall.example.com/setup` or enters the setup code that was last printed
- **THEN** `/setup` answers 404
- **AND** no setup session is opened

#### Scenario: The API after setup

- **WHEN** setup has completed and a client calls `/api/v1/openapi.json`
- **THEN** the call answers 200 with the OpenAPI document

#### Scenario: The setup session ends with setup

- **WHEN** Omar completed setup from a browser that holds a setup session, and opens `https://tiehall.example.com/setup` from that browser
- **THEN** `/setup` answers 404
- **AND** the app's next start prints no setup code

#### Scenario: Setup completes on a trial install without any delivery

- **WHEN** `TIEHALL_URL` is `http://localhost:3000`, Omar creates the App, which has no webhook, installs it on the GitHub organization `acme`, and signs in with GitHub from the setup session, and no webhook delivery has reached the install
- **THEN** Omar is a member with the role `admin`
- **AND** the installation on `acme` is connected
- **AND** GitHub runs in polling mode

#### Scenario: The installation is found when its delivery never arrives

- **WHEN** `TIEHALL_URL` is `https://tiehall.example.com`, the App has a webhook, Omar installs it on `acme`, the delivery for that installation never reaches the install, and Omar signs in with GitHub from the setup session
- **THEN** setup completes
- **AND** the installation on `acme` is connected

### Requirement: The GitHub App is created with GitHub's manifest flow

The setup screen SHALL create the install's GitHub App through GitHub's App manifest flow. It SHALL post the manifest to the new-App page of the GitHub organization that the operator names as the App's owner, which the screen recommends, or to the operator's personal new-App page when they name none. A `state` value bound to the setup session SHALL protect the round trip: a return whose `state` is missing or not bound to the current setup session SHALL be refused and SHALL store nothing. The manifest SHALL set:
- the App's name, by default made of "Tiehall" and the install's host, which the operator can edit, because App names are unique on GitHub;
- the App's URL, its sign-in callback URL and its redirect URL, all on `TIEHALL_URL`;
- the webhook that the install's URL decides, as below;
- `public` set to false;
- the permissions that the tracker-mirrors capability lists, and, only when the App has a webhook, the events that it lists.

GitHub refuses a manifest whose webhook URL is on `localhost`, whether the webhook is active or not, may refuse other webhook URLs it cannot reach, refuses events without a webhook URL, and leaves the operator on its own error page. So the setup screen SHALL decide the webhook from `TIEHALL_URL`:
- when `TIEHALL_URL` is a trial URL, which is exactly what the requirement on `TIEHALL_URL` and TLS accepts as a trial on one machine, `http://localhost` with or without a port, the manifest SHALL carry no webhook and no events;
- for any other `TIEHALL_URL`, the manifest SHALL carry the webhook URL `TIEHALL_URL/webhooks/github`, with the webhook active, and the events, unless the operator chooses the setup screen's option that GitHub cannot reach this address. The setup screen SHALL offer that option for every URL that is not a trial URL, off by default; when the operator chooses it, the manifest SHALL carry no webhook and no events.

An App created without a webhook SHALL run GitHub in polling mode from the moment its credentials are stored, as the tracker-mirrors capability defines. Before the operator creates the App, the setup screen SHALL say what the App gets: for a trial URL, or with the option, that the App has no webhook and that GitHub runs in polling mode; otherwise, that GitHub may refuse the webhook URL if it cannot reach this address, and that the operator then comes back to `TIEHALL_URL/setup` in the same browser, whose setup session stays valid until setup completes, as the requirement on the setup code defines, and chooses the option that GitHub cannot reach this address.

When GitHub redirects back with a code, Tiehall SHALL exchange it within the hour for the App's id, slug, client id and client secret, private key and, for an App with a webhook, its webhook secret, and SHALL store them as the requirement on stored integration secrets defines. GitHub gives no webhook secret for an App without a webhook, and Tiehall SHALL store that App's credentials without one. The App SHALL serve sign-in, PR links, close on merge, the GitHub Issues mirror, the mapping of PR authors to users and the organization-membership checks, and Tiehall SHALL call GitHub with the App's installation tokens, never with a user's token. The App SHALL be private, so it installs only on its owner; a company with several GitHub organizations can make it public in GitHub's settings and install it on each, and Tiehall acts only on installations an admin has connected, as the tracker-mirrors capability defines.

Source: D37; D49; design.md, Decisions this change rests on; design.md, Design rules: The webhook and the install URL; design.md, Design rules: An App without a webhook; design.md, Rules carried from earlier changes

#### Scenario: An App owned by the company's organization

- **WHEN** Omar names the GitHub organization `acme` as the App's owner on the setup screen of `https://tiehall.example.com`
- **THEN** the manifest is posted to the new-App page of `acme`
- **AND** its webhook URL is `https://tiehall.example.com/webhooks/github`, with the webhook active
- **AND** it sets `public` to false
- **AND** it asks for exactly the permissions and events that the tracker-mirrors capability lists

#### Scenario: The operator edits the App's name

- **WHEN** the default name made of "Tiehall" and `tiehall.example.com` is taken on GitHub, and Omar changes the name to "Tiehall Acme" before creating the App
- **THEN** the manifest carries the name "Tiehall Acme"

#### Scenario: GitHub returns the App's credentials

- **WHEN** GitHub redirects back to the setup screen with a code and the `state` bound to Omar's setup session, for an App created with a webhook
- **THEN** Tiehall stores the App's id, slug, client id, client secret, webhook secret and private key
- **AND** the setup screen sends Omar on to install the App

#### Scenario: A return with a foreign state

- **WHEN** a redirect to the setup screen carries a code and a `state` that is not bound to the current setup session
- **THEN** it is refused
- **AND** no App credentials are stored

#### Scenario: A trial install's App has no webhook

- **WHEN** `TIEHALL_URL` is `http://localhost:3000` and Omar creates the App on the setup screen
- **THEN** the manifest carries no webhook and no events
- **AND** it asks for exactly the permissions that the tracker-mirrors capability lists
- **AND** before Omar created the App, the setup screen said that the App has no webhook and that GitHub runs in polling mode

#### Scenario: The operator says GitHub cannot reach the address

- **WHEN** `TIEHALL_URL` is `https://tiehall.example.com`, and Omar chooses the option that GitHub cannot reach this address and creates the App
- **THEN** the manifest carries no webhook and no events
- **AND** once the App's credentials are stored, GitHub runs in polling mode

#### Scenario: The setup screen says what to do before the click

- **WHEN** `TIEHALL_URL` is `https://tiehall.example.com`, and Omar is on the setup screen's App step and has not chosen the option
- **THEN** before the button that creates the App, the screen says that GitHub may refuse the webhook URL if it cannot reach this address
- **AND** it says that Omar then comes back to `https://tiehall.example.com/setup` in the same browser and chooses the option that GitHub cannot reach this address

#### Scenario: Coming back after GitHub refused the webhook URL

- **WHEN** GitHub refused the manifest for `https://tiehall.example.com` because it cannot reach the webhook URL, and Omar opens `https://tiehall.example.com/setup` again in the same browser
- **THEN** the setup screen shows the App step without asking for the setup code
- **AND** when Omar chooses the option that GitHub cannot reach this address, the App is created without a webhook

#### Scenario: An App without a webhook is stored without a webhook secret

- **WHEN** GitHub redirects back to the setup screen with a code and the `state` bound to Omar's setup session, for an App created without a webhook, and the exchange gives no webhook secret
- **THEN** Tiehall stores the App's id, slug, client id, client secret and private key, and no webhook secret
- **AND** the setup screen sends Omar on to install the App

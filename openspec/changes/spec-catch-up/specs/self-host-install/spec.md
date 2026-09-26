# Spec Delta: self-host-install

## Purpose

Brings the self-host-install capability up to what the code does: what "setup is complete" means, and that a setup session has no expiry and ends only when setup completes.

## MODIFIED Requirements

### Requirement: The setup code guards the setup screen

Setup is complete once the install's org records the time at which the first admin's sign-in completed it, as the teams-and-roles capability defines for the org. Until setup is complete, every page SHALL lead to `/setup`, and API calls SHALL answer 503 with the problem type `setup-required`, as the public-api capability's error model defines, the OpenAPI document at `/api/v1/openapi.json` included; `/docs/api` is a page and leads to `/setup`. Every operation SHALL answer the same 503 while setup is incomplete, whichever route or surface it reaches, so that a call that gets past the routes above still runs nothing. The only routes served before setup completes SHALL be `/setup`, `/healthz` and, from the moment the setup screen has stored the GitHub App's credentials, `/webhooks/github`, which SHALL verify and store deliveries as the tracker-mirrors capability defines and process them once setup completes. While setup is incomplete, the app SHALL print a one-time setup code to its log each time it starts, where `docker compose logs app` shows it. The code SHALL carry at least 128 bits of randomness; Tiehall SHALL store only a hash of it, and each start SHALL replace it. Only a browser that enters the current code SHALL get a setup session; a wrong code SHALL be refused with 403 and SHALL open no session. A setup session SHALL be kept in a cookie that only the install reads and stored only as a hash; it SHALL NOT expire with time, and SHALL stay valid until setup completes. A later start's new code SHALL stop the earlier code from opening a session, and SHALL NOT end the sessions opened with the earlier code. Every step of the setup screen SHALL need that session. The setup screen SHALL check that the browser's origin matches `TIEHALL_URL`, and SHALL NOT continue when it does not.

Source: D45 (5), (7); design.md, Technical decisions: T7; design.md, Technical decisions: T16; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S9; design.md, Decisions: D45 (5), (7)

#### Scenario: Pages lead to the setup screen

- **WHEN** setup is not complete and a browser opens `https://tiehall.example.com/FE-142`
- **THEN** it is redirected to `/setup`

#### Scenario: The API before setup

- **WHEN** setup is not complete and a client calls an `/api/v1` operation
- **THEN** the call answers 503 with an RFC 9457 problem whose problem type is `setup-required`

#### Scenario: A stranger without the code

- **WHEN** setup is not complete and a visitor who cannot read the container log opens `/setup` and enters a wrong code
- **THEN** the answer is 403 and they get no setup session
- **AND** no setup step, App creation or account is available to them

#### Scenario: The OpenAPI document waits for setup

- **WHEN** setup is not complete and a client requests `/api/v1/openapi.json`
- **THEN** the answer is 503 with the problem type `setup-required`

#### Scenario: Health checks work before setup

- **WHEN** setup is not complete and the Compose health check requests `/healthz`
- **THEN** the answer is "up"

#### Scenario: A delivery during setup is kept

- **WHEN** the setup screen has stored the App's credentials, Omar installs the App on `acme`, and GitHub delivers the `installation` event to `https://tiehall.example.com/webhooks/github` before Omar signs in
- **THEN** Tiehall verifies and stores the delivery and answers with a 2xx status
- **AND** processes it once setup completes

#### Scenario: A restart replaces the code

- **WHEN** Omar read the setup code, the app restarted before Omar entered it, and Omar enters the old code
- **THEN** they get no setup session
- **AND** the log shows a new code, which opens a setup session

#### Scenario: Only a hash is stored

- **WHEN** the database is read while setup is incomplete
- **THEN** it does not hold the current setup code in plain text

#### Scenario: The browser's origin does not match

- **WHEN** `TIEHALL_URL` is `https://tiehall.example.com`, and Omar opens the setup screen through `http://10.0.0.5:3000` and enters the current code
- **THEN** the setup screen does not continue

#### Scenario: An operation reached before setup runs nothing

- **WHEN** setup is not complete and a call reaches an operation on any surface
- **THEN** the call answers 503 with the problem type `setup-required`
- **AND** nothing is read or changed

#### Scenario: A setup session has no expiry

- **WHEN** Omar entered the setup code at 09:00 and opens the setup screen from the same browser at 18:00, with no start of the app in between
- **THEN** the setup screen shows Omar the next step
- **AND** the same holds 30 days later, as long as setup is not complete

#### Scenario: A setup session outlives a restart

- **WHEN** Omar entered the setup code, the app then restarted and printed a new code, and Omar opens the setup screen from the same browser
- **THEN** the setup screen shows Omar the next step
- **AND** the code Omar entered opens no new session

### Requirement: Setup names the company and makes the first admin

The setup screen SHALL ask for the company's name, which becomes the name of the install's one org, which has none until then, as the teams-and-roles capability defines. It SHALL then create the install's GitHub App as the requirement on the manifest flow defines, send the operator to install the App on their GitHub organization, and have them sign in with GitHub from the setup session. The person who signs in SHALL become the install's first admin, and the App installations they made during setup SHALL be connected, as the tracker-mirrors capability defines connected installations. Setup SHALL then close for good: the org SHALL record the time setup completed, the setup code SHALL stop working, every setup session SHALL stop working, `/setup` SHALL answer 404, and pages and API calls SHALL be served. Only the operator command `setup reopen` SHALL open it again. The completion of setup SHALL be recorded as a security event, as the activity-log capability defines.

Source: D36; D37; D45 (5), (7); design.md, Decisions this change rests on; design.md, Self-hosting decisions: S3; design.md, Self-hosting decisions: S14; design.md, Decisions: D45 (5), (7)

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

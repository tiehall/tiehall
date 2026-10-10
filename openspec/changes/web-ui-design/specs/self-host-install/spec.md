# Spec Delta: self-host-install

## Purpose

States that the setup gate serves the web UI's assets before setup completes, so the setup screen has its look. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: The setup code guards the setup screen

Setup is complete once the install's org records the time at which the first admin's sign-in completed it, as the teams-and-roles capability defines for the org. Until setup is complete, every page SHALL lead to `/setup`, and API calls SHALL answer 503 with the problem type `setup-required`, as the public-api capability's error model defines, the OpenAPI document at `/api/v1/openapi.json` included; `/docs/api` is a page and leads to `/setup`. Every operation SHALL answer the same 503 while setup is incomplete, whichever route or surface it reaches, so that a call that gets past the routes above still runs nothing. The only routes served before setup completes SHALL be `/setup`, `/healthz`, the web UI's assets, which hold nothing of the install's data and which the web-ui capability defines (`/favicon.ico` and every path under `/assets/`), and, from the moment the setup screen has stored the GitHub App's credentials, `/webhooks/github`, which SHALL verify and store deliveries as the tracker-mirrors capability defines and process the ones it still holds once setup completes. The setup screen's own sign-in with GitHub, which completes setup, and GitHub's return to its callback at `/setup/sign-in/callback/github` are part of `/setup`: they SHALL be served only while setup is not complete, or while a step that `setup reopen` opened is open, as the requirement on operator commands defines. The sign-in service's own routes under `/api/auth`, GitHub's return to the usual sign-in callback included, are API calls and SHALL NOT be served before setup completes. While setup is incomplete, the app SHALL print a one-time setup code to its log each time it starts, where `docker compose logs app` shows it. The code SHALL carry at least 128 bits of randomness; Tiehall SHALL store only a hash of it, and each start SHALL replace it. Only a browser that enters the current code SHALL get a setup session; a wrong code SHALL be refused with 403 and SHALL open no session. A setup session SHALL be kept in a cookie that only the install reads and stored only as a hash; it SHALL NOT expire with time, and SHALL stay valid until setup completes. A later start's new code SHALL stop the earlier code from opening a session, and SHALL NOT end the sessions opened with the earlier code. Every step of the setup screen SHALL need that session. The setup screen SHALL check that the browser's origin matches `TIEHALL_URL`, and SHALL NOT continue when it does not.

Source: D45 (5), (7); D50 (4), (8); D57 (14); design.md, Decisions this change rests on; design.md, Design: The install's assets; design.md, Rules carried from earlier changes

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

#### Scenario: The usual sign-in callback waits for setup

- **WHEN** setup is not complete, and a request arrives at `https://tiehall.example.com/api/auth/callback/github` with a code and a state
- **THEN** the call answers 503 with the problem type `setup-required`
- **AND** no session and no Tiehall user is created

#### Scenario: The setup screen's sign-in callback closes with setup

- **WHEN** setup has completed, and a browser arrives at `https://tiehall.example.com/setup/sign-in/callback/github` with a code and a state
- **THEN** the answer is 404
- **AND** no session and no Tiehall user is created

#### Scenario: The setup screen has its look before setup

- **WHEN** setup is not complete and Omar opens `https://tiehall.example.com/setup`
- **THEN** the browser loads the stylesheet, the fonts and the icons the page names from the install, each answered 200
- **AND** none of those calls leads to `/setup`, and none opens or needs a setup session

# Spec Delta: self-host-install

## Purpose

States the setup screen's own sign-in callback and the two callback URLs the App's manifest carries, the bounds of the company's name, the App's default name and the bound on a name the operator gives, the expiry and single use of the manifest flow's `state`, what the setup screen says about an App a later return replaced, what it answers for a code GitHub does not convert, and how an uploaded App key is checked and bounded. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: The setup code guards the setup screen

Setup is complete once the install's org records the time at which the first admin's sign-in completed it, as the teams-and-roles capability defines for the org. Until setup is complete, every page SHALL lead to `/setup`, and API calls SHALL answer 503 with the problem type `setup-required`, as the public-api capability's error model defines, the OpenAPI document at `/api/v1/openapi.json` included; `/docs/api` is a page and leads to `/setup`. Every operation SHALL answer the same 503 while setup is incomplete, whichever route or surface it reaches, so that a call that gets past the routes above still runs nothing. The only routes served before setup completes SHALL be `/setup`, `/healthz` and, from the moment the setup screen has stored the GitHub App's credentials, `/webhooks/github`, which SHALL verify and store deliveries as the tracker-mirrors capability defines and process the ones it still holds once setup completes. The setup screen's own sign-in with GitHub, which completes setup, and GitHub's return to its callback at `/setup/sign-in/callback/github` are part of `/setup`: they SHALL be served only while setup is not complete, or while a step that `setup reopen` opened is open, as the requirement on operator commands defines. The sign-in service's own routes under `/api/auth`, GitHub's return to the usual sign-in callback included, are API calls and SHALL NOT be served before setup completes. While setup is incomplete, the app SHALL print a one-time setup code to its log each time it starts, where `docker compose logs app` shows it. The code SHALL carry at least 128 bits of randomness; Tiehall SHALL store only a hash of it, and each start SHALL replace it. Only a browser that enters the current code SHALL get a setup session; a wrong code SHALL be refused with 403 and SHALL open no session. A setup session SHALL be kept in a cookie that only the install reads and stored only as a hash; it SHALL NOT expire with time, and SHALL stay valid until setup completes. A later start's new code SHALL stop the earlier code from opening a session, and SHALL NOT end the sessions opened with the earlier code. Every step of the setup screen SHALL need that session. The setup screen SHALL check that the browser's origin matches `TIEHALL_URL`, and SHALL NOT continue when it does not.

Source: D45 (5), (7); D50 (4), (8); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

### Requirement: Setup names the company and makes the first admin

The setup screen SHALL ask for the company's name, which becomes the name of the install's one org, which has none until then, as the teams-and-roles capability defines. The name SHALL have 1 to 100 characters after leading and trailing blanks are removed, and no control character; the setup screen SHALL refuse any other name with 400, as the public-api capability's error model defines for input that fails the schema, and SHALL change nothing. The operator SHALL be able to change the name on the setup screen until setup completes; v1 SHALL offer no way to change it after that. The setup screen SHALL then create the install's GitHub App as the requirement on the manifest flow defines, send the operator to install the App on their GitHub organization, and have them sign in with GitHub from the setup session. The person who signs in SHALL become the install's first admin, and the App installations they made during setup SHALL be connected, as the tracker-mirrors capability defines connected installations. Tiehall SHALL find those installations by listing the App's installations through GitHub's API with the App's own credentials, as the tracker-mirrors capability defines, whether or not the App has a webhook: they are the installations that the list holds when the sign-in completes setup, because the App is new and only its owner can install it. Completing setup SHALL NOT wait for, or need, any webhook delivery. Setup SHALL then close for good: the org SHALL record the time setup completed, the setup code SHALL stop working, every setup session SHALL stop working, `/setup` SHALL answer 404, and pages and API calls SHALL be served. Only the operator command `setup reopen` SHALL open it again. The completion of setup SHALL be recorded as a security event, as the activity-log capability defines.

Source: D36; D37; D45 (2), (5), (7); D49; D50 (9); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

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

#### Scenario: A company name outside its bounds

- **WHEN** Omar, on the setup screen, gives the company a name of 101 characters, a name of blanks only, or a name with a line break in it
- **THEN** the setup screen refuses the name with 400
- **AND** the install's org keeps the name it had before, or none

#### Scenario: The company's name can change until setup completes

- **WHEN** Omar named the company "Acme" and, before signing in, changes the name to "Acme Corp" on the setup screen
- **THEN** the install's org is named "Acme Corp"
- **AND** once setup has completed, the setup screen's form for the name answers 404 and the name stays "Acme Corp"

### Requirement: The GitHub App is created with GitHub's manifest flow

The setup screen SHALL create the install's GitHub App through GitHub's App manifest flow. It SHALL post the manifest to the new-App page of the GitHub organization that the operator names as the App's owner, which the screen recommends, or to the operator's personal new-App page when they name none. A `state` value bound to the setup session SHALL protect the round trip: a return whose `state` is missing, is not bound to the current setup session, was issued more than 60 minutes before, or has already brought back an App's credentials SHALL be refused with 403, as the public-api capability's error model defines for an action the caller may not take, before GitHub is asked, and SHALL store nothing. The manifest SHALL set:
- the App's name, by default "Tiehall" followed by a space and the company's name that the setup screen recorded, cut to 34 characters, the longest name GitHub accepts for an App, and without a trailing blank, dot or hyphen; the operator can edit it, because App names are unique on GitHub, and a name the operator gives SHALL have 1 to 34 characters after leading and trailing blanks are removed: for any other name, the App step SHALL say so and SHALL offer no button that creates the App;
- the App's URL and its redirect URL, and two sign-in callback URLs, all on `TIEHALL_URL`: the sign-in's, `TIEHALL_URL/api/auth/callback/github`, and the setup screen's, `TIEHALL_URL/setup/sign-in/callback/github`, as the requirement on the setup code defines;
- the webhook that the install's URL decides, as below;
- `public` set to false;
- the permissions that the tracker-mirrors capability lists, and, only when the App has a webhook, the events that it lists.

GitHub refuses a manifest whose webhook URL is on `localhost`, whether the webhook is active or not, may refuse other webhook URLs it cannot reach, refuses events without a webhook URL, and leaves the operator on its own error page. So the setup screen SHALL decide the webhook from `TIEHALL_URL`:
- when `TIEHALL_URL` is a trial URL, which is exactly what the requirement on `TIEHALL_URL` and TLS accepts as a trial on one machine, `http://localhost` with or without a port, the manifest SHALL carry no webhook and no events;
- for any other `TIEHALL_URL`, the manifest SHALL carry the webhook URL `TIEHALL_URL/webhooks/github`, with the webhook active, and the events, unless the operator chooses the setup screen's option that GitHub cannot reach this address. The setup screen SHALL offer that option for every URL that is not a trial URL, off by default; when the operator chooses it, the manifest SHALL carry no webhook and no events.

An App created without a webhook SHALL run GitHub in polling mode from the moment its credentials are stored, as the tracker-mirrors capability defines. Before the operator creates the App, the setup screen SHALL say what the App gets: for a trial URL, or with the option, that the App has no webhook and that GitHub runs in polling mode; otherwise, that GitHub may refuse the webhook URL if it cannot reach this address, and that the operator then comes back to `TIEHALL_URL/setup` in the same browser, whose setup session stays valid until setup completes, as the requirement on the setup code defines, and chooses the option that GitHub cannot reach this address. It SHALL also say that GitHub may refuse the App's name as taken, and that the operator can then change the name on GitHub's own page, or come back to `TIEHALL_URL/setup` in the same browser and change it there.

When GitHub redirects back with a code, Tiehall SHALL exchange it within the hour for the App's id, slug, client id and client secret, private key and, for an App with a webhook, its webhook secret, and SHALL store them as the requirement on stored integration secrets defines. GitHub gives no webhook secret for an App without a webhook, and Tiehall SHALL store that App's credentials without one. A return whose code is missing, or is not in the form GitHub issues codes in, SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema, before GitHub is asked, and SHALL store nothing. When GitHub does not give the App's credentials for the code, because it refuses the code, fails the exchange or does not answer it within 10 seconds, the setup screen SHALL answer 502 with the problem type `integration-unavailable`, as the public-api capability's error model defines, SHALL store nothing, and SHALL say to create the App again. While setup is not complete, a later return that brings back another App's credentials, such as one from an App step opened earlier in another tab, SHALL replace the stored App; the setup screen's next step SHALL then name each App it replaced, say that it is still registered on GitHub with a private key that nobody uses, and link to its settings on GitHub, where the operator can delete it. The App SHALL serve sign-in, PR links, close on merge, the GitHub Issues mirror, the mapping of PR authors to users and the organization-membership checks, and Tiehall SHALL call GitHub only with the App's own credentials, as the agent-access capability defines for outbound calls: the exchange of the code carries none, and no user's token is used beyond the sign-in that GitHub issued it for, as the sign-in capability defines. The App SHALL be private, so it installs only on its owner; a company with several GitHub organizations can make it public in GitHub's settings and install it on each, and Tiehall acts only on installations an admin has connected, as the tracker-mirrors capability defines.

Source: D37; D49; D50 (1), (3), (8), (17), (18), (21), (22); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: An App owned by the company's organization

- **WHEN** Omar names the GitHub organization `acme` as the App's owner on the setup screen of `https://tiehall.example.com`
- **THEN** the manifest is posted to the new-App page of `acme`
- **AND** its webhook URL is `https://tiehall.example.com/webhooks/github`, with the webhook active
- **AND** it sets `public` to false
- **AND** it asks for exactly the permissions and events that the tracker-mirrors capability lists

#### Scenario: The operator edits the App's name

- **WHEN** Omar named the company "Acme", the default name "Tiehall Acme" is taken on GitHub, and Omar changes the name to "Tiehall Acme Platform" before creating the App
- **THEN** the manifest carries the name "Tiehall Acme Platform"

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

#### Scenario: The default name comes from the company

- **WHEN** Omar named the company "Acme" on the setup screen and opens the App step
- **THEN** the App's name is "Tiehall Acme" unless Omar edits it
- **AND** for the company "Acme Industrial Robotics International" it is "Tiehall Acme Industrial Robotics I", its first 34 characters

#### Scenario: The setup screen says what to do about a taken name

- **WHEN** `TIEHALL_URL` is `https://tiehall.example.com`, and Omar is on the setup screen's App step
- **THEN** before the button that creates the App, the screen says that GitHub may refuse the App's name as taken
- **AND** it says that Omar can then change the name on GitHub's own page, or come back to `https://tiehall.example.com/setup` in the same browser and change it there

#### Scenario: A taken name changed on GitHub's page

- **WHEN** Omar creates the App with the name "Tiehall Acme", GitHub's page says that the name is taken, and Omar changes it there to "Tiehall Acme Platform" and creates the App
- **THEN** GitHub redirects back to the setup screen with a code and the `state` bound to Omar's setup session
- **AND** Tiehall stores the App under the name "Tiehall Acme Platform"

#### Scenario: A name GitHub would not take

- **WHEN** Omar, on the setup screen's App step, gives the App a name of 35 characters, or one of blanks only
- **THEN** the App step says that the App's name must have 1 to 34 characters
- **AND** it offers no button that creates the App

#### Scenario: The manifest names both sign-in callbacks

- **WHEN** the setup screen builds the App's manifest for `https://tiehall.example.com`
- **THEN** its sign-in callback URLs are exactly `https://tiehall.example.com/api/auth/callback/github` and `https://tiehall.example.com/setup/sign-in/callback/github`

#### Scenario: A state that is too old or already used

- **WHEN** GitHub redirects back to the setup screen with a code and a `state` bound to Omar's setup session that was issued 61 minutes before, or with a `state` whose return already stored an App
- **THEN** the return is refused with 403, and GitHub is not asked to exchange the code
- **AND** no App credentials are stored, and an App stored before stays

#### Scenario: A code not in GitHub's form

- **WHEN** a return to the setup screen carries the `state` bound to Omar's setup session and a code that is not in the form GitHub issues codes in
- **THEN** the setup screen answers 400, and GitHub is not asked to exchange the code
- **AND** no App credentials are stored

#### Scenario: GitHub does not convert the code

- **WHEN** GitHub redirects back to the setup screen with a code and the `state` bound to Omar's setup session, and GitHub does not answer the exchange of the code within 10 seconds
- **THEN** the setup screen answers 502 and says to create the App again
- **AND** no App credentials are stored

#### Scenario: An App from an older tab replaces the stored one

- **WHEN** Omar created the App "Tiehall Acme" from one tab, and then creates "Tiehall Acme 2" from an App step opened earlier in another tab, and both returns reach the setup screen before setup completes
- **THEN** Tiehall stores "Tiehall Acme 2" in place of "Tiehall Acme"
- **AND** the setup screen's next step names "Tiehall Acme", says that it is still registered on GitHub, and links to its settings on GitHub

### Requirement: A rotated App key can be uploaded

An admin SHALL be able to upload a new private key for the install's GitHub App after rotating it in GitHub's settings, in the web UI and with the confirmation step, as the agent-safety capability defines. The admin SHALL pick the key's file on the review page; the file SHALL be at most 64 KB (65,536 bytes), and the key it holds at most 16,384 characters, in PEM form. A file outside these bounds, or one that holds no private key in PEM form, SHALL be refused with 400, as the public-api capability's error model defines for input that fails the schema, before GitHub is asked, and SHALL store nothing. Before storing the key, Tiehall SHALL check it by asking GitHub for the App itself with a JSON web token signed with the new key whose issuer is the App's stored client id, and SHALL accept it only when GitHub answers with the App that the install stores. The check SHALL need no installation of the App and SHALL use none. A key that GitHub does not accept, such as one of another App or one deleted on GitHub, SHALL be refused with 400 and SHALL NOT be stored, and the key in use SHALL stay. When GitHub fails the check or does not answer it within 10 seconds, the upload SHALL be refused with 502 and the problem type `integration-unavailable`, as the public-api capability's error model defines, SHALL store nothing, and SHALL leave the confirmation unused. Each stored key SHALL be recorded as a security event, as the activity-log capability defines.

Source: D37; D50 (2), (3), (13); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: A valid new key

- **WHEN** Ada, an admin, generates a new private key in the App's GitHub settings, uploads it and confirms the upload in the web UI
- **THEN** Tiehall stores the new key and uses it for its next call to GitHub
- **AND** the activity log gains a security event for the upload

#### Scenario: A key that fails the check

- **WHEN** Ada uploads, with the confirmation step, a private key that belongs to another GitHub App
- **THEN** the key is not stored
- **AND** Tiehall keeps calling GitHub with the key in use

#### Scenario: An upload without the confirmation step

- **WHEN** Ada uploads a new private key without confirming the upload in the web UI
- **THEN** the upload is refused with 403
- **AND** the key in use is unchanged

#### Scenario: A key checked with no connected installation

- **WHEN** no installation of the install's App is connected, and Ada uploads a new private key of the App with the confirmation step
- **THEN** Tiehall asks GitHub for the App with a JSON web token signed with the new key, and GitHub answers with the App
- **AND** Tiehall stores the new key and uses it for its next call to GitHub
- **AND** no installation token was requested for the check

#### Scenario: GitHub does not answer the check

- **WHEN** Ada uploads a new private key with the confirmation step, and GitHub does not answer the check within 10 seconds
- **THEN** the upload is refused with 502 and the problem type `integration-unavailable`
- **AND** the key in use is unchanged
- **AND** once GitHub answers again, confirming the same review page within its 5 minutes stores the key

#### Scenario: A key file outside its bounds

- **WHEN** Ada picks on the review page a file larger than 64 KB, or a file whose key has more than 16,384 characters, and confirms the upload
- **THEN** the upload is refused with 400, and GitHub is not asked
- **AND** the key in use is unchanged

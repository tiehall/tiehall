# Design: GitHub App reachability

## Context

[proposal.md](proposal.md) says why the install's GitHub App no longer always gets a webhook. This document restates the decision the deltas rest on, D49, as public rules with the alternatives that lost; states the rules the deltas carry from the spike of the main change's task 1.6; says how they are built; and records what stays open. It cites nothing outside this repository.

**What GitHub did (spike 1.6, run on 2026-09-28 on a personal account).** The main change's design.md keeps the record under Technical decisions: T16. The facts this change rests on:
- GitHub refused the manifest that S4 describes. A hook URL on `localhost` "isn't reachable over the public Internet", whether the hook is active or not. `installation` and `installation_repositories` are "unsupported" as default events, because a GitHub App receives them without subscribing. Subscribing to any event needs a hook URL: events without one got "Hook url cannot be blank".
- A refusal is a GitHub page ("Invalid GitHub App configuration") that has no way back to the install.
- GitHub accepted a manifest with no hook and no events, with the five permissions unchanged. The code conversion for that App returned `webhook_secret` as `null`, and the App's owner with its login and type.
- The installation made right after creation was listed by `GET /app/installations` with the App's own credentials, with no delivery at all, and with its repository selection. An installation token listed its repositories (`GET /installation/repositories`).
- An App without a webhook has no delivery log: `GET /app/hook/deliveries` answered 404.
- GitHub announced that installation tokens move to a format of about 520 characters.
- Not measured: what GitHub does with a hook URL on `127.0.0.1`, on `https://localhost`, on a private network address, or on a public name that does not resolve; which delivery follows the installation on a reachable URL; how a failed delivery shows in the log.

**Current state.** Most of the work this change touches is not built. Built, and changed by this change:
- the settings reader (the main change's task 5.1): the trial-URL check is inline in `installUrl` (`packages/commands/src/settings.ts`);
- the log redaction (4.14): `packages/commands/src/log.ts` finds GitHub tokens by a prefix followed by letters and digits only;
- the setup gate (7.1): it decides that "the App's credentials are stored" from the stored webhook secret (`packages/commands/src/setup-gate.ts`, `readSetupState`), which an App without a webhook never has; its test (`packages/commands/test/setup-gate.test.ts`) seeds only that secret, and its comments and those of `apps/web/proxy.ts` tie `/webhooks/github` to it and to the installation delivery;
- the setup route (7.2): `packages/commands/src/setup-route.ts`, whose next step becomes the App step;
- the committed lists of the confirmation coverage check (8.4, `tools/repo-checks/confirmation-actions.json`) and of the security-event coverage check (20.1, `tools/repo-checks/security-events.json`).

Not built: the GitHub stub (7.3), the manifest flow (7.4), the manifest allowlist test (7.5), setup completion (7.9), group 10 (webhooks, installations, modes and polling), `setup reopen` (21.2), the install docs (21.9) and the admin page's integration state (21.10) in M1, and close on merge (23.15) and the broken-installation banner (24.11) in M2.

**How the specs cite this document.** Every `Source:` line in `specs/*/spec.md` names the decision numbers the requirement rests on, then the sections of this document, as the main change's design.md describes. The sections are:
- **Decisions this change rests on** (`design.md, Decisions this change rests on`): D49, with the alternatives that lost, and the decisions carried from earlier changes.
- **Design rules** (`design.md, Design rules: …`): the rules the changed requirements state, in five sections: The webhook and the install URL; An App without a webhook; Finding installations; Moving to webhook mode; Installation tokens.
- **Rules carried from earlier changes** (`design.md, Rules carried from earlier changes`): the parts of the MODIFIED requirements that this change keeps as they are, whose sources stay in the main change's design.md and in spec-catch-up's.

**Constraints.**
- A trial install on one machine must complete setup on real GitHub (D36, D37; the main change's task 21.12 runs M1 that way).
- The setup screen cannot tell whether GitHub can reach an address that is not `localhost`, and operators often cannot tell either (S9).
- Nothing in the install path calls a service other than GitHub (S13): Tiehall cannot ask an outside prober whether its URL is reachable.
- A refused manifest ends on GitHub's page; only the operator can come back.

## Goals / Non-Goals

**Goals:**
- Setup completes on every URL the install accepts: a trial URL creates an App GitHub accepts, and any other URL has a way back when GitHub refuses the webhook.
- The manifest asks GitHub only for what GitHub accepts: no installation events, and no events without a webhook.
- An App without a webhook works fully in polling mode: setup, installations, covered repositories, intake and mode, with no delivery.
- An admin can move an App without a webhook to webhook mode later.
- Every later GitHub test runs against GitHub's recorded behavior.

**Non-Goals:**
- Deciding the default for a URL on a private network. It is measured first (this change's task 1.10), and a change to the default is its own change.
- Answering the delivery questions of spike 1.6 for a reachable URL, which need an install GitHub can reach.
- Changing which URLs the install accepts. The main change's R5 stays: `http://localhost`, with or without a port, is the only plain-HTTP URL, and `http://127.0.0.1` is not one.
- Setting an App's webhook through GitHub's API (Open Questions).

## Decisions

### Decisions this change rests on

- **D49. The setup screen decides the GitHub webhook from the install URL.** Taken by the maintainer on 2026-09-28, after spike 1.6. As public rules:
  - An install whose `TIEHALL_URL` is a trial URL on `localhost` creates its App with no webhook and no event subscriptions, and runs GitHub in polling mode from the start. The trial URLs are exactly those the main change's R5 accepts: `http://localhost`, with or without a port.
  - Any other URL gets the webhook as before, and S9's reachability check decides the mode as before.
  - The setup screen has an option, "GitHub cannot reach this address", that creates the App without a webhook, in polling mode.
  - Before the operator clicks, the setup screen says what to do if GitHub refuses the hook URL: come back to the setup screen, which the setup session keeps open, and choose that option.
  - What GitHub does with a hook URL on a private network is measured in a later session.
  - **Why.** GitHub refused every manifest whose hook URL was on `localhost`, whether the hook was active or not, and may refuse other hook URLs it cannot reach; a refusal leaves the operator on its error page with no way back. A trial install always hits that refusal, so without this rule no trial install can complete setup. For every other URL the webhook stays the default, because most installs that GitHub can reach should get changes at once, and S9 already falls back to polling when deliveries fail. The option is a way back, not a question every operator must answer: S9 dropped asking the operator up front, because operators often cannot tell.
  - **Alternatives that lost.**
    - *Every App without a webhook, and polling for everyone.* Simple, and GitHub never refuses it. But every install waits up to 2 minutes for every change, and turning webhooks on takes manual steps on GitHub.
    - *Measuring private-network behavior before deciding.* The `localhost` case is certain now and blocks trial installs; the private-network case can change the default later in its own change.

Carried, restated in the main change's design.md and not repeated here: D19, D23, D28 #1, #4, #48, D35, D36 and D37 (Decisions this change rests on there), and D45 (5) and (7), which spec-catch-up's design.md restates (Rules carried from earlier changes).

### Design rules: The webhook and the install URL

- **The trial URL.** A `TIEHALL_URL` is a trial URL when its scheme is `http` and its host is `localhost`, with or without a port: exactly the plain-HTTP URLs the install accepts (the main change's R5). `http://127.0.0.1` does not start, so it never reaches the setup screen. `https://localhost` is an HTTPS URL, not a trial URL, and gets the webhook by default (Open Questions).
- **The manifest without a webhook.** For a trial URL, and for any URL when the operator chooses the option, the manifest carries no `hook_attributes` and an empty `default_events` list, the form GitHub accepted in the spike. Its name, `url`, sign-in callback URL, redirect URL, `public: false` and `default_permissions` are the same as with a webhook.
- **The manifest with a webhook.** For any other URL without the option, the manifest carries `hook_attributes` with the URL `TIEHALL_URL/webhooks/github` and `active: true`, and `default_events` exactly `pull_request`, `issues` and `organization`.
- **Never the installation events.** No manifest lists `installation` or `installation_repositories`: every GitHub App receives them without subscribing, and GitHub refuses them as default events. An App with a webhook subscribes to the three events and receives the two installation events anyway; an App without a webhook subscribes to none and receives nothing by delivery. What those events would report reaches it by polling, by listing the App's installations and by reconciliation.
- **The permissions are the same either way.** `default_permissions` is exactly `metadata: read`, `pull_requests: read`, `issues: write`, `members: read` and `emails: read`, the keys GitHub kept in the spike. The three events need no permission beyond these, so moving to webhook mode later changes no permission.
- **The option.** The setup screen offers "GitHub cannot reach this address" for every URL that is not a trial URL. It is off by default. For a trial URL it is not offered, because the App gets no webhook anyway.
- **The text before the click.** On the App step, before the button that posts the manifest, the setup screen says:
  - for a trial URL: the App is created without a webhook, and GitHub changes reach Tiehall by polling, within 2 minutes;
  - for any other URL, without the option: GitHub may refuse the webhook URL if it cannot reach this address, and then shows its own error page, with no way back; in that case, open `TIEHALL_URL/setup` again in this browser, where the setup session is still open, and choose "GitHub cannot reach this address";
  - with the option: the App is created without a webhook, GitHub changes reach Tiehall by polling within 2 minutes, and an admin can move to webhook mode later from the admin page.
- **Coming back.** A setup session stays valid until setup completes (spec-catch-up, D45 (7)), so the operator who returns from GitHub's error page gets the App step again without the setup code. The refused manifest never came back with a code, so nothing was stored and a new attempt starts with a new `state`.

### Design rules: An App without a webhook

- **Stored credentials.** GitHub's conversion returns `webhook_secret: null` for an App without a webhook. Tiehall stores the App's id, slug, client id, client secret, private key and owner (its login, and whether it is an organization or a personal account, which the link to the App's settings on GitHub needs), and no webhook secret. An App "has a webhook" exactly when a webhook secret is stored: the conversion's secret for an App created with one, or a secret an admin stored later.
- **"The App's credentials are stored"** means the App's id, client credentials and private key are stored, with or without a webhook secret. From then on, `/webhooks/github` is served before setup completes, as S3 of the main change defines.
- **Refused deliveries.** While no webhook secret is stored, `/webhooks/github` refuses every delivery exactly as it refuses one whose signature does not verify: 401, and the delivery is neither stored nor processed. The main change's spec names no status for a failed signature; this change reads it as 401, the status for credentials that do not verify, and gives both cases the same answer (Readings to confirm, R1).
- **The mode when credentials are stored.** Storing an App's credentials sets GitHub's mode in the same write: polling without a webhook secret, webhook with one; S9's check then decides for an App with a webhook. This holds in setup and in a step that `setup reopen` opened: a new App with a webhook that replaces one without moves GitHub to webhook mode, and a new App without a webhook, which replaces the old App's credentials and so its webhook secret, moves GitHub to polling mode. The poller's first run comes when setup completes, as every GitHub job does, and at once after `setup reopen`.
- **No reachability check.** S9's check, which reads the delivery log after the first installation, runs only for an App that has a webhook at that time. An App without a webhook has no delivery log, and GitHub answers a request for it with 404. Tiehall does not ask for it, and if it does, a 404 is not a failed delivery: the mode stays as it is, no banner is shown and no admin is emailed. Redelivery of failed deliveries runs only in webhook mode, so never for such an App.

### Design rules: Finding installations

- **Listing, in both modes.** Tiehall finds the App's installations by listing them with the App's own credentials (`GET /app/installations` with an App token, page by page), whether or not the App has a webhook. An installation delivery is a hint that makes Tiehall list them again. It is never the only way Tiehall learns of an installation.
- **When.** When the sign-in that completes setup arrives; on each 60-second poll in polling mode; on each run of the 15-minute reconciliation job, in both modes, the job that also runs the sign-in capability's membership check; and when an `installation` or `installation_repositories` delivery arrives in webhook mode. So in polling mode a new installation shows on the admin page within 2 minutes, and in webhook mode an installation whose delivery was lost shows within 15 minutes.
- **Covered repositories and suspension.** Tiehall reads the repositories each connected installation covers with an installation token (`GET /installation/repositories`, page by page) when the installation is connected, at each poll in polling mode and at each run of the 15-minute reconciliation job in either mode; an `installation_repositories` delivery in webhook mode makes it read them again at once. An installation that the listing shows as suspended, or no longer holds, counts as suspended or deleted: it stops covering its repositories, and the banner for a broken integration follows. So covered repositories, suspension and deletion need no delivery either.
- **Setup completion.** The sign-in that completes setup connects every installation the list holds at that moment. The App is new and private, so only its owner can have installed it, during setup (Readings to confirm, R3). Completing setup waits for no delivery. If the list is empty, setup completes with nothing connected, and an admin connects an installation from the admin page later (Open Questions).
- **A reopened step.** A step that `setup reopen` opened and that closes with a new App connects every installation the new App's listing holds, for the same reason: that App is new. One that closes with the App in use connects none, so an installation an admin left unconnected or disconnected stays so (Readings to confirm, R3).

### Design rules: Moving to webhook mode

- **The steps.** While no webhook secret is stored and `TIEHALL_URL` is not a trial URL, the admin page shows GitHub's mode as polling, and these steps, with the install's own URL filled in and a link to the App's settings on GitHub:
  1. In the App's settings on GitHub, under Webhook, make the webhook active, set the webhook URL to `TIEHALL_URL/webhooks/github`, and set a webhook secret.
  2. Under Permissions and events, subscribe to Pull request, Issues and Organization. No permission changes.
  3. In Tiehall, enter the same secret and confirm it on the review page.
  4. Switch GitHub to webhook mode on the admin page, then check on GitHub's Advanced tab of the App that the next delivery succeeded.
- **A trial URL.** On a trial URL the admin page shows the polling mode and says that GitHub cannot deliver webhooks to it, with no steps, because GitHub refuses a hook URL on `localhost`.
- **Storing the secret.** Storing a webhook secret is an admin action in the web UI with the confirmation step, like uploading a rotated App key. A member who is not an admin gets 403 and an empty secret gets 400, and neither stores anything. The secret is encrypted under `TIEHALL_SECRET_KEY` like every stored integration secret, never shown again, and replaces any secret already stored. It is recorded as a security event for a changed integration. Because it replaces, the same action also serves an admin who changes the secret of an App created with a webhook (Readings to confirm, R4).
- **The secret stays out of URLs and pages.** The review page of the confirmation step takes the action's input from its URL and renders it. So the action's input holds no secret: the review names the action, storing a new webhook secret for the install's App and replacing any stored one, without the secret; the admin types the secret into a password field of the review page's form; and the secret travels only in the body of the POST that applies the action. It never appears in a URL, in the review page, or in any other page.
- **The switch.** The admin's switch is S9's manual switch. A switch to webhook mode is refused with 409 while no webhook secret is stored, because in webhook mode Tiehall stops polling and every delivery would be refused; the admin page does not offer it then (Readings to confirm, R2). After the switch, deliveries are verified with the stored secret, redelivery runs, and the 15-minute reconciliation goes on as in any webhook mode. The first-installation check is not run again (Open Questions).

### Design rules: Installation tokens

- **No assumed length.** Nothing assumes the length or the shape of an installation token: no column with a length limit, no length check, no parsing. GitHub is moving these tokens to a format of about 520 characters. The same holds for every GitHub token Tiehall handles briefly, such as the user token during sign-in, which it does not keep (sign-in capability).
- **The one exception is the log redaction.** It finds GitHub tokens by their prefix, such as `ghs_`, and keeps that match, but redacts the whole token whatever follows the prefix: any length, with `_`, `-` and `.` among its characters.

### Rules carried from earlier changes

The MODIFIED requirements keep every sentence and scenario they had, except where the design rules above change them, and add their new sentences and scenarios. The unchanged parts rest on the sources their original `Source:` lines cite, which stay restated where they were:
- in the main change's design.md: D19, D23, D28 #1, #4, #48, D35, D36 and D37 under "Decisions this change rests on"; the design rules for tracker mirrors, requests and events, and agent access; T16 under "Technical decisions"; and S3, S4, S5, S7, S9 and S14 under "Self-hosting decisions";
- in spec-catch-up's design.md: D45 (5) and (7), which the requirement "Setup names the company and makes the first admin" carries as spec-catch-up states it: the org has no name until setup names it, setup records the time it completed, and every setup session stops working when it does.

### Technical decisions

#### T1. One trial-URL check

- **Choice.** The check inline in `installUrl` (`packages/commands/src/settings.ts`) becomes an exported `isTrialUrl(origin)`, used by the settings reader and the manifest builder. The setup session's cookie keeps keying on HTTPS (`setup-route.ts`): a trial URL gets a plain cookie because it is not HTTPS, and every HTTPS URL gets the `__Host-` cookie with `Secure`.
- **Why.** D49's `localhost` rule applies to exactly the URLs the main change's R5 accepts. One function keeps the two sets the same. The cookie follows the scheme, not the trial rule, so a test origin that is neither HTTPS nor a trial URL never gets a `__Host-` cookie without `Secure`.
- **Alternatives.** A second check in the manifest builder, which could drift from the settings reader, for example on `http://LOCALHOST:3000`, which URL parsing lowercases.

#### T2. The manifest builder is a pure function

- **Choice.** One function builds the manifest from the install's URL, the App's name, whether the option is chosen, and the permissions and events that one constant table holds. The setup screen, the manifest tests and the allowlist test of the main change's task 7.5 all read it.
- **Why.** The allowlist test then checks the manifest that setup really posts, in both forms.
- **Alternatives.** Building the manifest inside the route handler, which the allowlist test cannot call without a browser.

#### T3. The setup gate reads the App's private key

- **Choice.** `readSetupState` decides "the App's credentials are stored" from the stored `github_app.private_key`, not from `github_app.webhook_secret`. `/webhooks/github` reads the webhook secret itself, and answers 401 when there is none.
- **Why.** An App without a webhook never has a webhook secret, but it always has a private key, which every call to GitHub needs.
- **Alternatives.** A separate "App created" flag, which is one more row to keep in step with the credentials.

#### T4. The GitHub stub carries GitHub's refusals

- **Choice.** The stub of the main change's task 7.3 answers as GitHub did in the spike, and its contract tests replay the spike's recorded requests and answers, committed as fixtures with the founder's login and ids replaced by example ones. It shows an "Invalid GitHub App configuration" page with GitHub's messages for a hook URL on `localhost`, active or not; for `installation` or `installation_repositories` among the default events; and for events without a hook URL. It accepts a manifest with no hook and no events, and its conversion returns `webhook_secret: null` for that App. It answers 404 to the delivery log of an App without a webhook. It lists installations at `GET /app/installations` for an App token, with a suspended one marked, and an installation's repositories at `GET /installation/repositories` for an installation token, both paged as GitHub documents (`per_page` 30 by default and at most 100, with a `Link` header to the next page). A test can suspend, unsuspend or delete an installation and change its repositories, with or without the delivery GitHub would send. It issues installation tokens of 520 characters by default. A test can name further hook URLs the stub refuses as unreachable, to play a private address GitHub cannot reach.
- **Why.** Every later GitHub test then runs against the behavior GitHub showed, not the behavior the plan assumed.
- **Alternatives.** Recording only the successful round trip, which would let a manifest GitHub refuses pass every test.

#### T5. Listing installations and caching tokens

- **Choice.** The GitHub module lists installations with an App token whose issuer is the client id, as in the spike, with `per_page=100`, following the `Link` header, and keeps the result in a table of known installations (id, account login, account type, repository selection, suspended), which the admin page reads; a migration adds it. Connected installations stay in their own table (T16 of the main change). The repositories of each connected installation are read with an installation token and kept as the covered repositories that the main change's task 10.4 keeps. Installation tokens are cached in memory by the GitHub client until shortly before they expire, and never stored in the database: no column or catalog schema holds one.
- **Why.** One listing serves setup, the admin page, polling and reconciliation. An in-memory token cache holds no token at rest and has no column that could cut one.
- **Alternatives.** Storing installations and their repositories only from deliveries, which fails on an App without a webhook. Storing tokens in a table, which puts short-lived credentials at rest for no gain.

### Where the specs leave room

- The wording of the setup screen's texts and of the steps on the admin page, as long as each says what the rules above name.
- The body of the 401 that `/webhooks/github` answers.
- Whether the admin page offers a random value to copy as the webhook secret.
- How often, beyond the times the rules name, Tiehall lists installations and their repositories.

## Risks / Trade-offs

- [GitHub also refuses hook URLs on private networks, so every internal install with a webhook first lands on GitHub's error page] → The text before the click gives the way back, and the setup session stays open. This change's task 1.10 measures it, and if GitHub refuses them, the default for such URLs is reconsidered in its own change.
- [An operator chooses the option on an install that GitHub could reach, and never moves to webhook mode] → Polling picks up every change within 2 minutes, and the admin page shows the mode and the steps.
- [An admin stores a secret that differs from the one on GitHub, and switches to webhook mode] → Every delivery is refused with 401. GitHub's delivery log shows the failures, and the last step on the admin page tells the admin to check it. Whether Tiehall should check the log itself after the switch is open.
- [GitHub changes its messages or its rules] → The stub carries today's messages from the record. The real-GitHub run of the main change's task 21.12 and the probe of this change's task 1.10 would show a change.
- [The option lets an operator skip webhooks for no reason] → It is off by default, and the text says what it costs: changes within 2 minutes instead of at once.
- [Listing installations and their repositories costs GitHub API calls on every poll] → The calls use the App's and the installations' own rate limits, and conditional requests, as polling already does (S9).

## Migration Plan

No install exists yet, so nothing is migrated. The built parts that change are the settings reader (5.1), the log redaction (4.14), the setup gate (7.1), which reads the App's private key instead of the webhook secret, the setup route (7.2), and the committed lists of the confirmation and security-event coverage checks (8.4, 20.1); their tests change with them.

The coverage checks read the list of "Actions that need the confirmation step" from the first active change that holds it, by name: `add-tiehall-oss-v1` until it is archived. So the commit that builds the action of storing a webhook secret adds it, with its `confirm` command and an input, under the existing item for connecting a GitHub installation in `tools/repo-checks/confirmation-actions.json`, and adds "the GitHub App's webhook secret stored", with its event type and test, under the item for integrations in `tools/repo-checks/security-events.json`. The action cannot be marked pending, because no task of the plan the check reads builds it. The item's text stays the main change's bullet until the commit that archives `add-tiehall-oss-v1`, which changes it to this change's bullet.

This change is archived after `add-tiehall-oss-v1`, whose requirements it modifies, and after `spec-catch-up`, which modifies "Setup names the company and makes the first admin" too, and whose version of "The setup code guards the setup screen" states that a setup session stays valid until setup completes, which the way back relies on. This change's text of the first requirement includes spec-catch-up's, so archiving in that order keeps both.

## Open Questions

- **Hook URLs on a private network.** Not measured: GitHub's answer to a hook URL on `127.0.0.1`, on `https://localhost`, on a private address such as `10.0.0.5`, on a public name that does not resolve, and on a public name that resolves to a private address. This change's task 1.10 measures them. If GitHub refuses the private cases, the default for such URLs is reconsidered in its own change.
- **Event subscriptions added later.** Whether GitHub asks existing installations to approve anything when an App without a webhook subscribes to the three events later. The events need no new permission, so no approval is expected. This change's task 1.10 measures it.
- **Setting the webhook through GitHub's API.** GitHub's API can change an App's webhook configuration with the App's own credentials. Whether it can add a webhook to an App created without one, and subscribe it to events, was not measured. If it can, Tiehall could do steps 1 and 2 itself in a later change.
- **`https://localhost`.** It is not a trial URL under the main change's R5, so it gets the webhook by default. GitHub is expected to refuse it, as it refused `http://localhost:4780`; this change's task 1.10 checks it. The operator then comes back and chooses the option. Whether the `localhost` rule should cover it is open.
- **No installation when setup completes.** Setup completes with nothing connected when the list is empty. Whether the setup screen should hold the sign-in step until it finds an installation is open.
- **The delivery log after a move to webhook mode.** Whether Tiehall reads the delivery log after an admin's switch, as it does after the first installation of an App created with a webhook, and falls back to polling on a failed delivery. Today the switch is the admin's decision.
- **A rotated key in the review page's URL.** The review page takes the action's input from its URL. The main change's task 10.10, the upload of a rotated App key, has the same gap this change closes for the webhook secret: a key passed as the action's input would sit in the URL and in the page. It is recorded here and left to that task, which this change does not modify.
- **Still open from spike 1.6** and kept in the main change's Open Questions: which delivery follows the installation on a reachable URL, how a failed delivery shows in the log, and the organization-only checks.
- **The admin list in teams-and-roles.** "What admins and members may do" names GitHub installations and the App's private key among the integrations admins configure. This change reads "configure integrations" as covering the webhook secret too, as it covers the mode switch, which that list does not name either; the tracker-mirrors requirement on the modes states the 403 for a member. It does not modify that requirement, which spec-catch-up modifies.

## Readings to confirm with the founder

No decision settles the points below. The specs apply the narrowest reading of each, and each can change in review without changing the approach.

- **R1. The status of a refused delivery** (D49). Reading: a delivery that fails verification, and every delivery while no webhook secret is stored, gets 401 and is neither stored nor processed. The main change named no status. Specs: tracker-mirrors.
- **R2. The switch to webhook mode needs a stored secret** (D49; S9). Reading: the switch is refused with 409 while no webhook secret is stored, and the admin page does not offer it. Specs: tracker-mirrors.
- **R3. The installations made during setup** (D49; S3). Reading: every installation that listing returns when the sign-in completes setup, because the new App is private; in a step that `setup reopen` opened, every installation the new App's listing returns when the step closes with a new App, and none when it closes with the App in use. Specs: self-host-install, tracker-mirrors.
- **R4. Storing a webhook secret replaces one** (D49; S7). Reading: the action stores or replaces the App's webhook secret, with the confirmation step and as a security event for a changed integration, whether or not the App was created with a webhook. Specs: tracker-mirrors, agent-safety.

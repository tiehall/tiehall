# GitHub and Jira

Tiehall sits beside GitHub and Jira: it links pull requests to requests, closes a request when its pull request merges, and mirrors requests into a team's tracker. This page is for admins. It covers the install's GitHub App and its installations, how changes on GitHub reach the install, the mirrors, and Jira Cloud. [Installing and running Tiehall](install.md) covers creating the App on the setup screen.

## GitHub

Each install has its own GitHub App, which the setup screen creates through GitHub's manifest flow. The one App serves sign-in, pull request links, close on merge, the GitHub Issues mirror, and the checks of who belongs to the company's GitHub organization. It asks GitHub for narrow permissions, and for none on the contents of repositories, so Tiehall never reads your code. Everything Tiehall writes on GitHub appears as the App's bot. Tiehall calls GitHub with the App's own credentials, never with a token an agent presented, and keeps no person's GitHub token after they sign in.

The GitHub page of the admin UI, `/admin/github`, lists every installation of the App that GitHub reports. Tiehall acts only on the installations an admin has connected there, with the confirmation step; it ignores the others, which is how an admin ignores one, and an admin can disconnect one without the confirmation step. The covered repositories are those a connected installation covers, as its selection of repositories on GitHub stands: pull request links, close on merge and the mirrors work only in them, and an API for contract reports can be registered only for one of them. The App is private by default, so it can be installed only on the account that owns it; a company with several GitHub organizations makes it public in its settings on GitHub and installs it on each.

After you generate a new private key in the App's settings on GitHub, upload it from the same page, with the confirmation step: Tiehall checks the key with GitHub before it stores it, and keeps the old one in use when the check fails. When the App's credentials leak or the App is deleted, the operator creates a new one on the host with `admin setup reopen`, as [the install docs](install.md#commands-on-the-host) show.

**Pull requests.** Someone links a pull request to a request with `link_pr` or `tiehall link-pr`, by its URL. When a pull request in a covered repository merges after the request was claimed, and it was linked to the request by its claimant or a member of its target team, or its title, its description or its branch name mentioned the request's key as Tiehall writes it, such as `FE-142`, before it merged, close on merge marks the request done, as a system action that needs no confirmation. A key in lower case, such as `fe-142`, or inside a longer word, mentions nothing, so a branch such as `renovate/node-22` closes no request; and a link that someone else made, such as the requester, is shown on the request, but its merge closes nothing, until the claimant or a member of the target team links the same pull request before it merges. Linking a pull request that has already merged proposes done instead, for a person to confirm.

## Webhook and polling modes

Changes on GitHub reach the install in one of two modes, which the GitHub page shows:

- In webhook mode, GitHub delivers each change to `TIEHALL_URL/webhooks/github` as it happens. Tiehall checks each delivery's signature with the App's webhook secret, stores it once, and handles it in the background; failed deliveries are asked for again every 10 to 15 minutes.
- In polling mode, for an install GitHub cannot reach, Tiehall asks GitHub for changes every 60 seconds, so each change reaches the install within 2 minutes.

In either mode, a reconciliation every 15 minutes finds what was missed. An App created on a trial URL has no webhook and runs in polling mode; an App with a webhook falls back to polling mode when GitHub cannot deliver to the install, or when its webhook was removed in the App's settings on GitHub, and the admin page says so, with a banner to the admins and to the teams whose mirrors go through GitHub. An admin can switch the mode on the GitHub page. Moving an App without a webhook to webhook mode takes four steps, which the page shows and [the install docs](install.md#githubs-modes-webhook-or-polling) list: make the App's webhook active with its URL and a Webhook secret in its settings on GitHub, subscribe it to the events Pull request, Issues and Organization, store the same secret on the GitHub page with the confirmation step, and switch the mode.

## Mirrors

A team's requests can be mirrored into GitHub Issues, so the team sees them in the tracker it already uses. An admin maps the team to one intake repository, among the covered repositories, on `/admin/teams`. Each team mirrors into one tracker only.

- A mirror issue is created on claim by default, or when the request is opened, if the admin ticks that for the team.
- An issue holds the request's title, a summary Tiehall writes from its own templates, a link to the request and a label for its state; never the packet or the thread, which stay in Tiehall. Anyone can read the issues of a public repository, so `/admin/teams` marks the covered repositories GitHub reports public, and warns about a team whose intake repository is one. Each change of state, and each question, adds one comment, and a request that ends closes its issue.
- When a request is reassigned to another team, its old issue gets a notice and is closed as not planned, and the new team's mapping takes over.
- Changes people make to an issue, such as closing it, reopening it or assigning it, are recorded on the request and change nothing there. Comments on the issue are not imported. When the team has turned the setting on, a close of the issue by a member of the target team proposes done, for that person to confirm; otherwise it adds a notice. A close as not planned, or as a duplicate, is no work done: it is only recorded.
- A mirror job that keeps failing, after 5 attempts over about an hour, is shown in a banner to the admins and the team, with a Retry button. Banners on the admin page also say when an installation is suspended or another integration breaks.

The mirror plays no part in close on merge: a request is done when its own pull request merges, whatever happens to its issue.

## Jira Cloud

The Jira Cloud mirror is not in this version yet. When it comes, an admin connects one Jira Cloud site through a dedicated bot account's API token, and maps each team that uses Jira to a project; this page will then describe connecting it, its webhooks and its polling mode. Until then the admin page says that no Jira site is connected, and each team mirrors into GitHub Issues or nowhere.

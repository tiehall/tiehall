# Contract changes

When a backend team changes an OpenAPI contract in a breaking way, the teams that consume the API should hear of it from the pull request that makes the change, not from a broken build. Tiehall does this with three pieces: APIs that admins register, a consumer map in which teams declare the APIs they consume, and a GitHub Action in the provider's CI that classifies each pull request's changes and reports them. Tiehall then opens a request to each consuming team. The diff runs only in your CI and on developers' machines: Tiehall never fetches, receives or reads an OpenAPI document, and its GitHub App has no access to the contents of repositories.

## Registering an API

An admin registers each API on `/admin/apis`: its name, such as `payments-api`, its provider team, and the one GitHub repository it lives in, which a connected installation of the GitHub App must cover. The admin may also bind it to one workflow of that repository, by the path of its workflow file, such as `acme/payments/.github/workflows/contract.yml`, without a ref: runs of that workflow from any branch or pull request may then report. Registering takes effect on its review page, with the confirmation step, and is recorded in the activity log.

The install then takes a report for the API only from a CI run in that repository, and, when the API is bound to a workflow, only from that workflow, authenticated with the run's GitHub Actions OIDC token; a run anywhere else is refused with 403, and so is a report that a run for a pull request sends about another pull request. An admin can unregister an API on the same page, without the confirmation step; its requests stay. To change an API's provider team, repository or workflow, an admin unregisters it and registers it again: registered again for the same team and repository, it keeps the teams' declarations that they consume it; registered for another team or repository, it is a new API, which the consuming teams declare again. Each API also has a WARN switch, which an admin turns on or off on `/admin/apis`, and a member of the provider team on the team's page: off by default, it sends potentially breaking changes to a daily digest, and on, it opens requests for them as for breaking changes.

## The consumer map

Each team declares the registered APIs it consumes, on its page in the web UI, `/teams/apis`; any member of the team can declare an API or remove the team's declaration, and nobody else can. Tiehall routes contract changes only by these declarations. Every declaration, removal and re-confirmation is recorded in the activity log, with who made it, so an admin can tell why a team started or stopped getting requests.

Because the map is kept by hand, it can go stale, so Tiehall asks the team to re-confirm each declaration 90 days after it was last confirmed: the request waits in the standing list of each member's web inbox, and goes by email once when the install sends email. Any member of the team re-confirms it there. A declaration left unconfirmed 30 more days is marked stale until someone re-confirms it, and keeps routing meanwhile.

How a report reaches the consuming teams depends on each change's level, as the diff engine classifies it:

- Breaking (ERR) changes open one request to each consuming team, with the classified changes in the packet's contract section; a later report for the same pull request updates those requests rather than opening new ones.
- Potentially breaking (WARN) changes go to each consuming team's daily digest, in the standing list of its members' web inboxes and by email to those who keep the daily digest on, unless the API's WARN switch is on.
- Informational (INFO) changes only appear in the change list of requests that exist already.

One pull request opens requests to at most 10 consuming teams at once; when more teams consume the API, the first 10 are opened and the rest wait until an admin confirms them, with the confirmation step, from the banner the admins see.

## The contract Action

The Action, in [`actions/contract/`](../actions/contract) under Apache-2.0, runs in the provider's CI on pull requests. It installs the pinned diff engine, oasdiff, checks the downloaded binary against its pinned checksum before it runs it, computes the breaking changes and the changelog between the pull request's base and head, and reports them with a pinned `tiehall` CLI. It never uploads the OpenAPI document. [Its README](../actions/contract/README.md) has the example workflow and every input.

- **Pin it by commit SHA, with a version comment**, such as `uses: <owner>/Tiehall/actions/contract@<commit SHA> # v0.1.0`, as every action should be: a tag can be moved, a commit cannot, and the comment lets Renovate and Dependabot propose the next release. Each release's notes give that line with the commit the release's tag points to.
- **Give the job `id-token: write`.** The Action reports to the install its `install-url` input names, with the run's GitHub Actions OIDC token, whose audience is that URL, and the install accepts only a token whose audience is its own URL. With `pull-requests: write`, the Action also keeps a comment on the pull request when the provider team, rather than its author, is the requester.
- **Mind where the runner is.** A workflow on a GitHub-hosted runner needs an install that is reachable from the internet. For an install that is reachable only inside your company network, run the workflow on a self-hosted runner inside that network.
- **It fails open.** When the runner cannot reach the install, or the install cannot take the report, the job still succeeds, and a warning says that nothing was delivered; when the install refuses the report, as too large or with more than 1,000 changes, the warning says that no consuming team was told. A blocked download of oasdiff, a document with external `$ref`s, which the Action does not follow, and a pull request that deletes the document end the job successfully too, with a warning and the job summary saying that no diff was computed. Only an oasdiff download whose checksum is not the pinned one fails the step. Breaking changes do not fail the check either, unless the workflow sets the input `fail-on-breaking: true`. Draft pull requests are skipped until they are marked ready for review, unless the workflow sets `include-drafts: true`.

## What the consuming teams get

The requests come from the pull request's author when their GitHub account belongs to a member of the install, with the provider team as the requesting team, so the consuming teams' questions reach the author; otherwise the provider team is the requester, and the Action says so in its comment on the pull request. A consuming team's agent pulls the request like any other, with the classified changes in its packet.

While the pull request is open, each new report, with reports that arrive within 2 minutes of each other merged into one, adds a revision to the packet of every request it touches, and a message in Tiehall's words to its thread, unless its classified changes are the same as the last report's: a rerun of the workflow, or a push that leaves the API alone, adds nothing. When the breaking changes disappear, or the pull request closes without merging, the requests nobody has claimed are withdrawn, and the claimed ones get a notice. When the pull request merges, the change is marked shipped and the mirrors are updated, but no request is closed: each consuming team closes its own, with its own pull request, as close on merge does for any request.

## Attaching a diff by hand

A developer can classify a change on their own machine and attach it to a request as its contract section, with oasdiff on their `PATH`:

```sh
tiehall get FE-142
tiehall contract diff --api payments-api --spec openapi/payments.yaml --base main --pull-request 310 --attach FE-142 --if-match 3
```

`--pull-request` names the provider pull request that makes the change, which the contract section names, in the repository of the git remote `origin` unless `--repository` names another; without it, as for two refs that no pull request holds yet, the section names no pull request and no provider status. `--if-match` names the revision of the request's packet you expect to be current, as `tiehall get FE-142` shows it: an attachment without it, or with a revision that is no longer current, is refused and changes nothing, so read the request again and run the command with its revision. The diff runs between `--base` and `HEAD`, unless `--head` names another ref. This needs a token with the `contracts:report` scope, routes nothing to the API's consumers, and, while the request is claimed, becomes a proposal like any other change of scope.

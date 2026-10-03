# Tiehall contract check

A GitHub Action that finds the breaking changes a pull request makes to an OpenAPI document, with a pinned [oasdiff](https://github.com/oasdiff/oasdiff), and reports them to your Tiehall install. Tiehall then opens a request to each team that declared it consumes the API. Licensed under Apache-2.0.

The Action runs in your own CI. It sends Tiehall the API's name, the pull request, the base and head refs with their commit SHAs, the diff engine's name and version, and the classified changes. It never sends the OpenAPI document, to Tiehall or anywhere else.

## Usage

An admin registers the API in Tiehall first, bound to this repository. Then add a workflow such as this one:

```yaml
name: Contract check

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  # The run's OpenID Connect token, which proves to Tiehall which repository and workflow report.
  id-token: write
  # The comment the Action keeps on the pull request when its author is not a member of the Tiehall install.
  pull-requests: write

jobs:
  contract:
    runs-on: ubuntu-24.04
    # One run at a time for this API on a pull request: a newer push cancels the older run.
    concurrency:
      group: tiehall-contract-payments-api-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # The pull request's history back to where it branched off its base branch, which the Action compares with its head.
          fetch-depth: 0
          persist-credentials: false
      # The commit of the release you pin, with the release as a comment, so dependency-update tools can bump both.
      - uses: muhmmdcnkl/Tiehall/actions/contract@9c4e2b7a1f3d5e8c6b0a2d4f7e9c1b3a5d7f9e2c # v0.1.0
        with:
          install-url: https://tiehall.example.com
          api: payments-api
          spec: openapi/payments.yaml
```

Pin the Action by its full commit SHA, as every action should be: a tag can be moved, a commit cannot. The comment after it names the release, which lets Renovate and Dependabot propose the next one.

## Inputs

| Input | Required | What it is |
| --- | --- | --- |
| `install-url` | yes | Your Tiehall install's URL, such as `https://tiehall.example.com`. The report goes there alone, with a GitHub Actions OIDC token whose audience is this URL, so the job needs `id-token: write`. |
| `api` | yes | The registered API the document describes, as an admin registered it in Tiehall for this repository. |
| `spec` | yes | The API's OpenAPI document in the repository, relative to its root. |
| `fail-on-breaking` | no | `true` fails the step when the pull request makes breaking (ERR-level) changes. `false` by default: breaking changes alone never fail the check. |
| `include-drafts` | no | `true` checks draft pull requests too. `false` by default: a draft is checked once it is marked ready for review. |
| `github-token` | no | The token the Action comments on the pull request with, when the provider team is the requester; the workflow's own `GITHUB_TOKEN` by default, which needs `pull-requests: write`. |

The Action runs on `pull_request` events of the types `opened`, `synchronize`, `reopened` and `ready_for_review`, and skips any other.

## Who requests the changes

The requests Tiehall opens to the consuming teams come from the author of the pull request, when the GitHub account that opened it belongs to a member of the Tiehall install, with the API's provider team as the requesting team; the consuming teams' questions then reach the author. Otherwise the provider team alone is the requester, its members answer the questions, and the Action says so in a comment on the pull request. It posts that comment once per pull request and updates it in place on later runs; a workflow that checks several APIs on the pull request keeps one comment with a part per API, each showing its latest report. Runs for several APIs at the same moment, in jobs of their own, keep that one comment too: each run reads the comment again a few seconds after writing it, and writes its part again when another run's write dropped it. Give each API's job a concurrency group of its own on the pull request, as the example does, so that a newer push cancels the older run for that API rather than running beside it. Without `pull-requests: write`, the Action skips the comment with a warning.

## Where the runner must be

The runner sends the report to your install, so it must be able to reach it:

- A workflow on a GitHub-hosted runner needs an install that is reachable from the internet, at the URL in `install-url`.
- For an install that is reachable only inside your company network, run the workflow on a self-hosted runner inside that network, with `runs-on` naming that runner's labels.

## When Tiehall cannot take the report

The Action fails open: it never fails the check because Tiehall could not take its report. When the runner cannot reach the install, when the install answers with an error, or while it restarts for an upgrade, the job succeeds, and a warning and the job summary say that the report was not delivered; the next run reports again. When the install needs a newer `tiehall` CLI than the one this release of the Action pins, the warning and the job summary say so: pin a newer release of the Action. With `fail-on-breaking: true`, the check still fails for breaking changes when the install cannot be reached, because that result comes from the diff the Action computed, not from Tiehall.

## What it runs

The Action runs its source on the runner's own Node.js 24, with nothing to build. Each run downloads the pinned oasdiff release from GitHub and checks the archive against its pinned SHA-256 before it extracts or runs anything from it; a binary that is not the pinned one never runs. oasdiff compares the document at the pull request's head commit with the document at the commit the pull request branched off its base branch, their merge base, as GitHub's own diff of a pull request does, so a change the base branch made since is not taken for the pull request's; it runs with external `$refs` off, in the runner's temporary folder, which the Action removes afterwards. The pinned `tiehall` CLI reports the result, with `npx`, so the runner needs Node.js with npm on its `PATH`, as GitHub-hosted runners have.

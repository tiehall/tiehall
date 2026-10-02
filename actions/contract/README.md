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

jobs:
  contract:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # The pull request's base and head commits, which the Action compares.
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

The Action runs on `pull_request` events of the types `opened`, `synchronize`, `reopened` and `ready_for_review`, and skips any other.

## Where the runner must be

The runner sends the report to your install, so it must be able to reach it:

- A workflow on a GitHub-hosted runner needs an install that is reachable from the internet, at the URL in `install-url`.
- For an install that is reachable only inside your company network, run the workflow on a self-hosted runner inside that network, with `runs-on` naming that runner's labels.

## When Tiehall cannot take the report

The Action fails open: it never fails the check because Tiehall could not take its report. When the runner cannot reach the install, when the install answers with an error, or while it restarts for an upgrade, the job succeeds, and a warning and the job summary say that the report was not delivered; the next run reports again. When the install needs a newer `tiehall` CLI than the one this release of the Action pins, the warning and the job summary say so: pin a newer release of the Action. With `fail-on-breaking: true`, the check still fails for breaking changes when the install cannot be reached, because that result comes from the diff the Action computed, not from Tiehall.

## What it runs

The Action runs its source on the runner's own Node.js 24, with nothing to build. Each run downloads the pinned oasdiff release from GitHub and checks the archive against its pinned SHA-256 before it extracts or runs anything from it; a binary that is not the pinned one never runs. oasdiff compares the document at the pull request's base and head commits, with external `$refs` off, in the runner's temporary folder, which the Action removes afterwards. The pinned `tiehall` CLI reports the result, with `npx`, so the runner needs Node.js with npm on its `PATH`, as GitHub-hosted runners have.

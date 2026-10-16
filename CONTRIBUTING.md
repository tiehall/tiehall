# Contributing to Tiehall

Thank you for helping. This guide covers how the repository is built and tested, how a change is planned before it is built, which license each directory carries, the rules that keep the public API and the MCP tools stable, why no package may depend on a model SDK, and how the maintainers test Tiehall against real agent clients.

Report a security problem privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue or pull request.

Start with the [README](README.md), then the change in progress, [`openspec/changes/add-tiehall-oss-v1`](openspec/changes/add-tiehall-oss-v1): its [proposal](openspec/changes/add-tiehall-oss-v1/proposal.md) says why, its [design](openspec/changes/add-tiehall-oss-v1/design.md) holds every decision the specs rest on and how Tiehall is built, its [specs](openspec/changes/add-tiehall-oss-v1/specs) hold one behavior contract per capability, and its [tasks](openspec/changes/add-tiehall-oss-v1/tasks.md) hold the plan by milestone. Everything in the repository, code, docs and commit messages, is in English. It refers to people as they and them, never with a gendered pronoun; `pnpm test` fails on one in a TypeScript or Markdown file outside `openspec/` and the tests' fixtures.

## Building and testing

Tiehall is one TypeScript monorepo: the Next.js web app and the server's roles in `apps/`, the packages in `packages/`, the contract Action in `actions/contract/`, and the repository's checks and the container tests in `tools/`. You need:

- Node.js at the version in [`.node-version`](.node-version), and pnpm at the version `packageManager` names in [`package.json`](package.json).
- Docker, for the tests that run Postgres 17 in a container, and for the image's own tests.
- Google Chrome, for the few tests that drive a browser through `playwright-core`; no test downloads a browser. On a machine without Chrome, set `TIEHALL_TEST_CHROME` to another Chromium-based browser's executable.

Install the dependencies from the committed lockfile, then typecheck and test:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

`pnpm test` runs every package's Vitest suite, the repository's checks among them; the database tests start their own Postgres 17 container through Testcontainers. The tests of the image are apart, because they need a built image: `pnpm test:image` runs the container tests against `TIEHALL_IMAGE`, or against a local build of the checkout when it is unset, and `pnpm test:install <name>` runs one of the operator tests in `tools/image-tests/test/install/`, which start a whole install with Docker Compose, such as `pnpm test:install fresh-install`. CI also runs the checks one by one:

```sh
pnpm lint:deps
pnpm lint:migrations
pnpm check:licenses
pnpm check:public-paths
pnpm check:model-sdks
pnpm check:openapi
pnpm check:mcp-tools
pnpm check:packet-schema
pnpm check:packet-forward
pnpm check:packet-releases
pnpm check:client
pnpm check:plugin
pnpm check:confirmations
pnpm check:security-events
pnpm check:error-model
```

`pnpm check:public-paths` fails on a tracked file outside [`tools/repo-checks/public-paths.json`](tools/repo-checks/public-paths.json), the allowlist of the paths the repository holds, and on a `.gitignore` that no longer ignores `private/`. A file in a folder the allowlist already holds whole, such as `packages/` or `openspec/changes/`, needs nothing; a new file at the root or a new folder needs a pattern there, which is reviewed like any change that makes more of the repository public.

Some files are generated, committed, and compared by CI with what the code generates: the OpenAPI document `openapi/v1.json`, the MCP tool snapshot `mcp/tools.json`, the packet schema `packages/packet/schema/v1-beta.json` with the packet's types `packages/packet/src/types.ts`, and the generated part of `@tiehall/client`. When a change touches an operation, a tool or the packet, regenerate them and commit them with it:

```sh
pnpm openapi:generate
pnpm mcp:generate
pnpm packet:generate
pnpm client:generate
```

The web UI's assets, in `packages/commands/assets/`, are named in every page by digests of their content, which `packages/commands/src/asset-digests.ts` holds: after changing an asset, run `pnpm assets:digests`, and after changing the mark's drawing, `pnpm icons:generate`, which renders the icons in the installed Chrome and writes the digests again, and `pnpm brand:generate`, which draws the mark, the organization's avatar and the social preview into [`docs/assets/brand/`](docs/assets/brand) for the README and GitHub; commit what they write. A test fails when the digests are stale. The screenshot tests, `packages/commands/test/screens-browser.test.ts`, save a screenshot of every page of the web UI at three sizes in the light and the dark color scheme under `test-results/screens/`, which git ignores, and CI keeps each test shard's as an artifact of its run, `screens-1`, `screens-2` and `screens-3`. No test compares them with stored images, since each system draws text in its own font: look at them when a change alters how a page looks.

The landing page for `tiehall.com` is the folder [`site/`](site): plain HTML and CSS with no script and no build step, which loads nothing from another host but the film's player, from YouTube, once a visitor starts the film, and which [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes on GitHub Pages from the public repository. Open `site/index.html` in a browser to preview it. Its images are copies of the brand's images and the film's poster, which [`tools/repo-checks/test/site.test.ts`](tools/repo-checks/test/site.test.ts) holds to their sources byte for byte, so copy them again after `pnpm brand:generate`; the same test checks every link and meta tag, the allowlist and the contrast of each color.

Dependencies are pinned to exact versions, and the lockfile is committed. pnpm resolves only versions published at least 7 days ago (`minimumReleaseAge` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml)), the same age Renovate waits for, and Renovate's updates are never merged automatically. A dependency's install script runs only when `allowBuilds` in that file lists it.

A version younger than 7 days comes in only through a reviewed exception, of which there are two kinds. A security fix is one: when the image scan reports a fixable HIGH or CRITICAL finding in an npm package and the fixed version is younger than 7 days, a pull request may take exactly the version the advisory names as fixed, after review and never automatically. It adds `<package>@<version>` to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, records the exception in [`tools/repo-checks/release-age-exceptions.json`](tools/repo-checks/release-age-exceptions.json) with the package, the version, the advisory, the label and the day the version turns 7 days old, and carries the `release-age-exception` label, which the API compatibility workflow requires of a pull request that adds an exclusion. `pnpm check:workflows` fails an exclusion that names more than one exact version, one the list does not record, and one whose day has passed, so a later pull request removes the exclusion and its record once the version is 7 days old. The release notes list the exceptions a release carries.

An update that a maintainer's recorded answer calls for is the other kind: a pull request may take exactly each version the update brings, once a supply-chain review of that version comes out clean, after review and never automatically. Its record names, in place of the advisory, the answer, by the day the answer was given and where it is recorded (`answer`, with `day` and `recordedIn`), and the review, by its day and where it is recorded, with what it compared, the version's provenance, its install scripts and its dependencies (`review`, with `day`, `recordedIn`, `compared`, `provenance`, `scripts` and `dependencies`); a record names an advisory or an answer, never both, and `pnpm check:workflows` fails one that names neither or misses a part. Everything else is as for a security fix: one exclusion for each version, the `release-age-exception` label, the day the version turns 7 days old, and a line in the release notes, which names the answer and the review.

## Tests first

Every change starts with a failing test: write the test, see it fail for the reason you expect, then make it pass. Each task of the plan says how it is verified, by a test, a command or an observable result, and a task is checked off only when that verification passes.

A test written ahead of the task that makes it pass is committed as an expected failure, `it.fails`, or as `it.todo` (Vitest's `test.todo`), so CI on `main` stays green; the task that builds the behavior turns it into a plain test. A test that starts a browser, a child process or a container gives its hooks and itself a timeout that holds on GitHub's slower CI runners, not only on a laptop.

Tests are behavior contracts, so they name the requirement they hold in a comment, as `capability: Requirement name`, such as `public-api: The license map`, and cite design decisions by section and number, such as `design.md, Self-hosting decisions: S16`. `pnpm test` checks that every such citation names a requirement or decision that exists.

## The OpenSpec workflow

Tiehall is planned with [OpenSpec](https://github.com/Fission-AI/OpenSpec). Changes in progress live in `openspec/changes/`, each with a `proposal.md` (why and what), a `design.md` (the decisions its specs rest on, and how it is built), a `specs/` folder with one spec delta per capability, and a `tasks.md` (the plan, in milestones, each task with its verification). Once a change is finished it is archived, and its specs join the main specs in `openspec/specs/`. The writing rules are in [`openspec/config.yaml`](openspec/config.yaml).

- Build only what an approved change and its tasks describe. Anything the specs do not cover, or any change of behavior, becomes a new OpenSpec change that the maintainers approve before it is built. A change in progress that modifies another's requirements says so, and its text governs where it does.
- Every requirement says what people, agents, admins and other systems can observe, uses SHALL or MUST, and has at least one scenario in WHEN/THEN form that can become a test. Every requirement carries a `Source:` line that points to the section of its change's `design.md` it comes from.
- Work through `tasks.md` in order, tests first, and check a task off in the commit that makes its verification pass.
- A pull request is squash-merged once its required checks pass, so `main` gets one commit for it, whose subject and body are the pull request's title and description: write them as a commit's.
- Validate every change before you commit OpenSpec text:

```sh
openspec validate --all --strict
```

## The license of each directory

The server is licensed under AGPL-3.0, and the client pieces under Apache-2.0. The line is drawn in [`tools/repo-checks/license-map.json`](tools/repo-checks/license-map.json):

| Directory | License | What it holds |
| --- | --- | --- |
| `packages/cli/` | Apache-2.0 | The `tiehall` CLI |
| `packages/client/` | Apache-2.0 | `@tiehall/client`, generated from the OpenAPI document |
| `packages/claude-plugin/` | Apache-2.0 | The Claude Code plugin, with its skill |
| `actions/contract/` | Apache-2.0 | The contract GitHub Action |
| `packages/packet/` | Apache-2.0 | The handoff-packet schema with its conformance fixtures, from which `@tiehall/packet` is built |
| The root and every other directory, `packages/catalog/` included | AGPL-3.0 | The server and the repository's own tooling |

Each client piece holds its own `LICENSE` file with the Apache-2.0 text and says `Apache-2.0` in its `package.json`; the root's [`LICENSE`](LICENSE) holds the AGPL-3.0 text, and every other package says `AGPL-3.0-only`. A new package is AGPL-3.0 unless the map names it. `pnpm check:licenses` fails on a license field or a license file that does not match the map.

An Apache-2.0 piece never imports AGPL-3.0 code, and `pnpm lint:deps` fails when one does. So the CLI does not import the command catalog in `packages/catalog/`, which is server code: it takes its request commands from the OpenAPI document, where each operation the CLI offers names its command in an `x-tiehall-cli` extension, through `@tiehall/client`. A license, once published, cannot be taken back, so changing the map is a decision for the maintainers, never part of an ordinary pull request.

## The notice rules and the `api-breaking` label

Companies build on the REST API under `/api/v1`, on the MCP tools and on the packet, so changes to them follow notice rules that CI enforces:

- Every operation carries a stability level in `x-stability-level`: `alpha`, `beta` or `stable`. `alpha` is only for work between releases: a release offers no operation or tool at `alpha`, and `pnpm release:check-stability` refuses one that does. `contract.report` and the CI OIDC path are `stable`, because pinned Actions in companies' repositories call them; another operation becomes `stable` only after four weeks with no breaking change and a maintainers' decision recorded in the changelog. The decision is an entry of kind `graduation` in `openapi/changelog.json` that names the operation and is dated the day the maintainers decided; the pull request that marks the operation `stable` adds it. `pnpm check:graduation` fails when an operation other than `contract.report` is `stable`, in a document or in the tool snapshot, without a graduation decided at least four weeks after the last release that broke it and after the release that first offered it, or released together with a breaking change to it.
- A `beta` operation changes in three steps: add the new shape; mark the old one `deprecated: true` with an `x-sunset` date at least 14 days later; remove it on or after that date. A `stable` operation gets at least 180 days between its deprecation and its removal, and a breaking change to it goes to `/api/v2`, while `/api/v1` keeps serving it for at least six months. Deprecated operations send the `Deprecation` and `Sunset` headers.
- Adding an optional field to a response is not breaking, because no response schema forbids extra fields.
- While the API is beta, the document's `info.version` has the form `0.N.0`, and a breaking change bumps it.
- On every pull request, the API compatibility workflow compares `openapi/v1.json` at the merge base with the pull request's, through the pinned oasdiff, and fails on a breaking change that skips these steps. It compares the MCP tool snapshot `mcp/tools.json` the same way, by each tool's operation, and checks that every packet fixture that validated before still validates. A `stable` operation and its tool only gain things: both comparisons also fail on any removal from one, such as an optional input property or argument, or a property of the response, though oasdiff rates it a warning, while a `beta` operation fails only on oasdiff's errors. A breaking change to a stable tool ships under a new tool name, never the name of a stable tool the snapshot held before, and the old tool is deprecated with a sunset at least six calendar months away and removed only on or after it.
- The changelog, `openapi/changelog.json`, is the notice: each install shows it at `/docs/api/changelog`, and each release's notes carry it. Tiehall emails nobody about API changes. A pull request that announces something adds a dated entry under `unreleased`, of kind `note`, naming the operations it is about.

The `api-breaking` label lets a breaking change through before its notice has run, and only for an urgent security fix that cannot wait; before Tiehall's first release, it also lets through a break of a `beta` operation that an OpenSpec change the maintainers approved names, since no released install serves the old shape, and once the first release is published, it again allows only a security fix. The pull request that carries it must also add an entry of kind `breaking` to `openapi/changelog.json` and bump `info.version`; CI fails a labelled pull request without them. Before the packet schema is published, a breaking packet change also needs the label, and its entry of kind `breaking` names `"schemas": ["packet"]` and is dated the day it is announced: no release, a release candidate included, contains the change until 14 days after that date, which `pnpm changelog:release` checks on the day it records a release and the release workflow on the day it runs.

## No model SDKs

Tiehall never calls a language model and sends no data to a model vendor: agents connect to it, and every summary, digest, notice and receipt it writes comes from a template. No package may depend on a language-model or model-vendor SDK, or on a telemetry SDK. `pnpm check:model-sdks` fails when any `package.json` names a package or scope of [`tools/repo-checks/model-sdk-denylist.json`](tools/repo-checks/model-sdk-denylist.json) or [`tools/repo-checks/telemetry-sdk-denylist.json`](tools/repo-checks/telemetry-sdk-denylist.json), and when `pnpm-lock.yaml` resolves one, through whatever depends on it. The image tests run the same lists over every package in the built image. When a dependency you need brings one of them along, find another way rather than editing the lists.

## Running the client matrix

Agents sign in to an install as OAuth clients, and the MCP clients differ in what they support, so the maintainers test sign-in and tool listing by hand, on a recurring schedule, with their own accounts of the four main clients: Claude Code, Cursor, Codex and Copilot. To run the matrix:

1. Run an install from the image under test on a URL the clients reach, following the [install docs](docs/install.md), with two members in two teams.
2. In each client, add the install's MCP endpoint, `<url>/mcp`, as a remote MCP server, and sign in. Run each client on each MCP protocol version it supports, 2026-07-28 and 2025-11-25, and sign in each way it supports: through its Client ID Metadata Document, when its client id is a document's URL, and through Dynamic Client Registration. The consent screen shows which: a metadata-document client's verified host, or the warning for an unverified client that Dynamic Client Registration gives.
3. Set `TIEHALL_CLIENT_METADATA_FETCH=off` in `.env`, run `docker compose up -d`, and sign in with each client again: the install then fetches no metadata document, and each client must register through Dynamic Client Registration.
4. For each cell, record the sign-in path that worked, or the failure, and the number of tools the client shows against the server's count, the tools in `mcp/tools.json`.
5. In the same sessions, record which clients open a URL-mode elicitation for a commitment and retry the tool call afterwards, and whether Claude Code's Stop hook with `asyncRewake` wakes the session when news arrives.

Commit the record of the run with a result in every cell, as a dated entry in the client-matrix log, [`docs/client-matrix/log.md`](docs/client-matrix/log.md), in the form its opening describes; the plan's checks against one real client, such as the Claude Code plugin's and its hooks', are recorded there too. Triage each failing cell: a failure on Tiehall's side becomes a task with a reproducing test first; a failure only the client can fix gets its fallback documented for that client, which is Dynamic Client Registration, a personal access token, or the web inbox in place of URL-mode elicitation.

## Making a release

A release is made from a version tag on a commit of `main`: `v<major>.<minor>.<patch>`, such as `v1.3.0`, or a release candidate such as `v1.3.0-rc.1`, which the release page marks as a pre-release. Releases use semantic versions, and the version becomes the image's version tag.

Before tagging, record the release's API changes in `openapi/changelog.json` with `pnpm changelog:release <version> --previous <previous release's tag>`, leaving out `--previous` for the first release, so the image built from the tag lists them on `/docs/api/changelog` and the release notes carry them. A release candidate, such as `v1.3.0-rc.1`, gets no record of its own, and `pnpm changelog:release` refuses one: record the final version, `1.3.0`, whose record collects every API change and every entry, the hand-written ones included. Until it is recorded, a candidate's notes list the entries waiting under `unreleased`; once it is, they carry its record, so the final release can be tagged on the commit of its last candidate. When a release must not be skipped, because a later release relies on something it does while it runs, such as a background job that backfills what a later contract step drops, add it to [`release/no-skip.json`](release/no-skip.json) with the reason in a sentence; every later release's notes name it. Merge both through a pull request. A contract step, a migration marked `-- migrate: contract after <release>`, ships at least one release after the expand step it follows: the release workflow refuses one whose expand release is not out yet, and the notes flag each contract step a release adds.

Pushing the tag starts the [release workflow](.github/workflows/release.yml), the only way a release is made; nothing is published from a laptop. It checks that the tag names a version and points to a commit of `main`, that no operation or tool is at `alpha` (`pnpm release:check-stability`) and that the release notes can be written, builds the image once for that version, writes the image's SBOM with the pinned scanner in a job without permissions, scans the image as the Build workflow scans each build of `main`, with the same pinned scanner and rules, in a job without permissions, so that a fixable high or critical vulnerability stops the release until it is fixed, and runs the image checks on the release's own image: the image tests, the boot test and the fresh-install, "It works", egress, polling-mode, backup-and-restore and upgrade tests, the upgrade from the previous release's image. Only when all of them have passed does it push the image by digest, tagged with its version, attest the digest's build provenance and SBOM, and publish the release with its notes, `compose.yaml`, the `Caddyfile`, `.env.example` (as `env.example`, because GitHub keeps no leading period in a release file's name), `backup.sh` and `restore.sh`. A failure in any gate stops the release before anything is pushed or published, which `pnpm check:release-gates` checks on every pull request, with the scan's command and scanner against the Build workflow's.

The first public release follows the [checklist for making the repository public](docs/maintainers/going-public.md), which the maintainers work through when the repository goes public.

# Making the repository public

The repository, at `github.com/tiehall/tiehall`, goes from private to public once. This is the maintainers' checklist for that step: what the repository must hold and leave out, how its history is rewritten and checked, how GitHub is set up for a public project, and what follows the switch. The plan's tasks 30.1 to 30.6 carry it out ([the plan's group 30](../../openspec/changes/add-tiehall-oss-v1/tasks.md#30-making-the-repository-public)).

Each item says what to do and gives one or more `Evidence:` lines that link what shows the item holds: a check or a test of the repository, a file, a workflow, or GitHub's documentation of a setting together with the command that reads the setting back. An item marked as a founder step needs the founder's own accounts or permission at that time, and an agent working on the repository never does it: the history rewrite and its push, GitHub's settings and the switch to public. Nothing personal or secret may remain in the public repository, its history included.

## Before the switch: what the repository holds

### GP-1 The allowlist of public paths

The public repository holds only the paths that the allowlist allows, and `private/`, where the planning material lives on the maintainer's machine, stays git-ignored.

- Run `pnpm check:public-paths` on the commit that will become the public `main`; it passes.
- Read the allowlist's groups once more: the folders it holds whole, such as `packages/`, `tools/`, `.github/` and `openspec/changes/`, hold nothing that is not meant to be public.
- Evidence: the allowlist, [`tools/repo-checks/public-paths.json`](../../tools/repo-checks/public-paths.json), and its check, [`tools/repo-checks/src/check-public-paths.ts`](../../tools/repo-checks/src/check-public-paths.ts), which the Public paths job of [CI](../../.github/workflows/ci.yml) runs on every pull request and push to `main`.
- Evidence: [`tools/repo-checks/test/public-paths.test.ts`](../../tools/repo-checks/test/public-paths.test.ts), which holds the check (task 30.1).

### GP-2 Nothing personal or secret in the tree

- A file beside the checkout, `../personal.txt`, kept outside the repository and never committed, lists one per line what names the maintainer: each of their own email addresses, any name of theirs other than the public author's, the user name and the name of every machine the repository was worked on, the names of their other projects, and the identifiers of their own installs and GitHub Apps, such as the id, name, slug, client id and installation id of the spikes' App. A home folder's path carries that user name, and so does an agent's scratch folder, which writes the path with dashes, as `-Users-<user name>-`.
- No file names any of them, or a real person's home folder. From the checkout, the commands below print nothing but the home folders of the made-up people that specs and tests use as examples: the first finds each line of `../personal.txt`, the second any home folder's path, written with slashes or with dashes. The scan of GP-7 reads the history the same way, binary files included.

  ```sh docs-test=tree-personal-data
  git grep -n -I -i -F -f ../personal.txt
  git grep -n -I -E -e '(^|[^[:alnum:]_.-])/(Users|home)/[[:alnum:]_.-]' -e '-(Users|home)-[[:alnum:]_.]'
  ```

- The repository's own address is `github.com/tiehall/tiehall`, and every file that names it says so: the default source link of the running version (`DEFAULT_SOURCE_REPOSITORY`), which the reporting form of `SECURITY.md` follows, the packet package's repository and homepage, the plugin marketplace's owner, the plugin's install command in the docs, and the contract Action's `uses:` line. Task 30.7 moved them from the repository's earlier address under the maintainer's personal account. Examples of someone's own copy keep a placeholder owner, such as `acme`.
- No mailbox exists at `tiehall.com` yet, so no page names an address there: `SECURITY.md` takes reports through GitHub's private vulnerability reporting alone (GP-13).
- Secrets: the secret scan of GP-8 reads every commit, the tree's included.
- Evidence: the default source link in [`packages/commands/src/running-version.ts`](../../packages/commands/src/running-version.ts), and [`tools/repo-checks/test/security-policy.test.ts`](../../tools/repo-checks/test/security-policy.test.ts), which finds no email address in `SECURITY.md` and its reporting form at the repository the source link names.
- Evidence: [`tools/repo-checks/test/repository-address.test.ts`](../../tools/repo-checks/test/repository-address.test.ts), which finds every GitHub address of the repository, `uses:` line of the contract Action and marketplace command in the tree naming `tiehall/tiehall` or a placeholder owner (task 30.7).
- Evidence: this page's own check, [`tools/repo-checks/test/going-public.test.ts`](../../tools/repo-checks/test/going-public.test.ts), which runs the commands above on a scratch repository and finds each line of `personal.txt` and each home folder's path in it.
- Evidence: [`tools/repo-checks/test/personal-data.test.ts`](../../tools/repo-checks/test/personal-data.test.ts), which finds in every tracked file no home folder's path but the made-up people's, no email address but placeholders', GitHub's own and the public author's no-reply one, and the maintainer's GitHub user name only in that address, and finds that the [client-matrix log](../client-matrix/log.md) names the maintainer's machine and installs only as "the maintainer's machine" and "a test install", as its rules say (task 30.8).

### GP-3 The license files

- `pnpm check:licenses` passes: the AGPL-3.0 text in the root's `LICENSE`, the Apache-2.0 text in each client piece's own `LICENSE`, and each package's `license` field as the license map says.
- Evidence: [`LICENSE`](../../LICENSE), the license map [`tools/repo-checks/license-map.json`](../../tools/repo-checks/license-map.json) and its test, [`tools/repo-checks/test/licenses.test.ts`](../../tools/repo-checks/test/licenses.test.ts) (tasks 3.3 and 28.1), which the License map job of [CI](../../.github/workflows/ci.yml) runs.

### GP-4 The README

- The README says what Tiehall is, its status, the quickstart, where the docs are and the license of each directory, and its check passes in `pnpm test`.
- Before the switch, the README gains the logo and the film (the maintainer's decision on how the film is shown):
  - the logo is the mark TM1, gold on a navy tile, as the install draws it;
  - the film is "05 · Every Team's Line", 16:9 with English narration. Its file is 114 MB: GitHub refuses a file over 100 MB in a repository and, on the free plan, takes a video in a Markdown page only up to 10 MB, so the film is never committed. Either an encode under 10 MB is uploaded to GitHub and shown in the README, or the film is hosted with the landing page (GP-22) and the README shows a still frame that links to it. A still frame or any other new file needs its place in the allowlist (GP-1).
- After the first release (GP-20), the Status section names the release that is out.
- Evidence: [`README.md`](../../README.md) and its check, [`tools/repo-checks/test/readme.test.ts`](../../tools/repo-checks/test/readme.test.ts) (task 28.2); the mark, [`packages/commands/assets/icon.svg`](../../packages/commands/assets/icon.svg); GitHub's limits in [Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) and [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).

### GP-5 CONTRIBUTING

- `CONTRIBUTING.md` says how to build and test, tests first, the OpenSpec workflow, the license of each directory, the notice rules and the `api-breaking` label, no model SDKs, running the client matrix and making a release.
- Evidence: [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and its check, [`tools/repo-checks/test/contributing.test.ts`](../../tools/repo-checks/test/contributing.test.ts) (task 28.3).

### GP-6 SECURITY

- `SECURITY.md` asks for reports through GitHub's private vulnerability reporting on the public repository, never in public, names no email address, and says which releases get fixes. Its reporting form opens once private vulnerability reporting is on (GP-13), at the repository's own address (GP-2).
- Evidence: [`SECURITY.md`](../../SECURITY.md) and its check, [`tools/repo-checks/test/security-policy.test.ts`](../../tools/repo-checks/test/security-policy.test.ts) (task 28.4).

## The history

### GP-7 Rewrite the history

Task 30.3, a founder step: the founder's permission for the rewrite and its push at that time. The public history's author is `Muhammed Çınaklı <33037014+muhmmdcnkl@users.noreply.github.com>`.

- Work in a fresh clone that holds `main` alone, never in a working clone: `git clone --single-branch --branch main https://github.com/tiehall/tiehall.git tiehall-public`, so that no other branch, no remote-tracking ref and no pull request ref is rewritten or pushed. The spikes' throwaway branches and merged branches stay out. filter-repo rewrites only a fresh clone, whose one remote is `origin`, and refuses one whose `origin` was removed; it removes `origin` itself after the rewrite, so the rewritten clone pushes nowhere until GP-10 gives it its remote.
- From a checkout of the same commit, beside the clone, list the paths to remove: `node tools/repo-checks/src/check-public-paths.ts ../tiehall-public --history > ../outside.txt`, which prints each path outside the allowlist on a line of its own.
- In the clone, with [git filter-repo](https://github.com/newren/git-filter-repo) installed by the founder: `git filter-repo --invert-paths --paths-from-file ../outside.txt --mailmap ../mailmap`. The mailmap file is kept outside the repository and maps every identity that `git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u` shows, except GitHub's own committer of merges made on the web, to the public author, one line each as `Proper Name <proper@email> Commit Name <commit@email>`. filter-repo drops the commits that the removal leaves empty, and their messages with them.
- Read back the identities with the same `git log` command: only the public author and GitHub's own committer remain.
- Scan every commit of the rewritten clone for personal data: its author and committer, its message and every line its changes add or remove, the first commit's and each side of a merge's included, binary files read as text. A path the rewrite keeps can still hold one in its history, so this reads the content, which the scans of GP-8 and GP-9 do not. From the clone, the commands below write the history to `../history.txt` and print nothing but the home folders of the made-up people of GP-2: the first finds each line of `../personal.txt` (GP-2), the second any home folder's path, written with slashes or with dashes. Above each hit, `../history.txt` shows the commit and the file that hold it.

  ```sh docs-test=history-personal-data
  git log --all --root --diff-merges=separate --no-renames --text -p --format='commit %H%n%an <%ae>%n%cn <%ce>%n%n%B' > ../history.txt
  grep -a -n -i -F -f ../personal.txt ../history.txt
  grep -a -n -E -e '(^|[^[:alnum:]_.-])/(Users|home)/[[:alnum:]_.-]' -e '-(Users|home)-[[:alnum:]_.]' ../history.txt
  ```

- What the scan finds is rewritten, never left: write each text to rewrite in `../replacements.txt`, kept outside the repository, one line each as `<text>==><replacement>` (filter-repo also takes `regex:<pattern>==><replacement>`), then start again from a fresh clone with `--replace-text ../replacements.txt --replace-message ../replacements.txt` added to the one rewrite, and scan again. On 2026-10-16, `main` held one such text in a path the rewrite keeps: two commits of task 21.3 add and remove a line of `tools/image-tests/test/install/backup.test.ts` that wrote to an agent's scratch folder under the maintainer's home folder. Once the scan prints nothing more, delete `../history.txt`.
- Read the messages with `git log --all --format=%B`: they hold nothing from the planning notes that must stay private; `--replace-message` rewrites a message that does.
- `.gitleaksignore` names its reviewed false positive by the commit that holds it, whose id the rewrite changes: replace it with the new id, from filter-repo's `.git/filter-repo/commit-map`, in a commit on top, made as the public author.
- Every commit id changes: after the push, local clones and worktrees start again from the new `main`, and work on other branches moves over with `git rebase --onto`. Commit ids that notes in the repository already name, such as a CI run's, stay as written.
- Evidence: [the plan's task 30.3](../../openspec/changes/add-tiehall-oss-v1/tasks.md#30-making-the-repository-public), and the check's history mode, [`tools/repo-checks/src/check-public-paths.ts`](../../tools/repo-checks/src/check-public-paths.ts) given `--history`.
- Evidence: this page's own check, [`tools/repo-checks/test/going-public.test.ts`](../../tools/repo-checks/test/going-public.test.ts), which runs the scan above on a scratch repository whose personal data only a first commit, a removed file, a binary file, an author, a message and a merge's resolution hold, and finds each; and filter-repo's [manual](https://github.com/newren/git-filter-repo/blob/main/Documentation/git-filter-repo.txt), on `--replace-text` and `--replace-message`, and on the fresh clone it requires.

### GP-8 The secret scan of the rewritten history

- From a checkout of the repository, with Docker: `node tools/repo-checks/src/scan-secrets.ts ../tiehall-public` reports no leaks found over every commit of the clone.
- Evidence: [`tools/repo-checks/src/scan-secrets.ts`](../../tools/repo-checks/src/scan-secrets.ts) and its test, [`tools/repo-checks/test/secret-scan.test.ts`](../../tools/repo-checks/test/secret-scan.test.ts) (task 2.10), which the Secret scan job of [CI](../../.github/workflows/ci.yml) runs over the whole history of every pull request.

### GP-9 The path scan of the rewritten history

- `node tools/repo-checks/src/check-public-paths.ts ../tiehall-public --history` passes, and `git -C ../tiehall-public log --all --name-only --format= | sort -u` lists no path outside the allowlist, the verification of task 30.3.
- After the switch, CI's Public paths job reads the tree alone: a pull request whose own commits add a path outside the allowlist and remove it again brings that path into the history if it is merged without squashing. Squash merges keep the history clean; running the check with `--history` in CI would too, as a change of its own.
- Evidence: [`tools/repo-checks/src/check-public-paths.ts`](../../tools/repo-checks/src/check-public-paths.ts) and the tests "with --history" in [`tools/repo-checks/test/public-paths.test.ts`](../../tools/repo-checks/test/public-paths.test.ts) (task 30.1).

### GP-10 Where the rewritten history goes, and the pull request refs

A force push replaces `main` but not what GitHub keeps beside it. The repository's other branches keep the history they had: on 2026-10-16, `deps/node-base-image-2026-09-26`, whose history holds the planning material. The refs of the repository's two merged pull requests, `refs/pull/1/head` and `refs/pull/2/head`, which no push can change, reach commits from before task 3.4 moved the planning material to `private/`; commits pushed earlier stay readable by their ids until GitHub collects them; and the logs and artifacts of the earlier workflow runs, about 130 of them, become public with the repository.

- Choose one, a founder step:
  - recommended, a new repository for the public history: rename the current repository, for example to `tiehall/tiehall-private`, and keep it private; create a new, empty `tiehall/tiehall` and push the rewritten `main` to it; then set it up as GP-11 to GP-16 say, since settings, the image package's access and app installations do not move with a push;
  - or force-push to the current repository: first, from a working clone, delete each of its branches other than `main`, with `git push origin --delete <branch>` for each that `git ls-remote --heads origin` lists; then force-push, ask GitHub Support to remove the pull request refs and collect the unreachable commits, and delete the earlier workflow runs with `gh run delete`, all before the switch.
- Push from the rewritten clone, which filter-repo left without a remote: `git remote add origin https://github.com/tiehall/tiehall.git`, then `git push origin main` to a new repository, or `git push --force origin main` to the current one.
- Read back: `git ls-remote https://github.com/tiehall/tiehall.git` lists `HEAD` and `refs/heads/main`, at the id of the rewritten clone's `main`, and nothing else: no other branch, no tag and no pull request ref. On 2026-10-16 it listed `HEAD`, `main`, the branch `deps/node-base-image-2026-09-26` and the refs of pull requests 1 and 2, and no tag.
- Evidence: GitHub's [Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository), which says what a force push leaves behind, and filter-repo's [manual](https://github.com/newren/git-filter-repo/blob/main/Documentation/git-filter-repo.txt), under "Why is my origin removed?".

## GitHub's settings

Task 30.4 reads each repository setting back through GitHub's API. GitHub's free plan offers private vulnerability reporting and branch protection only for a public repository, so GP-13 and GP-14 follow the switch (GP-19) at once, before anything else is announced.

### GP-11 The repository's description, homepage and topics

- `gh repo edit tiehall/tiehall --description "<description>" --homepage https://tiehall.com --add-topic <topic>`, with the description in the README's own words, such as "A request layer for software teams that use coding agents. Self-hosted, open source.", and topics such as `coding-agents`, `mcp`, `model-context-protocol`, `self-hosted`, `developer-tools`, `openapi`, `claude-code` and `typescript`. The homepage is set once `tiehall.com` serves the landing page (GP-22).
- Issues stay on and the wiki off, since the docs live in the repository; whether to open Discussions is the maintainers' choice.
- Read back: `gh api repos/tiehall/tiehall --jq '{description, homepage, topics, has_issues, has_wiki, has_discussions}'`.
- Evidence: [`README.md`](../../README.md), whose opening the description follows, and GitHub's [Classifying your repository with topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).

### GP-12 The social preview

- A PNG of 1280 by 640 pixels, under 1 MB: the mark TM1, gold on a navy tile, with the name Tiehall, in the web UI's navy and gold. Upload it under Settings, General, Social preview, which no API sets; the image need not be committed.
- Read back: `gh api graphql -f query='query { repository(owner: "tiehall", name: "tiehall") { usesCustomOpenGraphImage openGraphImageUrl } }'`.
- Evidence: the mark, [`packages/commands/assets/icon.svg`](../../packages/commands/assets/icon.svg), and GitHub's [Customizing your repository's social media preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

### GP-13 Private vulnerability reporting and the security features

- Right after the switch: `gh api -X PUT repos/tiehall/tiehall/private-vulnerability-reporting`; read back `gh api repos/tiehall/tiehall/private-vulnerability-reporting --jq .enabled`, which gives `true`, and the reporting form that `SECURITY.md` links opens.
- Secret scanning and its push protection, which GitHub gives a public repository: `gh api -X PATCH repos/tiehall/tiehall -f 'security_and_analysis[secret_scanning][status]=enabled' -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'`; read back `gh api repos/tiehall/tiehall --jq .security_and_analysis`.
- Dependabot alerts on, and Dependabot's own update pull requests off, since updates come only from Renovate after the 7-day release age: `gh api -X PUT repos/tiehall/tiehall/vulnerability-alerts` and `gh api -X DELETE repos/tiehall/tiehall/automated-security-fixes`; read back `gh api repos/tiehall/tiehall/automated-security-fixes`, which gives `"enabled":false`.
- Evidence: [`SECURITY.md`](../../SECURITY.md), [`renovate.json`](../../renovate.json), and GitHub's [Configuring private vulnerability reporting for a repository](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository).

### GP-14 Branch protection on main and the release tags

- Right after the switch, protect `main`: changes come only through a pull request whose required checks pass, with no force push and no deletion, for administrators too.
- Required checks: `Typecheck and test`, `CLI on Node.js 22`, `Dependency rules`, `No model SDKs`, `No spec reading on the server`, `Workflow rules`, `License map`, `Public paths`, `OpenAPI document`, `Client package`, `Claude Code plugin`, `MCP tool snapshot`, `Packet schema`, `Confirmation coverage`, `Security-event coverage`, `Error model coverage`, `Migration lint`, `Compose policy`, `Secret scan`, `Image / Image tests`, `Image / Self-host boot test`, `Image / Fresh install`, `Image / It works`, `Image / Egress`, `Image / Polling mode`, `Image / Backup and restore`, `Image / Upgrade and rollback`, `API compatibility`, `Packet fixture compatibility`.
- Protect the version tags: a version tag `v*` starts the release workflow, so a tag ruleset lets only the maintainers create, update or delete one.
- `gh api -X PUT repos/tiehall/tiehall/branches/main/protection --input protection.json`, with the checks above as `required_status_checks.contexts`; read back `gh api repos/tiehall/tiehall/branches/main/protection --jq '{checks: .required_status_checks.contexts, admins: .enforce_admins.enabled, force_pushes: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'` and `gh api repos/tiehall/tiehall/rulesets`.
- Evidence: [CI's workflow](../../.github/workflows/ci.yml) with the [image checks](../../.github/workflows/image-checks.yml) it calls and the [API compatibility workflow](../../.github/workflows/api-compatibility.yml); [`tools/repo-checks/test/ci-test-job.test.ts`](../../tools/repo-checks/test/ci-test-job.test.ts), which keeps the name of the one test job the protection requires; and this page's own check, [`tools/repo-checks/test/going-public.test.ts`](../../tools/repo-checks/test/going-public.test.ts), which fails when the list above differs from the jobs CI runs on a pull request.

### GP-15 Read-only default workflow permissions

- The default token of a workflow can only read, and workflows may not approve a pull request. Set both with `gh api -X PUT repos/tiehall/tiehall/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false`; read back `gh api repos/tiehall/tiehall/actions/permissions/workflow`. On 2026-10-16, while the repository was private, it gave `{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}`; read it again after the switch, and on a new repository (GP-10) set it first.
- Workflows of pull requests from outside contributors' forks wait for a maintainer's approval: Settings, Actions, General, "Require approval for all external contributors".
- Evidence: [`.github/workflow-policy.json`](../../.github/workflow-policy.json) with its check, [`tools/repo-checks/src/check-workflows.ts`](../../tools/repo-checks/src/check-workflows.ts) (task 2.4), and GitHub's [Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

### GP-16 The image's package

- The image `ghcr.io/tiehall/tiehall` is public, so operators pull it without signing in: the package's settings, Change visibility. It stays connected to the repository, whose workflows push it, under Manage Actions access; on a new repository (GP-10), grant that access again.
- Read back: `gh api orgs/tiehall/packages/container/tiehall --jq '{visibility, repository: .repository.full_name}'`, with the `read:packages` scope (`gh auth refresh -s read:packages`), and a pull of the image by digest on a machine without credentials.
- Evidence: [the Build workflow](../../.github/workflows/build.yml) and [the release workflow](../../.github/workflows/release.yml), which push the image, and [the install docs](../../docs/install.md), whose commands pull it.

### GP-17 The organization's settings

A founder step, for the organization `tiehall`.

- Members need two-factor authentication (off on 2026-10-16); the base permission is read; members may not create public repositories or change a repository's visibility; the organization's default workflow permissions are read-only.
- Once `tiehall.com` has DNS, verify the domain for the organization with its TXT record, and verify it for GitHub Pages too, so that no other account can serve a site on it (GP-22).
- Read back: `gh api orgs/tiehall --jq '{two_factor_requirement_enabled, default_repository_permission, members_can_create_public_repositories}'` and `gh api orgs/tiehall/actions/permissions/workflow`.
- Evidence: GitHub's [Requiring two-factor authentication in your organization](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-two-factor-authentication-for-your-organization/requiring-two-factor-authentication-in-your-organization) and [Verifying or approving a domain for your organization](https://docs.github.com/en/organizations/managing-organization-settings/verifying-or-approving-a-domain-for-your-organization).

### GP-18 The organization's profile

A founder step.

- The avatar is the mark TM1, gold on a navy tile; the display name Tiehall; a one-line description in the README's words; the URL `https://tiehall.com` once it serves (GP-22); and no email address until a mailbox exists.
- A public repository `tiehall/.github` holds `profile/README.md`, which GitHub shows on the organization's page: what Tiehall is, with links to the repository, the install docs and the landing page. Pin `tiehall/tiehall` on the organization's page.
- Read back: `gh api orgs/tiehall --jq '{name, description, blog, email}'` and `gh api repos/tiehall/.github/contents/profile/README.md --jq .path`.
- Evidence: the mark as an image of 512 by 512 pixels, [`packages/commands/assets/icon-512.png`](../../packages/commands/assets/icon-512.png); the [README](../../README.md)'s opening; and GitHub's [Customizing your organization's profile](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/customizing-your-organizations-profile).

## The switch and what follows

### GP-19 The switch to public

Task 30.5, a founder step.

- Only once GP-1 to GP-10 pass: `gh repo edit tiehall/tiehall --visibility public --accept-visibility-change-consequences`, then GP-13 and GP-14 at once.
- Read back: `gh api repos/tiehall/tiehall --jq .visibility` gives `public`, and `git -c credential.helper= clone https://github.com/tiehall/tiehall.git` works on a machine without credentials.
- Evidence: [the plan's task 30.5](../../openspec/changes/add-tiehall-oss-v1/tasks.md#30-making-the-repository-public).

### GP-20 The first public release

- Cut a release candidate and then the first release from version tags on `main`, as the contributors' guide says under [Making a release](../../CONTRIBUTING.md#making-a-release): the release page lists every asset, and the two `gh attestation verify` commands that the release notes give pass on a machine without credentials (tasks 29.1 and 30.5).
- Then install the release on a clean machine from the public docs alone, through setup and one request exchanged by two agents (task 30.6).
- Evidence: [the release workflow](../../.github/workflows/release.yml) and its test, [`tools/repo-checks/test/release-workflow.test.ts`](../../tools/repo-checks/test/release-workflow.test.ts).

### GP-21 The GitHub Actions minutes

- A public repository's workflows run on GitHub's standard hosted runners without charge, so CI runs again on every pull request and push to `main` once the repository is public, as it could not while the private repository had used its minutes. Every job of the workflows runs on `ubuntu-24.04`, a standard runner. Keep the organization's budget for Actions at zero, so that nothing billable, such as a larger runner, runs.
- After the switch, run what waited for CI minutes: a full run of CI on `main`, the throwaway pull request of task 2.12, the live release candidate of task 29.1, and the Renovate dry run with a read-only token of task 2.5.
- Read back: after a full run of CI, the organization's billing page shows no charge for Actions minutes.
- Evidence: [CI's workflow](../../.github/workflows/ci.yml), and GitHub's [About billing for GitHub Actions](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions).

### GP-22 The landing page at tiehall.com

The domain `tiehall.com` is registered and has no DNS records yet.

- After the switch, set up its DNS, verify the domain (GP-17) before it points at a host, and serve the page over HTTPS, from a separate repository such as `tiehall/tiehall.com` on GitHub Pages, or from another static host: the maintainers' choice.
- The page says what Tiehall is, shows the logo and the film (GP-4), and links to the repository, the install docs and the latest release; it names no email address until a mailbox exists, and, like an install, it sends its visitors to no tracker.
- Keep `https://tiehall.com/schemas/` free: published packet schemas get lasting URLs under it (D26), which task 29.13 publishes, and nothing else is served there.
- Then set the repository's homepage (GP-11) and the organization's URL (GP-18).
- Read back: `curl -sSI https://tiehall.com` answers over HTTPS with the page, and `curl -sSI https://tiehall.com/schemas/` serves nothing yet.
- Evidence: D26 in the design's [earlier product decisions](../../openspec/changes/add-tiehall-oss-v1/design.md#earlier-product-decisions-that-still-hold), and GitHub's [Verifying your custom domain for GitHub Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages).

## Recording the run

The read-back output of each step goes into the note of the task that does it, as the plan's notes record their verification: GP-7 to GP-10 under task 30.3, GP-11 to GP-16 under task 30.4, and GP-19 and GP-20 under task 30.5, with GP-17, GP-18, GP-21 and GP-22, which no task names, in a dated note under task 30.5 too. `pnpm test` checks this page: [`tools/repo-checks/test/going-public.test.ts`](../../tools/repo-checks/test/going-public.test.ts) finds an item for each step, every item linked to its evidence, every link resolving, every task it names in the plan, the required checks of GP-14 matching the jobs CI runs, and nothing personal in it.

# GitHub's recorded behavior, from spikes 1.5 and 1.6

The GitHub stub's contract tests (`../../github-stub-contract.test.ts`) replay these files against the stub, so the stub answers as GitHub did on 2026-09-28, when the spikes of tasks 1.5 and 1.6 of `add-tiehall-oss-v1` ran against real GitHub (design.md of that change, Technical decisions: T16; design.md of `github-app-reachability`, Technical decisions: T4).

- `log-2026-09-28.json` and `status-2026-09-28.json` are the spike's own records, `/log.json` and `/status.json` of its throwaway server, as committed on the spike branch. Neither ever held a secret.
- `answers-2026-09-28.json` transcribes what the spike's written record quotes word for word and the two JSON files do not hold: the manifests the spike posted to GitHub's new-App page, with GitHub's answer to each, and GitHub's answer to a token exchange with a wrong client secret.

The spike ran on a person's own GitHub account. Before these files were committed, the account's login, its numeric id, the App's id and client id, the installation's id and the repository were replaced by example values (`example-user`, `1000001`, `2000001`, `Iv23liExample0000001`, `3000001`, `example-user/example-repo`), and so were the fingerprints of the App's client secrets and the ids of the sign-in library's rows. Every other value is as recorded.

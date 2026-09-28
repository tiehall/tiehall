# Proposal: GitHub App reachability

## Why

On 2026-09-28, spike 1.6 of `add-tiehall-oss-v1` showed that GitHub refuses the manifest the specs describe. It refuses a webhook URL on `localhost`, active or not, and may refuse other URLs it cannot reach; it refuses `installation` and `installation_repositories` as subscribed events, which every App receives anyway; and it allows no event without a webhook URL. A refusal leaves the operator on GitHub's error page, with no way back. So no trial install on `http://localhost` can complete setup, and the main change's M1 run (its task 21.12) would stop there.

It also showed that an App without a webhook works: GitHub accepts it, gives it no webhook secret or delivery log, and lists its installations and their repositories to the App's own credentials. The specs assumed a webhook secret, installation deliveries and a delivery log.

D49, the maintainer's decision, has the setup screen decide the webhook from the install's URL. [design.md](design.md#decisions-this-change-rests-on) restates it with the alternatives that lost, and carries the spike's other corrections as design rules.

## What Changes

- A trial URL, `http://localhost` with or without a port, creates its App with no webhook and no events, and Tiehall polls GitHub from the start. Any other URL gets the webhook, and S9 decides the mode, as before.
- For any other URL, the setup screen offers "GitHub cannot reach this address", for an App without a webhook, and says before the click that an operator whom GitHub refuses comes back to `/setup` and chooses it.
- The manifest subscribes to `pull_request`, `issues` and `organization` only.
- An App without a webhook is stored without a webhook secret, and `/webhooks/github` answers every delivery with 401 until one is stored.
- Tiehall finds installations, their repositories and their suspension by listing, in both modes, so setup needs no delivery.
- Storing an App's credentials sets GitHub's mode, after `setup reopen` too. The reachability check skips an App without a webhook, whose missing delivery log is no failure.
- Except on a trial URL, the admin page shows the steps to webhook mode: an admin stores the webhook secret with the confirmation step, then switches the mode, refused with 409 while no secret is stored.
- No code assumes an installation token's length.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `self-host-install`: "The GitHub App is created with GitHub's manifest flow" and "Setup names the company and makes the first admin".
- `tracker-mirrors`: "The GitHub App asks for narrow permissions and every event up front", "Admins connect GitHub installations with the confirmation step", "Covered repositories follow each connected installation", "GitHub webhooks are verified, deduplicated and processed in the background" and "GitHub and Jira each run in webhook mode or polling mode".
- `agent-safety`: "Actions that need the confirmation step".

## Impact

- **Code:** built parts change: the main change's settings reader (5.1), log redaction (4.14), setup gate (7.1), setup route (7.2) and coverage-check lists (8.4, 20.1). The rest lands with its unbuilt tasks 7.3 to 7.9, group 10, 21.2, 21.9, 21.10, 23.15 and 24.11.
- **Public contracts:** `/webhooks/github` answers 401 to a refused delivery.
- **Order:** archived after `add-tiehall-oss-v1`, whose requirements it modifies, and after `spec-catch-up`, which also modifies "Setup names the company and makes the first admin", and whose "The setup code guards the setup screen" keeps the setup session the way back needs. This change's text of the first includes spec-catch-up's, so neither delta undoes the other.
- **Open:** a founder step measures GitHub's answer to private-network hook URLs; a refusal reopens their default in its own change.

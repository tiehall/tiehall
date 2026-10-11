# Proposal: Findings from the Claude Code run

## Why

On 2026-10-11 the maintainer ran the Claude Code plugin and its hooks against a local install, for tasks 17.7 and 19.19 of `add-tiehall-oss-v1`; the [client-matrix log](../../../docs/client-matrix/log.md) holds the record. The plugin connected and the waiter woke Claude, so the Stop-hook waiter ships (19.20). The run also found four problems, F1 to F4. [design.md](design.md#findings-and-recommended-rules) states each with the run's evidence, the options and a recommended rule, items (1) to (9), for the maintainer to approve.

- **F1, items (1) to (3).** The mark of the news announced is one per user and install, and a plugin installed for the user runs its hooks in every Claude Code session, the desktop app's included. The first waiter to see an update takes it: BE-1's opening woke a desktop app session, and the terminal session that opened BE-1 was never told.
- **F2, item (4).** An agent's own writes are its user's updates, so a waiter can wake Claude for what Claude just did. `decisions-from-groups-15-28`'s D55 (43) would leave out every event of the user, which also drops the web confirmations that "Proposal outcomes reach the proposing agent" requires.
- **F3, items (5) and (6).** The plugin reads the install's URL from `TIEHALL_URL` in the environment Claude Code starts in. The desktop app does not read the user's shell, so its MCP connection failed while its hooks fell back to the CLI's saved login.
- **F4, item (7).** A person who opened a request and then claimed it still has their messages recorded for the requesting side.
- **Items (8) and (9)** settle the run's own records: 19.19, open until approved, is checked off with its limits named, and the client-matrix log lives in `docs/client-matrix/`.

## What Changes

- A PostToolUse hook makes a session's project folder follow each request its Tiehall tool calls name or open. News on a followed request is announced once in each folder that follows it, and in no other session; news on other requests keeps today's rule.
- The agents' readers leave out what the user's agents did and keep what the user did in the web UI; the web inbox's update feed and the digest leave out every event of the user.
- The plugin asks for the install's URL through Claude Code's own configuration of the plugin, for its MCP connection and its hooks; without it, the hooks read nothing and say so in one line.
- On a claimed request, the claimant's messages are recorded for the target team.
- The docs say where a user-scope install runs its hooks, and a re-run checks what the first run did not.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `requester-loop`: adds "A project folder follows the requests its sessions work on"; modifies "News is announced once", "What whats_new covers" and "Proposal outcomes reach the proposing agent".
- `agent-surfaces`: modifies "The Claude Code plugin".
- `requests`: adds "The side a message is posted for".

## Impact

- **Code:** the CLI's hooks, marks and `tiehall watch`; the plugin's manifest, MCP connection, hooks and launcher (version 0.3.0); the update readers' scope; the side of a posted message; the plugin's check and docs.
- **Public contracts:** no operation, tool or packet field changes. What `whats_new`, `tiehall updates` and the wait endpoint return changes before the first release, with D55 (43).
- **Order:** two checks in a real Claude Code come first (tasks 1.1 and 1.2). Archived after `add-tiehall-oss-v1` and `decisions-from-groups-15-28`, whose texts it starts from.
- **Approval:** nothing here is built before the maintainer approves it.

# Design: Findings from the Claude Code run

## Context

[proposal.md](proposal.md) says why the run of 2026-10-11 needs a change of its own. This document states each of the run's four findings, F1 to F4, with the run's evidence, the options with the recommended one first, and the rules of the recommended option, numbered so that the maintainer can approve each one or change it. It then says how the rules are built, which texts of earlier changes they correct, and what stays open. Nothing in it is built before the maintainer approves it.

**The run.** The [client-matrix log](../../../docs/client-matrix/log.md) holds the record, in its two entries of 2026-10-11, for tasks 17.7 and 19.19 of `add-tiehall-oss-v1`. Claude Code 2.1.296, the interactive CLI in a terminal, on macOS 27.0.1, ran against the maintainer's local install at `http://localhost:3000`, built from commit `54d4139`, with two teams, FE and BE, and one person, the maintainer, a member of both. The CLI, built from the same commit, was signed in to it. The plugin, version 0.2.0, was installed from the repository's marketplace file at user scope, with `TIEHALL_URL` exported from the shell's startup file. A session of the Claude desktop app's Code tab ran on the same machine. The install recorded security event 20, `agent_client.approved`, for the CLI's device-flow sign-in; the plugin's MCP sign-in reused the maintainer's approval of Claude Code's Client ID Metadata Document from the day before, so no event records it; event 21, `request.opened`, when the terminal session's Claude opened BE-1 through MCP; and event 22, `request.message_posted`, when the maintainer posted a question on BE-1 in the web UI. The question woke the idle terminal session once, with the waiter's reminder alone, and a new session listed nothing already announced, so the main change's tasks 17.7 and 19.20 are checked off on this run; 19.19 stays open until the maintainer approves item (8).

**Current state.** The hooks are built as the main change's T15 and its requester-loop requirements say. `decisions-from-groups-15-28`, which nobody has approved or built yet, changes the scope of a user's updates (its D55 (43) to (46)) and the hooks' cursors (D55 (44)). This change starts from that change's text where both modify one requirement, and narrows its D55 (43).

**How the specs cite this document.** Every `Source:` line in `specs/*/spec.md` names the finding and its items in this document, such as `design.md, Findings: F1 (2)`, the technical decision that builds it, and, for a MODIFIED requirement, `design.md, Rules carried from earlier changes`, which says where its unchanged parts keep their sources.

**Constraints.**
- A MODIFIED requirement repeats its heading exactly and keeps every scenario it had, starting from the text of the latest change that modifies it: `decisions-from-groups-15-28` for "What whats_new covers", and `add-tiehall-oss-v1` for "News is announced once", "Proposal outcomes reach the proposing agent" and "The Claude Code plugin".
- The server keeps no state per Claude Code session (the main change's T15): what a session follows, and what it was told, stay on the user's machine.
- Pull stays the contract: items (1) to (3), (5) and (6) change only which session is told first, never what a pull reader returns; item (4) changes what the readers return, before the first release, with D55 (43).
- Nothing new calls a model or any host but the install. The plugin and the CLI stay Apache-2.0 and import no server code.

## Goals / Non-Goals

**Goals:**
- News on a request reaches the Claude Code session that worked on it, and not a session that has nothing to do with it.
- An agent is never woken, or told, of what it or another agent of its user did, and still hears what its person decided in the web UI.
- The plugin reaches the same install from every Claude Code surface, and its hooks never read from another.
- A message is recorded for the side its poster works on.
- The checks the run did not make are planned, with a second person.

**Non-Goals:**
- Following requests in clients without the Claude Code hooks: Codex, Cursor and Copilot pull.
- Subscriptions kept by the server, Claude Code channels, or an event stream.
- A way for a poster to pick the side of a message (F4, option B).
- The side a proposal records for a person on both sides, which requests: Cross-team commitments need a confirmation from each side keeps (Open Questions).

## Decisions

### Findings and recommended rules

Each finding states the problem, the run's evidence and the options, the recommended one first, then the rules of that option with their reason and what they give up. The rules are numbered (1) to (9) across the findings, as "Decisions to approve" lists them.

#### F1. News reaches a session that did not work on the request

- **Problem.** A plugin installed for the user runs its hooks in every Claude Code session of that user on the machine, sessions of the Claude desktop app's Code tab included. The mark of the news announced is one per user and install (requester-loop: News is announced once), so the first waiter, or the first SessionStart digest, to see an update announces it, and every other session's waiter treats it as announced. Which session hears of an update is a race between the sessions that happen to be idle, whatever each was working on.
- **Evidence.** Update 21, the opening of BE-1, which the terminal session's Claude had just made, woke the Claude of a session in the desktop app; the terminal session was never told of it. Update 22, the question on BE-1, woke the terminal session. The mark, `announced.json` in the CLI's configuration folder, held 22 afterwards.
- **Options.**
  - **A, recommended: a session's project folder follows the requests its agent works on.** A PostToolUse hook records which requests each project folder's sessions read, opened, asked on, claimed or changed through the plugin's tools; news on such a request is told in the sessions of those folders, once in each, and in no other session; news on a request no folder follows keeps today's rule.
  - B: every session is told, with a mark per Claude Code session. No session misses news, but every idle session of the user wakes for every update, unrelated ones included, and each spends a turn on it: F1's second harm grows with the number of sessions.
  - C: advise installing the plugin for one project. Fewer unrelated sessions, but two sessions of one project still race, and every user-scope install keeps the race.
  - D: let the server route news to sessions. The MCP connection does not name the Claude Code session it serves, the hooks and the MCP connection are separate clients, and the server would keep state per session, which T15 rules out.
  - E: keep the mark as built, and document the race.
- **Rules.**
  - **(1)** The plugin registers a PostToolUse hook for its own MCP tools that runs `tiehall hook follow`. After a call of `get_request`, `open_request`, `post_message`, `claim`, `set_status`, `link_pr`, `propose` or `attach_contract_changes` that succeeded, it records on the user's machine, for the user and the install, that the session's project folder follows the request the call named, by key or by URL on the install, or, for `open_request`, the request the call opened. `whoami`, `directory`, `list_inbox` and `whats_new`, and a call that failed, make no folder follow anything. The hook writes nothing that reaches Claude, does not block or change the call, calls no install, acknowledges nothing, and stays quiet without the CLI, like the other hooks.
  - **(2)** The CLI keeps a mark per user, install and project folder beside the mark per user and install. An update on a request that one or more of the user's folders follow is announced once in each of those folders, by the SessionStart digest or the Stop-hook waiter of a session in that folder, whichever sees it first, and never in a session whose folder does not follow the request; that session's waiter keeps waiting past it. An update on a request that no folder follows is announced once for the user and install, by the first digest, waiter or `tiehall watch` that sees it, as built. `tiehall watch`, which runs outside Claude Code, reads and adds to the mark of the user and install only. No mark acknowledges anything.
  - **(3)** The plugin's docs say that a plugin installed for the user runs its hooks in every Claude Code session of that user, the desktop app's included, that a plugin installed for a project runs them only in that project's sessions, and that a session's folder follows the requests its agent works on.
- **Why.** The session whose agent opened, read, asked on or claimed a request has the context to act on its news. The project folder is what Claude Code gives every hook, it outlives `/exit` and a new session in the same project, and it needs nothing on the server. News on a request that no session worked on, such as a new request addressed to the user's team or a request opened in the web UI, has no better session, so it keeps today's rule. Should Claude Code stop giving the hook what it reads, nothing is followed, and every update falls back to today's rule.
- **What it gives up.** A followed request's news waits for a session in its folder: while none runs, another project's idle session is not woken for it, and the user learns of it from that folder's next SessionStart digest, from `whats_new` or `tiehall updates` anywhere, from the web inbox, or by email.

#### F2. An agent's own writes are its user's updates

- **Problem.** The scope of `whats_new` holds every event on a request the user opened, claimed or is accountable for, the user's own events included (requester-loop: What whats_new covers). So the waiter wakes Claude for what Claude itself just did, and the SessionStart digest lists the user's own work.
- **Evidence.** Update 21, the `request.opened` that the terminal session's Claude had made through MCP a moment before, woke the desktop app's session (F1). After its own wake, the terminal session's `whats_new` listed update 21 beside the question. The first session's SessionStart digest listed 14 updates on FE-1 and FE-2, all made by the install's one person: 5 by Claude through MCP (events 13 to 17) and 9 in the web UI (events 4 to 10, 18 and 19).
- **Already proposed.** `decisions-from-groups-15-28`'s D55 (43) leaves out of `whats_new`, `tiehall updates`, the wait endpoint, the hooks, the digest and the web inbox's update feed every event whose accountable human is the user, "what they or their agents did". That settles the run's case, but it also leaves out what the user did in the web UI, the only place commitments are confirmed (the main change's S7): their confirmation of their agent's proposal, which requester-loop: Proposal outcomes reach the proposing agent requires to reach that agent ("A confirmed decline": Dana's agent proposes declining FE-142, Dana confirms it in the web UI, and the next `whats_new` call by Dana's agent includes the confirmation), and their answer to a question that blocks their agent's work. Both D55 (43) and item (4) also meet that requirement's endings, which it sends to the accountable human's `whats_new`, web inbox's update feed and daily digest whoever ended the proposal, so item (4) modifies that requirement as well.
- **Options.**
  - **A, recommended: leave out what the user's agents did, and keep what the user did in the web UI, for the agents' readers.** `whats_new`, `tiehall updates`, the wait endpoint and the hooks leave out every event that one of the user's agents made, recorded with the actor kind `agent` and the user as its accountable human, on any surface; events the user made in the web UI, recorded with the actor kind `web_session`, stay in. The readers people read, the web inbox's update feed and the daily digest, leave out every event of the user, as D55 (43) says.
  - B: D55 (43) as written. It drops the web confirmations that the requirement on proposal outcomes needs, and on an install of one person no hook ever wakes.
  - C: leave out only the writes of the reading client. The hooks read with the CLI's client while Claude writes through its MCP client, so the run's wake stays.
  - D: keep the scope as built.
- **Rule.**
  - **(4)** As option A. It narrows D55 (43), and where both are built, this item governs. A proposal's endings follow it too. requester-loop: Proposal outcomes reach the proposing agent sends every ending to the accountable human's `whats_new`, web inbox's update feed and daily digest; under this item, an ending that one of the accountable human's agents made, such as a withdrawal through the agent, is left out of `whats_new`, and one that the accountable human made, in the web UI or through an agent, is left out of the web inbox's update feed and the daily digest.
- **Why.** An agent needs to hear what other people and their agents did, and what its own person decided in the web UI; it never needs to hear what it, or another agent of its user, did. A person needs neither in their inbox or their email. The server stamps the actor kind of every event (requests: Provenance is stamped by the server), so the rule needs no new data. A run like this one on an install of one person keeps working: a question posted in the web UI still wakes the session.
- **What it gives up.** What the user did in the web UI stays news to their agents, so the SessionStart digest still lists it and the waiter still wakes Claude for it. In the run, the digest would still have listed the 9 updates the maintainer made in the web UI, and only the 5 that Claude made would have gone. Leaving those out too is option B, which loses the confirmations and answers an agent waits for.

#### F3. The shell's `TIEHALL_URL` does not reach the Claude desktop app

- **Problem.** The plugin's MCP connection is `${TIEHALL_URL}/mcp`, which Claude Code expands from the environment it was started in, and the plugin's docs say to set `TIEHALL_URL` there. The Claude desktop app is not started from the user's shell and does not read its startup file. The plugin's launcher, given no `TIEHALL_URL`, runs the CLI without `--install`, and the CLI then reads from its only saved login.
- **Evidence.** In the desktop app's Code tab, the plugin's MCP server failed with `INVALID_CONFIG`, "Missing environment variables: TIEHALL_URL", while in the terminal it connected. The hooks still ran in the desktop app, through the CLI's saved login: that session read news from an install whose tools it could not reach, and its waiter took update 21 (F1).
- **Options.**
  - **A, recommended: Claude Code's own configuration of the plugin.** The plugin manifest of Claude Code 2.1.296 has a `userConfig` key: options that Claude Code asks for when the plugin is enabled, keeps in its own settings, substitutes for `${user_config.<key>}` in the plugin's MCP configuration and hook commands, and gives the plugin's hooks as `CLAUDE_PLUGIN_OPTION_<KEY>` in their environment. The plugin asks for `install_url` there; its MCP connection is `${user_config.install_url}/mcp`, and its launcher reads `CLAUDE_PLUGIN_OPTION_INSTALL_URL`. Whether the desktop app's Code tab asks for the option, keeps it and passes it on is checked first, in a real Claude Code (task 1.1); if it does not, item (5) takes option B before anything is built.
  - B: keep `TIEHALL_URL`, and have the docs set it in Claude Code's own settings rather than the shell, where every surface reads it, once a check finds that the desktop app gives those settings to the plugin's MCP configuration; the user edits a settings file by hand.
  - C: a `tiehall` command that writes the URL into Claude Code's settings, the other path that the main change's spike 1.9 names. The CLI would edit another program's configuration.
  - D: docs, for each operating system, on putting a variable where desktop apps see it. Different on each system, and lost after some restarts.
- **Rules.**
  - **(5)** The plugin asks for the install's URL through Claude Code's configuration of the plugin, and its MCP connection and its hooks both take it from there, whatever environment Claude Code was started in.
  - **(6)** The hooks read only from the install the plugin was given. Without a URL they never fall back to a saved login of the CLI: the SessionStart hook prints one fixed line in Tiehall's words that says the plugin has no install URL and how to give it, and the other hooks do nothing.
- **Why.** The user gives the URL once, as the plugin requirement already says, and it then holds in every surface that runs the plugin. The hooks and the MCP connection can no longer disagree about the install, and a session that cannot reach the install's tools takes no news from them. A user who set `TIEHALL_URL` in the shell before learns from the SessionStart line what to do.

#### F4. A claimant who opened the request asks for the requesting side

- **Problem.** Which team a message is recorded for is decided by `teamActedFor` in `packages/commands/src/request-changes.ts`: the requesting team for the user who opened the request, then the target team for one of its members, then the requesting team for one of its members. So a person who opened a request and then claimed it as a member of the target team still has every message recorded for the requesting team, though they now work on the request as the target team's claimant. No requirement says which team a message is recorded for: requests: Provenance is stamped by the server names the team among a message's provenance, without a rule for choosing it.
- **Evidence.** Seen by hand earlier on the same install: a person in both teams had their questions recorded for the requesting side when they asked as the claimant. In the run, BE-1 had no claimant, and the maintainer's question, posted in the web UI, was recorded with the team FE, since the maintainer opened BE-1 for FE, though the maintainer is also a member of BE.
- **Why it matters.** The recorded side says who asked and who is asked: a question of the target team is asked of the requester side, and one of the requester side of the claimant, which is whom its email goes to (requester-loop: Email for people, only when SMTP is set). It is also how the thread shows the message, and the origin with which other people's agents read it fenced.
- **Options.**
  - **A, recommended: the claim decides.** On a claimed request, the messages of its claimant, while a member of the target team, are recorded for the target team, even when the claimant opened the request or belongs to the requesting team. Otherwise as built.
  - B: the poster names the side, through an optional team on `post_message`, the CLI's `ask` and `reply` and the web UI's form. Precise, but the payload would choose part of the provenance, which requests: Provenance is stamped by the server keeps to the server, and every surface gains an input for a rare case.
  - C: a person on both sides must name the side, or is refused with 400, as the main change's R14 does for opening a request. One more step on every message for such a person.
  - D: keep it as built, and document it.
- **Rule.**
  - **(7)** As option A.
- **Why.** Claiming is how a person takes up a request for the target team; from then on they work on it as the target team's claimant, and their questions go to the requester side. Before a claim, the person who opened the request speaks for the side that asked. The rule needs no input and stays stamped by the server.

#### The run's own records

- **(8)** The main change's task 19.19, open until the maintainer approves this item, is then checked off on this run, with its limits named in its note: the maintainer's own question stood in for another person's, which the waiter as built treats alike, and `/hooks`, the SessionEnd hook, the waiter's cap and a wake late in the 30 minutes were not exercised. Should the maintainer not approve this item, 19.19 stays open until a run with another person's question checks it off. This change's task 1.10 re-runs the hooks, once items (1) to (7) are built, with a second person, two sessions in two folders, the lowered cap and a late wake.
- **(9)** The client-matrix log is `docs/client-matrix/log.md`: one dated entry per task a run verifies, in the form its opening describes, which `CONTRIBUTING.md` names. The matrix of the main change's group 27 adds its table of cells there. The main change's task 28.3 left the place to 27.1; the run of 17.7 needed it first.
- **Why.** The run met the checks that 19.19's own line names, but for its question coming from another user, which the waiter as built treats like the user's own, and what it did not check is planned with a second person, which item (4) still allows on an install of one person. The log needed a place before the matrix runs, and a folder of its own leaves room for the matrix's records beside it.
- **Alternatives.** *Leaving 19.19 open until the re-run:* the hooks' live behavior is shown, and the open checks are tracked here. *One file per run, as the security reviews are kept:* a log that tasks point to by date reads more easily as one file.

### Rules carried from earlier changes

The MODIFIED requirements keep every sentence and scenario they had, except where an item changes them, and add their new sentences and scenarios:
- requester-loop "What whats_new covers", from `decisions-from-groups-15-28`'s text: item (4) replaces its sentence on the user's own events and adds the sentence on the readers people read, with three scenarios. Its other parts rest on the sources its earlier `Source:` line cites, D14, D28 #58, #60, #62 and #75, D29 (5), and D55 (43), (45) and (46), restated in the main change's design.md under "Decisions this change rests on" and "Design rules: Contract changes", and in `decisions-from-groups-15-28`'s design.md.
- requester-loop "News is announced once", from the main change's text: items (1) and (2) change the mark, with five scenarios added. Its other parts rest on the main change's T15.
- requester-loop "Proposal outcomes reach the proposing agent", from the main change's text: item (4) changes which readers a proposal's ending reaches, with three scenarios added. Its other parts rest on D23, D28 #16 and #61, D30 (4) and S10, restated in the main change's design.md under "Decisions this change rests on" and "Self-hosting decisions".
- agent-surfaces "The Claude Code plugin", from the main change's text: items (5) and (6) change how the URL is given and what the hooks read without it, with two scenarios added. Its other parts rest on D8 and D28 #63, and on the main change's design rules for agent surfaces, T15 and S15.

### Text corrections to earlier changes

Applied by this change's task 1.11, once the maintainer approves this change; each is a text edit, with no effect on any spec beyond this change's deltas.
- `add-tiehall-oss-v1`'s design.md: in T15, "Changed" says that the hooks read from the install the plugin's configuration names and never from another saved login (items (5), (6)), that the announced mark is kept per user and install and per project folder, and that a PostToolUse hook makes a folder follow a request (items (1), (2)); "Where the specs leave room" says that the plugin reaches the install through its configuration (item (5)), and the Open Question on the plugin's MCP connection records it.
- `add-tiehall-oss-v1`'s tasks.md: the notes of 1.9 and 17.6 say that the plugin's MCP connection takes the URL from its configuration, and why (F3), keeping their checkboxes.
- `decisions-from-groups-15-28`'s design.md: D55 (43) and item 43 of its "Decisions to approve" say that its rule is narrowed by item (4) of this change; its tasks.md: task 1.35 names this change's task 1.3, with which it is built.

### Technical decisions

#### T1. The follow hook

- **Choice.** `hooks/hooks.json` gains a `PostToolUse` hook whose matcher takes the plugin's server's tools and those of a server added by hand under the name `tiehall`, `^mcp__(plugin_tiehall_)?tiehall__(get_request|open_request|post_message|claim|set_status|link_pr|propose|attach_contract_changes)$`, and which runs `sh "${CLAUDE_PLUGIN_ROOT}/hooks/tiehall-hook.sh" follow` with a timeout of 10 seconds. `tiehall hook follow` reads Claude Code's input on its standard input: `tool_name`; `tool_input`, whose `key`, or `request` for `get_request`, names the request by key or by URL on the signed-in install; `tool_response`, whose structured content gives the key that `open_request` opened and shows a failed call; and the project folder, from `CLAUDE_PROJECT_DIR`, or else the input's `cwd`. It writes `follows.json`, beside `announced.json` in the CLI's configuration folder, mode 0600, under the marks' lock: by install URL and user, each folder's request keys with when each was last followed. It writes no output and exits with 0 whatever happens, and the launcher ends `follow` with 0 too, so a CLI without the command stays quiet.
- **Why.** PostToolUse is the hook Claude Code runs after each tool call, with the call's input and result. The run's transcript shows the plugin's tools as `mcp__plugin_tiehall_tiehall__<tool>`. Everything the hook needs is in its input, so it calls nothing.
- **Alternatives.** *Reading the session's transcript at the end of each turn:* a file whose form Claude Code does not promise. *Following by the session's id:* a new session in the same project would not follow anything, and `/exit` would lose it all.

#### T2. Marks per folder

- **Choice.** In `announced.json`, each user's entry gains `folders`, each folder's number of the last update announced there; the user's `through` stays the mark of the user and install. A digest or a waiter in folder P reads the user's updates after the cursor, and `follows.json`: it announces each update whose request P follows and whose number is above P's mark, and each update whose request no folder follows and whose number is above the user's mark, and before it announces them it adds them, under the lock, to P's mark and the user's. A folder's mark starts at the user's mark when the folder first follows a request. A waiter moves its long-poll cursor past updates it may not announce, as it does past announced ones. `tiehall watch` reads and adds to the user's mark only.
- **Why.** Each reader reads updates in order, so a number per folder holds what that folder was told, as the user's number does today; the files stay small and local.
- **Alternatives.** *A set of announced numbers per folder:* larger, for nothing the order does not already give.

#### T3. The readers' scope

- **Choice.** The scope query of `packages/commands/src/updates.ts`, which `whats_new`, `tiehall updates` and the wait's wake-ups share, leaves out events with the actor kind `agent` whose accountable human is the reader; the web inbox's update feed and the daily digest leave out every event whose accountable human is the reader. This replaces the filter that `decisions-from-groups-15-28`'s T6 states for D55 (43).
- **Why.** The actor kind is on every event's provenance already.

#### T4. The plugin's configuration

- **Choice.** The manifest declares one option in `userConfig`, `install_url`, not sensitive, described as the install's URL, in the form Claude Code's manifest reference gives, which task 1.1 confirms. `.mcp.json` points at `${user_config.install_url}/mcp`. The launcher reads `CLAUDE_PLUGIN_OPTION_INSTALL_URL` and passes it as `--install`; without it, it prints, for `session-start`, one line of its own, such as "Tiehall: the plugin has no install URL. Give it in the plugin's options with /plugin, then start a new session.", and does nothing for the other hooks. `TIEHALL_URL` is no longer read by the plugin. `pnpm check:plugin` learns the `userConfig` key and the new MCP URL. The plugin becomes 0.3.0 with items (1), (2), (5) and (6); `MINIMUM_PLUGIN_VERSION` stays, since an older plugin still pulls.
- **Why.** One value, kept by Claude Code, serves the MCP connection and the hooks in every surface; the launcher prints its line itself, so it needs no CLI and no install.

#### T5. The side of a message

- **Choice.** `teamActedFor` in `packages/commands/src/request-changes.ts` takes the claimant first for messages: `post_message` records the target team for the request's claimant while they are a member of it, and otherwise the team the rule as built gives. An edit keeps the message's team. Other writes and proposals keep the rule as built.
- **Why.** The smallest change that makes the claim decide, inside the server's stamping.

### Where the specs leave room

- The wording of the SessionStart line of item (6), and of the option's description in Claude Code's dialog.
- When a folder stops following a request, such as 30 days after the request reached a terminal state, and how `follows.json` is pruned.
- The exact matcher of the follow hook, as long as it takes the eight tools and no other.

## Risks / Trade-offs

- [A followed request's news waits while no session runs in its folder] → `whats_new` and `tiehall updates` in any session, the web inbox and email still hold it, and the folder's next SessionStart digest lists it.
- [A user runs every session from one folder, such as their home folder] → that folder follows everything, and the hooks behave as today.
- [Claude Code changes the PostToolUse input or the names of plugin tools] → nothing is followed, and every update falls back to today's rule, the first session to see it.
- [The desktop app does not ask for, keep or pass the plugin's option] → task 1.1 checks it before anything is built, and item (5) then takes option B.
- [An agent that drives the user's signed-in browser acts as a web session, so under item (4) its writes reach its own session's readers] → as with the confirmation step, the docs advise keeping agents out of that browser profile.
- [A user who set `TIEHALL_URL` in the shell updates the plugin] → the SessionStart line says the plugin has no install URL and how to give it.

## Migration Plan

No install exists yet, so nothing on a server migrates. On users' machines, `follows.json` is a new file, and the existing mark in `announced.json` stays the mark of the user and install, from which each folder's mark starts. Plugin 0.3.0 asks for the install's URL instead of reading `TIEHALL_URL`. No `/api/v1` operation, MCP tool or packet field changes; item (4) changes what `whats_new`, `tiehall updates` and the wait endpoint return, before the first release, as D55 (43) does. This change is archived after `add-tiehall-oss-v1` and `decisions-from-groups-15-28`, whose texts of the same requirements it starts from.

## Open Questions

- **Following from the CLI's commands.** Whether `tiehall get`, `open`, `ask`, `reply`, `claim`, `status` and `link-pr`, when Claude runs them through its shell tool, also make the session's folder follow the request, through a PostToolUse hook on the shell tool or through the folder the command runs in.
- **Following across a reassignment.** A reassigned request gets a new key (requests: Reassignment gives a new key and the old key redirects); whether the folders that followed the old key follow the new one once the hooks see the reassignment.
- **A plugin loaded with `--plugin-dir`.** Whether Claude Code asks for its options; task 1.1 records it, and the docs' way to try the plugin from a checkout follows.
- **The side a proposal records for a claimant who opened the request.** The requester side today, as requests: Cross-team commitments need a confirmation from each side defines; whether the claim should decide there too.

## Decisions to approve

**Approved by the maintainer on 2026-10-12:** every item below, with its recommended option, as written here. Item (4) narrows `decisions-from-groups-15-28`'s item 43, approved the same day, and governs where both are built; this change's task 1.3 is built with that change's task 1.35.

1. A PostToolUse hook makes a session's project folder follow each request its `get_request`, `open_request`, `post_message`, `claim`, `set_status`, `link_pr`, `propose` and `attach_contract_changes` calls name or open, silently and without calling the install.
2. An update on a followed request is announced once in each folder that follows it and in no other session; one on a request no folder follows once for the user and install, as built; `tiehall watch` keeps the mark of the user and install.
3. The plugin's docs say where a plugin installed for the user or for a project runs its hooks, and that a session's folder follows the requests its agent works on.
4. `whats_new`, `tiehall updates`, the wait endpoint and the hooks leave out what the user's agents did and keep what the user did in the web UI, so the digest and the waiter still announce the user's own web actions; the web inbox's update feed and the digest leave out every event of the user. A proposal's endings follow the same rule, so a withdrawal through the agent is not news to it. This narrows D55 (43).
5. The plugin asks for the install's URL through Claude Code's configuration of the plugin, for its MCP connection and its hooks, once a real Claude Code shows that the terminal and the desktop app both honor it.
6. Without an install URL the hooks read nothing, and the SessionStart hook prints one fixed line saying how to give it.
7. On a claimed request, the claimant's messages, while a member of the target team, are recorded for the target team.
8. Task 19.19, open until this item is approved, is checked off on the run of 2026-10-11, with its limits named, and a re-run with a second person, two sessions, the lowered cap and a late wake follows once the items are built.
9. The client-matrix log is `docs/client-matrix/log.md`, one dated entry per task a run verifies.

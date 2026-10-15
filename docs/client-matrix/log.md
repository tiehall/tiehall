# Client-matrix log

The maintainers' record of each run of Tiehall against a real agent client, made by hand on their own accounts: the client matrix that [CONTRIBUTING.md](../../CONTRIBUTING.md#running-the-client-matrix) describes, and the plan's checks against one real client, such as the Claude Code plugin's and its hooks'. A task of the plan that is verified by "the committed record in the client-matrix log" points to its entry here.

## How an entry is written

- One entry per task a run verifies, added at the end of this file under a level-2 heading that starts with the run's date: `YYYY-MM-DD: <what was checked> (task <number>)`. A run that verifies two tasks has two entries, and the second may point to the first for what they share.
- First its fields: **Date**, with times in UTC; **Client**, with its version and how it was started; **OS**; **Install**, with its URL, the commit its image was built from, and its people and teams; **CLI**, when the run used it; and **Task**, with the requirements the task names.
- Then four sections: **Steps**, what was done, in order; **Seen**, what the client and the install showed, quoted where the exact text matters, with the numbers of the events the install recorded; **Not exercised**, each check of the task the run did not make; and **Findings**, each with where it is taken up, a task of the plan or an OpenSpec change.
- Only what was observed goes in. Text that people wrote on a request is not copied here; request keys, event numbers and types, and Tiehall's own words are.
- A run of the matrix itself (group 27 of the plan) adds a table with a result in every cell: the client, the protocol version, the sign-in path that worked or the failure, and the number of tools the client showed against the server's count.

## 2026-10-11: The Claude Code plugin against a local install (task 17.7)

- **Date:** 2026-10-11, from 20:49 to 20:59 UTC.
- **Client:** Claude Code 2.1.296, the interactive CLI in a terminal, with the model Fable 5.1, started in the folder of another project, not this repository, with `TIEHALL_URL=http://localhost:3000` exported from the shell's startup file. For one observation, also a session of the Claude desktop app's Code tab on the same machine, whose version was not recorded.
- **OS:** macOS 27.0.1 (Darwin 27.0.0), the maintainer's Mac.
- **Install:** the maintainer's local Docker Compose install at the trial URL `http://localhost:3000`, its image built from `main` at commit `54d4139`; one company with two teams, FE and BE, and one person, the maintainer, a member of both.
- **CLI:** `tiehall` from the same commit, built with `pnpm --filter tiehall build` and installed with `npm install -g` from `packages/cli` (an npm link), signed in with `tiehall login http://localhost:3000` through the device flow: the code was approved on `/device`, whose page said the CLI was signed in, and the install recorded security event 20, `agent_client.approved`, for the CLI's client, `tiehall-cli`, at 20:47:45 UTC. Before `54d4139` the same login failed with "refused the CLI's sign-in"; commits `dd6804e` to `54d4139` (task 15.12, the token endpoint's limit) fixed it.
- **Task:** 17.7 [agent-surfaces: The Claude Code plugin].

### Steps

1. Removed an earlier MCP entry for Tiehall, added by hand: `claude mcp remove tiehall -s user`.
2. In a Claude Code session, at 20:49 UTC, ran `/plugin marketplace add <a checkout of this repository>` and `/reload-plugins`, and at 20:50 `/plugin install tiehall@tiehall`, at user scope. Then restarted Claude Code.
3. In the new session, ran `/mcp`: the plugin's server, `plugin:tiehall:tiehall`, asked to sign in, and the sign-in went through the install in the browser.
4. Asked Claude, in Turkish, to open a request to team BE that adds a currency field to an endpoint, and to stop once it was open.

### Seen

- `/plugin marketplace add` answered "Successfully added marketplace: tiehall", and `/plugin install` "Installed tiehall. Plugin is now active."
- `/mcp` answered "Authentication successful. Connected to plugin:tiehall:tiehall." at 20:50:50 UTC. The install recorded no new approval for it: the maintainer's approval of Claude Code's client, `https://claude.ai/oauth/claude-code-client-metadata`, its Client ID Metadata Document, dated from 2026-10-10 (security event 12) and was unchanged, and the install recorded no `agent_client.approved` between the CLI's sign-in, event 20, and BE-1's opening, event 21.
- Claude loaded the skill: `Skill(tiehall:tiehall)`, "Successfully loaded skill", from the plugin's `skills/tiehall` folder.
- As the skill teaches, Claude called `whoami` with the skill's version, 0.1.0, and `whats_new`, which answered no updates; it called `directory` to find team BE, then `open_request` with the requesting team FE and the target team BE. The install recorded event 21, `request.opened`, for BE-1, on the surface `mcp`. Claude answered with BE-1's URL, `http://localhost:3000/BE-1`, and stopped.
- Claude Code offered the plugin's tools under its names for a plugin's MCP server, `mcp__plugin_tiehall_tiehall__<tool>`.
- In the Claude desktop app's Code tab, which does not read the shell's startup file, the same plugin's MCP server failed with `INVALID_CONFIG`, "Missing environment variables: TIEHALL_URL". The plugin's hook launcher still ran there: without `TIEHALL_URL` it runs the CLI without `--install`, and the CLI then reads from its only saved login (finding F3).

### Not exercised

- The plugin came from a local checkout's marketplace file, not from GitHub with `claude plugin marketplace add muhmmdcnkl/Tiehall`, and not at a release tag.
- `/hooks` was not opened; the hooks' run is the next entry.
- Whether a later session reuses the MCP connection without signing in again was not recorded.
- The protocol versions, Dynamic Client Registration and `TIEHALL_CLIENT_METADATA_FETCH=off` belong to the client matrix, group 27.

### Findings

- F3. In the Claude desktop app, the plugin's MCP connection gets no install URL, because the app does not read the shell's environment, while the plugin's hooks fall back to the CLI's only saved login, so the hooks and the MCP connection can disagree about the install. The docs only say to set `TIEHALL_URL` in the environment Claude Code starts in. Taken up in the OpenSpec change `findings-from-claude-code-run`.

## 2026-10-11: The Claude Code hooks against a local install (task 19.19)

- **Date:** 2026-10-11, from 20:50 to about 21:05 UTC.
- **Client:** Claude Code 2.1.296, the interactive CLI in a terminal, with the model Fable 5.1, as in the entry above. The plugin, version 0.2.0, was installed from the marketplace file at user scope, so its hooks ran in every Claude Code session of the maintainer on the machine, the Claude desktop app's Code tab included.
- **OS:** macOS 27.0.1 (Darwin 27.0.0), the maintainer's Mac.
- **Install:** as in the entry above: `http://localhost:3000`, built from `54d4139`, with the teams FE and BE and one person, the maintainer, a member of both.
- **CLI:** as in the entry above, signed in to the install; the plugin's launcher ran it with `--install http://localhost:3000`.
- **Task:** 19.19 [requester-loop: Claude Code Stop-hook waiter; requester-loop: News is announced once; requester-loop: Claude Code SessionStart digest], which also gives task 19.20 the live wake-up it waits for.

### Steps

1. Started a Claude Code session in the terminal, after the plugin's install of the entry above, at 20:50 UTC.
2. In that session Claude opened BE-1 for team FE (event 21), and its turn ended at 20:52:48 UTC.
3. At 20:54:15 UTC, posted a question that does not block on BE-1 in the web UI (event 22, `request.message_posted`). The install has one person, the maintainer, who opened BE-1 and is a member of its target team BE, so the maintainer posted it, standing in for another user.
4. Wrote nothing more in the session once the turn that Claude was woken for had ended.
5. Ended the session with `/exit`, started `claude` again in the same folder, and ran `tiehall updates`.

### Seen

- When the first session started, its SessionStart hook printed Tiehall's digest: the line "Tiehall: updates on your requests are waiting. Read them with whats_new, or run tiehall updates, and acknowledge what you have handled." and 14 entries on FE-1 and FE-2, two requests made on this install before the run, each a request key, an event type, the team and the request URL, such as `FE-1 request.opened (team FE) http://localhost:3000/FE-1`.
- Claude was woken once, at 20:54:15 UTC, less than a tenth of a second after the install recorded the question, while the session was idle, as "Stop hook feedback". The reminder, as the session's transcript holds it:

  ```text
  Stop hook blocking error from command "Stop": Tiehall: news on your requests. Read it with whats_new, or run tiehall updates, and acknowledge what you have handled.
  BE-1 request.message_posted (team BE) http://localhost:3000/BE-1
  ```

  It held Tiehall's own words and the request key, the event type, the team and the URL, and no word of the question.
- Claude said it would read the message and pass it on without writing on the request. Its `whats_new` call listed event 21, `request.opened`, and event 22; it read BE-1's thread with `get_request`, acknowledged up to event 22 through `whats_new`, which moves only its MCP client's cursor, and reported the question to the maintainer. The question was recorded with the actor kind `web_session`, the surface `web` and the team FE; BE-1 stayed `open`, with no claimant.
- No second wake: the Stop hook ran again when the woken turn ended, at 20:54:49 UTC, and nothing woke Claude in the three and a half minutes to the session's last recorded event, at 20:58 UTC.
- The new session announced nothing: its SessionStart digest printed no line, and the CLI's mark of the news announced, `announced.json` in its configuration folder, stayed at 22. `tiehall updates` still listed update 22: the CLI client's cursor had never been acknowledged and stood at 0.
- Update 21, BE-1's opening, did not reach the terminal session that opened it. It woke the Claude of a session in the desktop app's Code tab, whose waiter saw it first; the mark is one per user and install, so the terminal session's waiter then treated it as announced (finding F1). Both updates were the maintainer's own: Claude made the first through MCP in the terminal session, and the maintainer the second in the web UI (finding F2).

### Not exercised

- A question from another person: the install has one person, so the maintainer's own question stood in. The waiter as built wakes for every update in its user's updates, whoever made it, so it treats the two alike. D55 (43) of the OpenSpec change `decisions-from-groups-15-28`, not built yet, would leave a user's own events out of their updates; under it, a run like this one needs a second person. Task 19.19 asks for another user's question, so it stays open until the maintainer accepts this stand-in, item (8) of the OpenSpec change `findings-from-claude-code-run`, or a run with a second person checks it.
- `/hooks` was not opened, so the list of the plugin's SessionStart, Stop and SessionEnd hooks is not recorded; the SessionStart and Stop hooks are seen running above, and the SessionEnd hook is not seen.
- The waiter's cap, with `TIEHALL_HOOK_WAIT_CAP_SECONDS=180`, and a late wake, 12 minutes or more after a turn ends, which checks that Claude Code keeps the Stop hook's 1900-second timeout.
- Two terminal sessions at once; the desktop app's session took part only as finding F1 describes.

### Findings

- F1. A plugin installed at user scope runs its hooks in every Claude Code session of the user on the machine, sessions of the Claude desktop app's Code tab included. The announced mark is one per user and install, so the first waiter to see an update announces it and every other session's waiter treats it as announced: the news can reach a session that has nothing to do with the request, while the session that worked on the request is never told.
- F2. The scope of `whats_new` holds the actions of the user's own agent, every event on a request the user opened, so a waiter can wake Claude for something Claude itself just did, such as its own `request.opened`: the desktop app's wake of F1.
- F4. A person in both teams has their questions recorded for the requesting side even when they ask as the claimant, as seen by hand earlier on this install. In this run BE-1 had no claimant, and the question was recorded for FE, the requesting team of the person who opened BE-1.

All three, with F3 of the entry above, are taken up in the OpenSpec change `findings-from-claude-code-run`, which nothing builds before the maintainer approves it.

## 2026-10-15: Cursor's sign-in against a local install (task 27.5)

- **Date:** 2026-10-15, at 23:31 and again at 23:33 by the clock of Cursor's MCP log, which does not give its time zone.
- **Client:** Cursor, its MCP client, with Tiehall added as the remote MCP server `tiehall` over streamable HTTP in Cursor's user settings, which the log names `user-tiehall`. Cursor's version was not recorded.
- **OS:** the maintainer's machine; the log does not name it.
- **Install:** the maintainer's local Docker Compose install, its image built from `main` at `e021cbc9`, whose code `0a0738b4`, the next commit, leaves unchanged; its URL is not in the log.
- **Task:** 27.5 [agent-access: Dynamic Client Registration stays on, limited and unverified; agent-access: The consent screen shows who is asking], a failure on Tiehall's side found ahead of the matrix run of task 27.1, triaged as task 27.3 says.

### Steps

1. Cursor started its MCP client for `tiehall`, at 23:31:50, and again at 23:32:58 and 23:33:24.

### Seen

- At 23:31:50 the log recorded two HTTP exchanges with the install, then "Transient error connecting to streamableHttp server: web clients require https redirect URIs on non-loopback hosts: cursor://anysphere.cursor-mcp/oauth/callback", "Connection failed" and the state `conn=failed`.
- At 23:33:24 the client's creation ended with `connected=false` and `statusType=error`, with the same error. At 23:33:58 Cursor's own process timed out creating the client again.
- The error is the install's sign-in library's refusal of a Dynamic Client Registration for its redirect URI, the one a registration gets as a web client's, as one that names no `application_type` is: Cursor registered `cursor://anysphere.cursor-mcp/oauth/callback`, the redirect URI of its own app, and Tiehall took only a scheme that holds a dot as a native app's. The connection ended there, before any authorization request, and Cursor did not connect.

### Not exercised

- The sign-in after the fix: the re-run with Cursor waits until the maintainer's install is updated to a build with task 27.5, and belongs to the matrix run of task 27.1.
- The protocol version Cursor spoke, a metadata document, `TIEHALL_CLIENT_METADATA_FETCH=off`, and the number of tools Cursor shows: the matrix's cells, task 27.1.

### Findings

- F5. Cursor registers through Dynamic Client Registration with the redirect URI `cursor://anysphere.cursor-mcp/oauth/callback`, its app's own scheme, which holds no dot, and names no `application_type`, so the install kept the web type and refused it. The maintainer answered the same day that a native app's own scheme needs no dot, as D55 (15) of the OpenSpec change `decisions-from-groups-15-28` now says, and task 27.5 builds it, tests first: Cursor's registration, as Cursor sends it, is a native client's; an authorization with its redirect URI and PKCE reaches the consent screen, which names the scheme `cursor:` and the whole URI; and the approved client gets its code at that URI and exchanges it. The schemes of the web, those whose addresses a browser shows or runs itself and those that reach a program by an address are still refused.

## 2026-10-15: Codex and Cursor against a local install (task 27.1)

- **Date:** 2026-10-15. The times the install recorded run from 20:47:34 UTC, Codex's approval, to 21:03:38 UTC, a Cursor agent's comment.
- **Clients:** Codex in the ChatGPT desktop app, Codex Desktop 26.715.72359, with the model 5.6 Terra, since the model its configuration named, `gpt-5.6-sol`, is not allowed on the maintainer's ChatGPT plan. Tiehall was added to `~/.codex/config.toml` as `[mcp_servers.tiehall]` with `url = "http://localhost:3000/mcp"`, and the Tiehall skill was copied from `packages/claude-plugin/skills/tiehall` to `~/.agents/skills/tiehall`, which Codex showed as a "Tiehall" mention. Cursor, the app, whose version was not recorded, with `~/.cursor/mcp.json` holding only the server's `url`, and later a header (step 6).
- **OS:** macOS, on the maintainer's Mac; its version was not recorded.
- **Install:** the maintainer's local Docker Compose install at the trial URL `http://localhost:3000`, its image built from `main` at `e021cbc9` for both clients; one company with two teams, FE and BE, and one person, the maintainer, a member of both. Since 2026-10-15 22:03 UTC, after this run, the install runs an image with task 27.5, `dc4b5a1e`.
- **CLI:** `tiehall`, signed in to the install, run by the maintainer's Claude Code session for the requesting side of the run on BE-2; its build was not recorded.
- **Task:** 27.1 [agent-access: Sign-in is tested on the four main clients; agent-surfaces: Tested MCP clients].

### Steps

1. In the Codex desktop app, started a task in which Codex's first use of Tiehall's tools reached `/mcp`.
2. Signed Codex in from a terminal with `npx -y @openai/codex mcp login tiehall`, and approved the client in the browser.
3. Quit the Codex desktop app fully, started it again and opened a new task, in which Codex listed its tools and called `whoami` and `list_inbox`.
4. A run on two sides: the maintainer's Claude Code session opened BE-2 through the `tiehall` CLI; Codex claimed it, started it and asked a blocking question through MCP; the CLI answered; Codex read the answer.
5. Started Cursor with the server's `url` alone in `~/.cursor/mcp.json`.
6. Created a personal access token on `/tokens`, and set `headers.Authorization` in `~/.cursor/mcp.json` to `Bearer` and the token.
7. A Cursor agent read BE-2 and posted a comment on it.

### Seen

- At Codex's first tool use, `/mcp` answered 401 with the challenge `Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp", scope="requests:read requests:write"`. The desktop app started no sign-in, so Tiehall's tools stayed unavailable, and the model fell back to the skill's CLI path, which the app's sandbox could not run.
- `codex mcp login tiehall` signed in through Codex's Client ID Metadata Document, `https://chatgpt.com/oauth/codex/client.json`, with the redirect URI `http://127.0.0.1:<port>/callback` and PKCE with `S256`. It asked for the scope `requests:read requests:write contracts:report`, every value of the install's `scopes_supported`, and the grant was approved with those three and `offline_access`: event 24, `agent_client.approved`, at 20:47:34 UTC. Codex keeps the token in the macOS keychain.
- The desktop app loaded Tiehall's tools only after the full quit and a new task. It then listed 12 tools, `attach_contract_changes`, `claim`, `directory`, `get_request`, `link_pr`, `list_inbox`, `open_request`, `post_message`, `propose`, `set_status`, `whats_new` and `whoami`, the server's 12 in `mcp/tools.json`; `whoami` and `list_inbox` answered.
- On BE-2: the maintainer's Claude Code session opened it for team FE through the CLI at 20:52:08 UTC; Codex claimed and started it, and its blocking question, posted through MCP, moved it to `needs_info` at 20:53:53 UTC; the CLI's answer moved it back to `in_progress` at 20:54:18 UTC; and Codex read the answer. The answer was recorded for team BE, not FE: the maintainer, who opened BE-2, was also its claimant through Codex, and a claimant's messages are recorded for the target team (item (7) of the OpenSpec change `findings-from-claude-code-run`).
- Cursor registered through Dynamic Client Registration with the redirect URI `cursor://anysphere.cursor-mcp/oauth/callback` and no `application_type`, and the install refused it, "web clients require https redirect URIs on non-loopback hosts", as the entry of 2026-10-15 for task 27.5 records (F5).
- With the personal access token, created at 21:01:54 UTC (event 32), Cursor connected, and its log showed `toolCount` 12. A Cursor agent read BE-2 and posted a comment on it through MCP at 21:03:38 UTC.
- Cursor also picked up, on its own, the Claude Code plugin's MCP server, as `plugin-tiehall-tiehall`, which failed without `TIEHALL_URL`.

The cells so far, against the server's 12 tools; the protocol version that each client spoke was not recorded:

| Client | Metadata-document fetching | Sign-in path, or the failure | Tools shown |
| --- | --- | --- | --- |
| Claude Code | on | Not run in this run; its Client ID Metadata Document, in the entry of 2026-10-11 (task 17.7) | Not recorded |
| Cursor | on | Dynamic Client Registration refused for its `cursor:` redirect URI (F5, task 27.5); a personal access token instead | 12 of 12, with the token |
| Codex | on | Its Client ID Metadata Document, through `codex mcp login tiehall`; the desktop app does not start the sign-in (F6) | 12 of 12 |
| Copilot | on | Not run | Not run |
| Each of the four | off | Not run | Not run |

### Not exercised

- The protocol versions: no cell recorded the version its client spoke, and none ran on both 2026-07-28 and 2025-11-25.
- Metadata-document fetching off, `TIEHALL_CLIENT_METADATA_FETCH=off`, under which Codex would register through Dynamic Client Registration.
- Cursor's sign-in through Dynamic Client Registration on the install with task 27.5, which re-runs this cell.
- Copilot, and Claude Code in this run.
- What the consent screen showed for Codex was not recorded.
- A second person: the maintainer stood on both sides of BE-2, as the entry for task 27.2 below says.

### Findings

- F6. Codex's desktop app does not start a sign-in when `/mcp` answers 401 with its challenge, which is the one agent-access requires: its tools stay unavailable, and the model falls back to the skill's CLI path, which the app's sandbox cannot run. Signing in from a terminal with `npx -y @openai/codex mcp login tiehall`, then quitting the app fully and opening a new task, works. Only the client can fix it; task 27.3 documents the fallback, which no page does yet.
- F7. Codex asks for every value of `scopes_supported`, past the challenge's `scope`, so its grant holds `contracts:report`, which D55 (13) of the OpenSpec change `decisions-from-groups-15-28` means for a client that asks for it. Taken up as that change's Open Question "Agent clients that ask for every scope".
- F8. Cursor picks up the Claude Code plugin's MCP server on its own, beside the server of its own configuration, and that connection fails without `TIEHALL_URL`. Item (5) of `findings-from-claude-code-run` gives the plugin the install's URL through Claude Code's own configuration of the plugin, and its task 1.1 checks that only in Claude Code's terminal CLI and the Claude desktop app's Code tab. Taken up as that change's Open Question "Cursor loading the plugin's MCP server".

## 2026-10-15: The wake-up and URL-mode elicitation in the same run (task 27.2)

- **Date, Clients, OS, Install and CLI:** as in the entry above.
- **Task:** 27.2 [agent-surfaces: URL-mode elicitation for MCP clients; requester-loop: Claude Code Stop-hook waiter].

### Steps

1. The run on two sides of BE-2 in the entry above, with the maintainer's Claude Code session on the requesting side.

### Seen

- No wake-up could be shown. The install has one person, so every write on BE-2 was the work of the maintainer's own agents, Codex and Cursor through MCP and Claude Code through the CLI, and D55 (43) of the OpenSpec change `decisions-from-groups-15-28`, narrowed by item (4) of `findings-from-claude-code-run`, leaves what a user's agents did out of that user's updates, which the waiter reads.

### Not exercised

- The live `asyncRewake` wake-up: it needs a question from a second person, or one the maintainer posts in the web UI, which item (4) keeps in the agents' readers, as in the run of 2026-10-11 for task 19.19.
- URL-mode elicitation: the run recorded no proposal, so no client was offered a review page to open.

### Findings

None.

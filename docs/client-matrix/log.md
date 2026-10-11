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

- A question from another person: the install has one person, so the maintainer's own question stood in. The waiter as built wakes for every update in its user's updates, whoever made it, so it treats the two alike. D55 (43) of the OpenSpec change `decisions-from-groups-15-28`, not built yet, would leave a user's own events out of their updates; under it, a run like this one needs a second person.
- `/hooks` was not opened, so the list of the plugin's SessionStart, Stop and SessionEnd hooks is not recorded; the SessionStart and Stop hooks are seen running above, and the SessionEnd hook is not seen.
- The waiter's cap, with `TIEHALL_HOOK_WAIT_CAP_SECONDS=180`, and a late wake, 12 minutes or more after a turn ends, which checks that Claude Code keeps the Stop hook's 1900-second timeout.
- Two terminal sessions at once; the desktop app's session took part only as finding F1 describes.

### Findings

- F1. A plugin installed at user scope runs its hooks in every Claude Code session of the user on the machine, sessions of the Claude desktop app's Code tab included. The announced mark is one per user and install, so the first waiter to see an update announces it and every other session's waiter treats it as announced: the news can reach a session that has nothing to do with the request, while the session that worked on the request is never told.
- F2. The scope of `whats_new` holds the actions of the user's own agent, every event on a request the user opened, so a waiter can wake Claude for something Claude itself just did, such as its own `request.opened`: the desktop app's wake of F1.
- F4. A person in both teams has their questions recorded for the requesting side even when they ask as the claimant, as seen by hand earlier on this install. In this run BE-1 had no claimant, and the question was recorded for FE, the requesting team of the person who opened BE-1.

All three, with F3 of the entry above, are taken up in the OpenSpec change `findings-from-claude-code-run`, which nothing builds before the maintainer approves it.

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
- **CLI:** `tiehall` from the same commit, built with `pnpm --filter tiehall build` and installed with `npm install -g` from `packages/cli` (an npm link), signed in with `tiehall login http://localhost:3000` through the device flow: the code was approved on `/device`, whose page said the CLI was signed in. Before `54d4139` the same login failed with "refused the CLI's sign-in"; commits `dd6804e` to `54d4139` (task 15.12, the token endpoint's limit) fixed it.
- **Task:** 17.7 [agent-surfaces: The Claude Code plugin].

### Steps

1. Removed an earlier MCP entry for Tiehall, added by hand: `claude mcp remove tiehall -s user`.
2. In a Claude Code session, at 20:49 UTC, ran `/plugin marketplace add <a checkout of this repository>` and `/reload-plugins`, and at 20:50 `/plugin install tiehall@tiehall`, at user scope. Then restarted Claude Code.
3. In the new session, ran `/mcp`: the plugin's server, `plugin:tiehall:tiehall`, asked to sign in, the install's consent screen opened in the browser, and the maintainer approved the client there.
4. Asked Claude, in Turkish, to open a request to team BE that adds a currency field to an endpoint, and to stop once it was open.

### Seen

- `/plugin marketplace add` answered "Successfully added marketplace: tiehall", and `/plugin install` "Installed tiehall. Plugin is now active."
- `/mcp` answered "Authentication successful. Connected to plugin:tiehall:tiehall." at 20:50:50 UTC. The install recorded security event 20, `agent_client.approved`, for the client id `https://claude.ai/oauth/claude-code-client-metadata`, Claude Code's Client ID Metadata Document.
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

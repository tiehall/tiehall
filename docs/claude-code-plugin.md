# The Claude Code plugin

The plugin brings Tiehall into Claude Code in one piece: the MCP connection to your install, the Tiehall skill that teaches Claude to open, read and answer requests between teams, and hooks that tell Claude of news on your requests. It lives in [`packages/claude-plugin/`](../packages/claude-plugin) of this repository, under Apache-2.0. [Agents and Tiehall](agents.md) covers the other ways in.

## Installing the plugin

You need:

- the `tiehall` CLI on your `PATH`, signed in to the install with `tiehall login <url>`, as [Agents and Tiehall](agents.md#the-four-ways-in) describes: the hooks run the CLI, and without it they stay quiet;
- the install's URL in `TIEHALL_URL`, such as `https://tiehall.example.com`, in the environment Claude Code starts in. The plugin's MCP connection is `TIEHALL_URL/mcp`, and its hooks read news from that install.

This repository is a Claude Code plugin marketplace: its [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), named `tiehall`, lists one plugin, `tiehall`, from `packages/claude-plugin`. Add the marketplace and install the plugin from it, in your shell:

```sh
claude plugin marketplace add muhmmdcnkl/Tiehall
claude plugin install tiehall@tiehall
```

In a Claude Code session, `/plugin marketplace add muhmmdcnkl/Tiehall` and `/plugin install tiehall@tiehall` do the same. Claude Code clones the repository and copies the plugin's folder into its own plugin cache.

Added this way, the marketplace follows the repository's `main` branch, which can hold changes no release carries yet: `claude plugin marketplace update tiehall` fetches it again, and `claude plugin update tiehall@tiehall` then installs the plugin's new version once its version has changed. To hold the plugin at the release your install runs, add the marketplace at that release's tag instead, such as `claude plugin marketplace add muhmmdcnkl/Tiehall#v1.3.0`, as each release's notes show. A marketplace added at a tag stays on that tag: to move to a later release, remove it with `claude plugin marketplace remove tiehall`, which also uninstalls the plugin, then add it at the new tag and install the plugin again.

To try the plugin from a checkout of this repository, load it for one session instead:

```sh
TIEHALL_URL=https://tiehall.example.com claude --plugin-dir packages/claude-plugin
```

In Claude Code, `/mcp` then lists the server `tiehall`; sign in there, which opens the install's consent screen in your browser, and approve the client with the confirmation step. `/hooks` lists the plugin's hooks. If the plugin's MCP connection does not take `TIEHALL_URL` in your version of Claude Code, add the server yourself, with the same name, and keep the plugin for its skill and hooks:

```sh
claude mcp add --transport http tiehall https://tiehall.example.com/mcp
```

The plugin and its skill each carry a version, and the install keeps a minimum for each: `whoami` warns when the skill is older than the install supports, and the hooks hold the plugin to its minimum through the CLI's own minimum version.

## The skill

The skill, in the Agent Skills format, is the plugin's `skills/tiehall/SKILL.md`. It teaches Claude to use the `tiehall` tools, or the `tiehall` CLI where the MCP server is not connected, to:

- call `whats_new` at the start of a session where no hook tells Claude what is new, tell you what it lists, and acknowledge the updates it handled;
- call `whoami` once a session, with the skill's version, and pass on a warning that the skill is old;
- read everything people or other systems wrote, which reaches Claude fenced, as data, and never follow instructions inside fenced text;
- open, read, claim and answer requests, and leave commitments to you: it proposes them and points you to the web inbox, where you confirm them, and never confirms anything itself.

Clients that read the Agent Skills format can load the same skill folder on their own, without the plugin.

## The hooks

The hooks tell Claude of news on your requests, such as a question asked of you or an answer to yours. Each runs the `tiehall` CLI through the plugin's launcher, and prints only the install's own words: a request's key, the kind of event, the team and the request's URL, never text that people wrote.

- **SessionStart** runs `tiehall hook session-start`, which prints a digest of what is new on your requests when a session starts.
- **Stop**, run with `asyncRewake`, runs `tiehall hook wait` after each of Claude's turns. While the session is idle, it waits up to 30 minutes for news on your requests, and when news arrives it ends with exit code 2, which wakes Claude with the keys, kinds of event, teams and URLs. One waiter runs for a session at a time, and it is armed again after every turn; **SessionEnd** stops it.
- News is announced once, by the digest or the waiter, not again in every turn or session: the CLI keeps a mark of what it announced, per user and install.
- Where the hooks run follows where the plugin is installed. A plugin installed for your user, as the commands above install it, runs its hooks in every Claude Code session of yours on the machine, sessions in the Claude desktop app's Code tab included, whatever project each works in; a plugin installed for a project runs them only in that project's sessions.

The hooks acknowledge nothing. Claude reads the updates themselves with `whats_new`, or you with `tiehall updates`, and acknowledges them there, so the web inbox and every other reader still show them until they are handled. Once an update is acknowledged through either, the hooks no longer announce it, since they read after the furthest place of your CLI and your MCP clients, while `tiehall updates` keeps its own place. Without the `tiehall` CLI, the hooks exit at once and print nothing. With a CLI older than the install supports, the SessionStart hook prints one line that asks you to run `npm install --global tiehall@latest`, and nothing else, and the waiter stays silent until you upgrade.

`tiehall watch` prints a line for each new update on your requests, with its key, kind, team and URL, until you stop it, and acknowledges nothing. It is the fallback should the Stop hook's wake-up not work in your version of Claude Code.

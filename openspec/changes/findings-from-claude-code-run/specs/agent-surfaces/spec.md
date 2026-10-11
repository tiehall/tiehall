# Spec Delta: agent-surfaces

## Purpose

Has the Claude Code plugin take the install's URL from Claude Code's own configuration of the plugin, so that its MCP connection and its hooks reach the same install from every Claude Code surface, and keeps the hooks from reading any other install. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: The Claude Code plugin

Tiehall SHALL ship a Claude Code plugin that holds a skill in the Agent Skills format, an MCP connection to the install's MCP server, and the hooks the requester-loop capability defines. The user SHALL give the plugin the install's URL once, through Claude Code's own configuration of the plugin, which Claude Code asks for when the plugin is enabled and keeps in its settings, so that every Claude Code surface that runs the plugin, the terminal CLI and the desktop app included, reads the same URL whatever environment it was started in. The plugin's MCP connection SHALL then point at `/mcp` on that install, and its hooks SHALL read from that install and from no other. When the plugin has been given no install URL, its hooks SHALL NOT read from any saved login of the CLI: the SessionStart hook SHALL print one fixed line in Tiehall's words that says that the plugin has no install URL and how to give it, and the other hooks SHALL do nothing. The skill SHALL also load on its own in Codex, Cursor and Copilot. The plugin and the skill SHALL each carry a version, and Tiehall SHALL keep a minimum supported version for each. The plugin's hooks SHALL enforce the plugin's minimum through the CLI's minimum version: the hooks run the CLI, and the server refuses a CLI older than its minimum with HTTP 400 and the problem type `upgrade-required`, as the public-api capability's error model defines. `whoami` SHALL warn when the skill in use is older than the skill's minimum version.

Source: D8; D28 #63; design.md, Findings: F3 (5), (6); design.md, Technical decisions: T4; design.md, Rules carried from earlier changes

#### Scenario: Installing the plugin for an install

- **WHEN** a developer installs the Tiehall plugin in Claude Code and gives it the install URL `https://tiehall.example.com`
- **THEN** Claude Code is configured with Tiehall's MCP server at `https://tiehall.example.com/mcp`
- **AND** the Tiehall skill is available in the session
- **AND** a new Claude Code session uses the same MCP server without asking for the URL again

#### Scenario: The skill in another client

- **WHEN** the skill's folder is added to Codex, Cursor or Copilot
- **THEN** that client loads it as an Agent Skill

#### Scenario: Versions

- **WHEN** a plugin release is built
- **THEN** the plugin and its skill each state a version

#### Scenario: A hook runs an old CLI

- **WHEN** the SessionStart hook runs a `tiehall` CLI older than the minimum supported CLI version
- **THEN** the server answers HTTP 400 with the problem type `upgrade-required`
- **AND** no updates are fetched

#### Scenario: whoami warns an old skill

- **WHEN** an agent using a skill older than the skill's minimum version calls `whoami`
- **THEN** the result carries a warning that the skill is older than the minimum
- **AND** it still names the user and the install the connection acts for

#### Scenario: The desktop app reads the same URL

- **WHEN** Sam gave the plugin the install URL `https://tiehall.example.com` when enabling it in Claude Code's terminal CLI, and then opens a session in the Claude desktop app's Code tab, whose environment holds no `TIEHALL_URL`
- **THEN** that session's MCP connection points at `https://tiehall.example.com/mcp`
- **AND** that session's hooks read from `https://tiehall.example.com`

#### Scenario: No install URL

- **WHEN** the plugin has been given no install URL, Sam's CLI holds one saved login, for `https://tiehall.example.com`, and Sam starts a Claude Code session
- **THEN** the SessionStart hook prints exactly one line, which says that the plugin has no install URL and how to give it
- **AND** no hook reads anything from `https://tiehall.example.com`
- **AND** when a turn ends, no waiter waits

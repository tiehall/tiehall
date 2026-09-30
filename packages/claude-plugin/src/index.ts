// @tiehall/claude-plugin: the Claude Code plugin and its skill (agent-surfaces:
// The Claude Code plugin). The plugin is the package's folder, as Claude Code
// installs it: its manifest in .claude-plugin/plugin.json, its MCP connection
// in .mcp.json, the launcher its hooks run in hooks/tiehall-hook.sh, which
// runs `tiehall hook <name>` and stays quiet without the CLI, and the Tiehall
// skill in skills/tiehall/SKILL.md, in the Agent Skills format, which also
// loads on its own in other clients. `pnpm check:plugin` checks them. It holds
// no code to import.
export {};

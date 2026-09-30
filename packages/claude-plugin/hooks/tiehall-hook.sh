#!/bin/sh
# The Tiehall plugin's hook launcher (requester-loop: The hooks stay quiet
# without the CLI; requester-loop: Claude Code Stop-hook waiter;
# agent-surfaces: The Claude Code plugin; design.md, Technical decisions:
# T15). Claude Code runs it for each of the plugin's hooks, as
#
#   sh "${CLAUDE_PLUGIN_ROOT}/hooks/tiehall-hook.sh" <session-start | wait | session-end>
#
# with the hook's input on standard input, and it runs `tiehall hook <name>`
# with that input, for the install whose URL the plugin was given, TIEHALL_URL,
# when it is set. When the tiehall command is not installed, it exits with 0
# at once and writes nothing, so a session starts and each turn ends as if the
# plugin had no hooks, and nothing wakes Claude. Only the waiter's error output
# is passed on, since it holds the reminder that wakes Claude; the other hooks'
# is dropped.
command -v tiehall >/dev/null 2>&1 || exit 0
hook=${1:-}
case "$hook" in
  session-start | wait | session-end) ;;
  *) exit 0 ;;
esac
if [ -n "${TIEHALL_URL:-}" ]; then
  set -- hook "$hook" --install "$TIEHALL_URL"
else
  set -- hook "$hook"
fi
if [ "$hook" = wait ]; then
  exec tiehall "$@"
fi
exec tiehall "$@" 2>/dev/null

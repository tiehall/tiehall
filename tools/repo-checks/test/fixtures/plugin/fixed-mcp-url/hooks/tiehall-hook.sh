#!/bin/sh
# A fixture of the plugin check: the launcher the hooks run.
command -v tiehall >/dev/null 2>&1 || exit 0
exec tiehall hook "$@"

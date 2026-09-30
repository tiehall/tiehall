#!/usr/bin/env node
// The tiehall command (agent-surfaces: The CLI package). It checks the Node.js
// version first, in syntax that older releases still read, since the CLI
// itself needs Node.js 22 or later, as its package.json's engines field says;
// only then does it load the CLI. A hook's error output reaches Claude, so the
// hook commands print none of Node.js's warnings, and a hook command that
// cannot start ends with 0 and without a word, as one that cannot do its work
// does (requester-loop: Claude Code Stop-hook waiter).
if (process.argv.slice(2).indexOf("hook") !== -1) process.removeAllListeners("warning");
var HOOK = process.argv[2] === "hook";
var MINIMUM = 22;
var version = process.versions.node;
function cannotStart(message) {
  if (!HOOK) process.stderr.write(message);
  process.exit(HOOK ? 0 : 1);
}
if (Number(version.split(".")[0]) < MINIMUM) {
  cannotStart("tiehall needs Node.js " + MINIMUM + " or later, and this is Node.js " + version + ". Install Node.js " + MINIMUM + " or later, and run tiehall again.\n");
}
import("../dist/tiehall.mjs").then(
  function (cli) {
    return cli.main();
  },
  function (error) {
    cannotStart("tiehall could not start: " + (error && error.message ? error.message : String(error)) + "\n");
  },
);

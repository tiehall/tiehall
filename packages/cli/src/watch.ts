import { hookLine, type Notice } from "@tiehall/packet/notices";
import { announcedThrough } from "./announced.ts";
import { CliError, sleepOf, type CliEnvironment } from "./environment.ts";
import { announceFresh, noticesOf, retryDelay, waitOnce } from "./hooks.ts";
import { chooseLogin, configDirOf } from "./logins.ts";
import { isProblem, problemText } from "./output.ts";
import { sessionFor } from "./session.ts";

// `tiehall watch` (requester-loop: The plugin monitor fallback;
// requester-loop: The hooks read with the CLI's cursor and acknowledge
// nothing; requester-loop: News is announced once; agent-safety: Notices that
// can reach a model carry only server text; design.md, Technical decisions:
// T15). If Claude Code's asyncRewake cannot wake Claude, the plugin runs it as
// a monitor in place of the Stop-hook waiter, and Claude Code turns each line
// it prints into a notification for Claude; a person can run it too. It
// long-polls the wait endpoint, GET /api/v1/events/wait, with the CLI
// client's cursor and then each answer's, never acknowledges, and prints one
// line per new update, Tiehall's own text only: the request key, the event
// type, the team and the request URL. It calls again after an empty answer,
// at once after a restart's 503, and a little later each time after a failed
// call, and runs until it is stopped, such as by Ctrl-C, when it exits with 0.
// It stands in for the waiter, so it shares the hooks' mark of the news
// announced (announced.ts): it prints no update the SessionStart digest or a
// waiter announced, and adds to the mark what it prints. When the install
// refuses it, or the CLI is not signed in, it says why on its error output and
// exits with 1; its standard output holds the update lines alone.

/** The line `tiehall watch` prints for an update. */
const LINE_PREFIX = "Tiehall: ";

/** The line `tiehall watch` prints for an update: Tiehall's prefix, then the update's notice line. */
export function watchLine(notice: Notice): string {
  return `${LINE_PREFIX}${hookLine(notice)}\n`;
}

/** `tiehall watch`: prints a line per new update until it is stopped; 0 then, 1 when the install refuses it. */
export async function watch(environment: CliEnvironment, install: string | undefined): Promise<number> {
  const configDir = configDirOf(environment.env);
  const login = chooseLogin(configDir, { install });
  const session = sessionFor(environment, login, { longRunning: true });
  const stop = environment.interrupted?.() ?? new AbortController().signal;
  const sleep = sleepOf(environment);
  let cursor: number | undefined;
  let failures = 0;
  while (!stop.aborted) {
    const waited = await waitOnce(environment, session, cursor, stop);
    switch (waited.kind) {
      case "answered": {
        failures = 0;
        const notices = noticesOf(login.url, waited.entries);
        let fresh: typeof notices | undefined;
        try {
          fresh = await announceFresh(configDir, login.url, notices, waited.cursor);
        } catch {
          // A mark the CLI cannot keep does not keep an update from being reported.
          fresh = notices;
        }
        for (const { notice } of fresh ?? []) environment.stdout(watchLine(notice));
        cursor = Math.max(waited.cursor, announcedThrough(configDir, login.url));
        break;
      }
      case "again":
      case "failed":
        await sleep(retryDelay(waited, failures), stop);
        failures += 1;
        break;
      case "refused":
        if (isProblem(waited.problem)) environment.stderr(problemText(waited.problem));
        else if (waited.error instanceof CliError) environment.stderr(`${waited.error.message}\n`);
        else environment.stderr(`The install refused tiehall watch, and gave no problem the CLI can show.\n`);
        return 1;
      case "stopped":
        return 0;
    }
  }
  return 0;
}

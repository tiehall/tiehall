import type { WebSessionCaller } from "../../src/caller.ts";
import type { Execute } from "../../src/execute.ts";
import type { ShellMember } from "../../src/shell.ts";

/**
 * Reads what the app shell shows of a signed-in member, web.shell, through
 * this execute(), as the web role gives it to the routes that render outside
 * createPageRoute, such as the home page (web-ui: The page shell and its
 * navigation).
 */
export function shellReader(execute: Execute): (caller: WebSessionCaller) => Promise<ShellMember> {
  return async (caller) => (await execute("web.shell", caller, {}, { readOnly: true })) as ShellMember;
}

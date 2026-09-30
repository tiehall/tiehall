"use server";

import { refresh } from "next/cache";
import { runRequestPageAction, type RequestPageActionState } from "@tiehall/commands/web";
import { writeCommand } from "./write-command.ts";

// The server action behind the forms of a request's page (public-api: One
// definition per operation, the same on every surface; requests: Claiming and
// starting work need no proposal; requests: Thread messages and blocking
// questions; design.md, Technical decisions: T3). Each form names its action;
// @tiehall/commands turns the form into the operation and input it runs
// (request-page-actions.ts), which writeCommand() runs through execute(), as
// the signed-in member's web session, once the form passes the web UI's write
// checks: its CSRF token, an Origin equal to TIEHALL_URL and Sec-Fetch-Site:
// same-origin. Once the action has run, the page is read again, so it shows
// the request as it is now; a refusal leaves it as it was and shows the
// refusal the same call gets over /api/v1.

export async function requestPageAction(_previous: RequestPageActionState, form: FormData): Promise<RequestPageActionState> {
  const fields = new URLSearchParams();
  for (const [name, value] of form) if (typeof value === "string") fields.append(name, value);
  const state = await runRequestPageAction(fields, writeCommand);
  if (state.ok) refresh();
  return state;
}

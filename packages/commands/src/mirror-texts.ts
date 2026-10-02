import { REQUEST_STATES, type RequestState } from "@tiehall/core";
import { installLink, requestKey, teamKey, type ServerText } from "./email.ts";

// What a mirror issue says (tracker-mirrors: A mirror is a projection of the
// request; agent-safety: Tracker mirrors carry a summary and a link, not the
// packet; design.md, Design rules: Agent safety and Tracker mirrors). A
// tracker is read by people and by their agents, and by anyone the tracker
// lets in, so a mirror issue carries what Tiehall writes and nothing anyone
// wrote in Tiehall: no packet, no message of the thread. Its summary and the
// label that names the request's state are made here, from values Tiehall
// checks: the request's key, the keys of its teams, its state and its URL on
// the install, each typed as server text that only these functions and the
// email templates make. The one text a person wrote that a mirror carries is
// the request's title, which the issue's title holds, as the tracker-mirrors
// capability asks; it is kept apart from the summary, which never holds it.
// The comments Tiehall adds for a state change or a question are made the
// same way, from the key, the state and the link: a question's comment says
// that a question waits, never what it asks (tracker-mirrors: One comment per
// state change and per question notice).

/** The label that names a request's state on its mirror issue, such as tiehall:in_progress. */
export function stateLabel(state: RequestState): ServerText {
  if (!(REQUEST_STATES as readonly string[]).includes(state)) throw new TypeError("A state label names one of the request states.");
  return `tiehall:${state}` as ServerText;
}

/** What a mirror issue's body says about its request: which request, which teams, where it lives, and what a change in the tracker does. */
export interface MirrorSummary {
  /** The paragraphs of the body, in Tiehall's words. */
  readonly paragraphs: readonly ServerText[];
  /** The request's URL on the install, which the body links. */
  readonly link: ServerText;
}

/** The summary of a request for its mirror issue, from its key, its teams' keys and the install's URL alone. */
export function mirrorSummary(input: { installUrl: string; key: string; targetTeam: string; requestingTeam: string }): MirrorSummary {
  const key = requestKey(input.key);
  const target = teamKey(input.targetTeam);
  const requesting = teamKey(input.requestingTeam);
  const link = installLink(input.installUrl, `/${key}`);
  const opened =
    target === requesting ? `This issue mirrors the Tiehall request ${key}, which team ${target} opened for itself.` : `This issue mirrors the Tiehall request ${key}, which team ${requesting} opened for team ${target}.`;
  return {
    link,
    paragraphs: [
      opened as ServerText,
      `The request lives in Tiehall, with its packet and its thread: ${link}` as ServerText,
      "Tiehall keeps this issue up to date: its label shows the request's state, and a comment marks each change of that state and each question that waits for an answer. Closing or reopening this issue, or changing its assignees, is recorded on the request in Tiehall, and does not change the request by itself." as ServerText,
    ],
  };
}

/** A mirror issue's title: the request's key, then its title as the requester wrote it, which is the one text of theirs a mirror carries. */
export function mirrorTitle(key: string, title: string): string {
  return `${requestKey(key)}: ${title}`;
}

/** A request state, checked, as a comment names it. */
function stateName(state: RequestState): ServerText {
  if (!(REQUEST_STATES as readonly string[]).includes(state)) throw new TypeError("A mirror comment names one of the request states.");
  return state as ServerText;
}

/** The comment that marks a state change of a mirrored request: its key, the state it is in now, and its link. */
export function stateComment(input: { key: string; state: RequestState; link: ServerText }): ServerText {
  const key = requestKey(input.key);
  return `${key} is now ${stateName(input.state)} in Tiehall: ${input.link}` as ServerText;
}

/**
 * The comment that marks a question on a mirrored request: that a question
 * waits, and the request's link, never the question's text; with the state
 * the request is in now when the question changed it, such as a blocking one.
 */
export function questionComment(input: { key: string; link: ServerText; state?: RequestState }): ServerText {
  const key = requestKey(input.key);
  return (
    input.state === undefined
      ? `A question on ${key} waits for an answer in Tiehall: ${input.link}`
      : `A question on ${key} waits for an answer in Tiehall, and ${key} is now ${stateName(input.state)}: ${input.link}`
  ) as ServerText;
}

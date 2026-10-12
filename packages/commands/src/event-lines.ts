import type { RequestState } from "@tiehall/core";
import { stripInvisible } from "@tiehall/packet/render";
import { updateDescription } from "@tiehall/packet/tool-text";

// One description of a domain event about a request, and of who caused it
// (web-ui: The request page shows who works on it and what happened; web-ui:
// What the live hall shows of the people and agents at work; design.md,
// Design: How it is built; design.md, Design: The live hall, Who is at work;
// D57 (13), (15)). The request page's timeline and the live hall's feed say an
// event in the words the web inbox uses, updateDescription's without ids, and
// name its actor the same way: a user's login, marked when an admin flagged
// them as a bot, as an agent with its client or in the web UI; Tiehall for a
// system action; GitHub or Jira for an integration, by the surface it came
// through; and the operator for a command on the host. A client's name is the
// client's own claim, shown as text: a metadata document's name with the host
// Tiehall verified, a registered client's marked unverified, or "unnamed
// client" when it gave none; the tiehall CLI with its version; and a personal
// access token as such. The words hold no one's text but logins and client
// names. A client's name, a title and a team's name are shown without the
// characters that hide or reverse text, the ones the agent view strips, and a
// page sets a client's name apart from the mark Tiehall gives it, so that no
// name can turn the mark "unverified" or a verified host round or hide it.

/** A user as an event names them. */
export interface EventUser {
  id: string;
  login: string;
  kind: "human";
  bot: boolean;
}

/** A client that acted for a user. */
export interface ActorClient {
  kind: "metadata_document" | "registered" | "cli" | "personal_access_token";
  host: string | null;
  version: string | null;
  unverified: boolean;
  untrusted: { name: string | null };
}

/** Who caused an event. */
export interface EventActor {
  kind: "agent" | "web" | "tiehall" | "github" | "jira" | "operator";
  user: EventUser | null;
  client: ActorClient | null;
}

/** How long a client's name is shown, at most. */
export const CLIENT_NAME_LENGTH = 40;

/** A client's name cut to 40 characters, the last one an ellipsis when it was cut. */
export function cutName(name: string): string {
  const characters = [...name];
  return characters.length <= CLIENT_NAME_LENGTH ? name : `${characters.slice(0, CLIENT_NAME_LENGTH - 1).join("")}…`;
}

/** A user as the web UI names them: their login, marked when an admin flagged them as a bot. */
export function userWords(user: Pick<EventUser, "login" | "bot">): string {
  return user.bot ? `${user.login} (bot)` : user.login;
}

/** Who caused an event, in Tiehall's words, such as "mert's agent", "selin", "Tiehall" or "GitHub". */
export function actorWords(actor: EventActor): string {
  switch (actor.kind) {
    case "agent":
      return `${actor.user === null ? "someone" : userWords(actor.user)}'s agent`;
    case "web":
      return actor.user === null ? "someone in the web UI" : userWords(actor.user);
    case "tiehall":
      return "Tiehall";
    case "github":
      return "GitHub";
    case "jira":
      return "Jira";
    case "operator":
      return "the operator";
  }
}

/**
 * Text people or agents wrote, such as a client's name, a title or a team's
 * name, as the web UI shows it: without the characters that hide or reverse
 * text (U+200B to U+200F, U+202A to U+202E, U+2060 to U+2064, U+2066 to
 * U+2069, U+FEFF and the tag characters), so that a name holding U+202E
 * cannot reverse the words Tiehall puts after it, nor the control characters
 * a terminal acts on, which a page does not show either; the agent view
 * strips the same characters (decisions-from-groups-15-28: design.md,
 * Decisions this change rests on: D55 (36)).
 */
export function shownText(text: string): string {
  return stripInvisible(text);
}

/** A client as a page shows it: its name, the client's own claim or Tiehall's words for it, and the mark Tiehall gives it, apart, which a page keeps out of the name's isolation. */
export interface ClientParts {
  name: string;
  mark: string | null;
}

/** A client's name and its mark: the verified host of a metadata document, "(unverified)" for a registered client, and none for the CLI or a personal access token. */
export function clientParts(client: ActorClient): ClientParts {
  const name = client.untrusted.name ?? "unnamed client";
  switch (client.kind) {
    case "metadata_document":
      return { name, mark: client.host === null ? null : `(${client.host})` };
    case "registered":
      return { name, mark: "(unverified)" };
    case "cli":
      return { name: client.version === null ? "tiehall CLI" : `tiehall CLI ${client.version}`, mark: null };
    case "personal_access_token":
      return { name: "personal access token", mark: null };
  }
}

/** A client, in Tiehall's words, such as "Example Agent (client.example.com)", "Claude Code (unverified)" or "tiehall CLI 0.4.0". */
export function clientWords(client: ActorClient): string {
  const { name, mark } = clientParts(client);
  return mark === null ? name : `${name} ${mark}`;
}

/** A state's words, as the request's state chip says it. */
export const STATE_WORDS: Readonly<Record<RequestState, string>> = {
  open: "Open",
  claimed: "Claimed",
  in_progress: "In progress",
  needs_info: "Needs info",
  done: "Done",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

/** What an event says happened, in the web inbox's words, with each state in words and the first letter upper case. */
export function eventLine(type: string, data: Readonly<Record<string, unknown>>): string {
  let said: string | undefined;
  try {
    said = updateDescription({ type, data: data as Record<string, string | number | boolean> }, { ids: false });
  } catch {
    said = undefined;
  }
  const words = (said ?? type).replace(/\b(in_progress|needs_info)\b/g, (state) => STATE_WORDS[state as RequestState].toLowerCase());
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The state an event leaves a request in, given the state before it: only the events that move a request change it. */
export function stateAfter(type: string, data: Readonly<Record<string, unknown>>, before: RequestState): RequestState {
  switch (type) {
    case "request.opened":
    case "request.released":
      return "open";
    case "request.claimed":
      return "claimed";
    case "request.started":
      return "in_progress";
    case "request.state_changed":
      return typeof data["state"] === "string" && Object.hasOwn(STATE_WORDS, data["state"]) ? (data["state"] as RequestState) : before;
    default:
      return before;
  }
}

/** The event types that move a request from one state to another. */
export const STATE_EVENT_TYPES = ["request.opened", "request.released", "request.claimed", "request.started", "request.state_changed"] as const;

/** How long ago a moment was, from now, in a few words: "now", "40 s", "3 min", "2 h" or "5 d". */
export function relativeTime(at: string, now: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(at)) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** How long until a moment, from now, in words: "in 6 days", "in 5 hours", "in 12 minutes", or "soon". */
export function untilWords(at: string, now: string): string {
  const minutes = Math.floor((Date.parse(at) - Date.parse(now)) / 60_000);
  if (minutes < 1) return "soon";
  if (minutes < 60) return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
  return `in ${Math.floor(hours / 24)} days`;
}

/** How long is left until a moment, from now, in a few words: "12 min left", "5 h left", "6 days left", or "under a minute left". */
export function leftWords(at: string, now: string): string {
  const minutes = Math.floor((Date.parse(at) - Date.parse(now)) / 60_000);
  if (minutes < 1) return "under a minute left";
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h left`;
  return `${Math.floor(hours / 24)} days left`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A moment as people read it, its date and its hour and minute in UTC, such as "Oct 18, 2026, 04:14 UTC"; a text that is no time stays as it is. */
export function utcWords(at: string): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return at;
  const two = (value: number) => String(value).padStart(2, "0");
  return `${MONTHS[time.getUTCMonth()] ?? ""} ${time.getUTCDate()}, ${time.getUTCFullYear()}, ${two(time.getUTCHours())}:${two(time.getUTCMinutes())} UTC`;
}

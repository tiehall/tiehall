import type { RequestState } from "@tiehall/core";
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
// names.

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

/** A client, in Tiehall's words, such as "Example Agent (client.example.com)", "Claude Code (unverified)" or "tiehall CLI 0.4.0". */
export function clientWords(client: ActorClient): string {
  const name = client.untrusted.name ?? "unnamed client";
  switch (client.kind) {
    case "metadata_document":
      return client.host === null ? name : `${name} (${client.host})`;
    case "registered":
      return `${name} (unverified)`;
    case "cli":
      return client.version === null ? "tiehall CLI" : `tiehall CLI ${client.version}`;
    case "personal_access_token":
      return "personal access token";
  }
}

/** How an actor acted, in a few words: "agent" with its client, or "web". */
export function actedThrough(actor: EventActor): string | undefined {
  if (actor.kind === "agent") return actor.client === null ? "agent" : `agent · ${clientWords(actor.client)}`;
  if (actor.kind === "web") return "web";
  return undefined;
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

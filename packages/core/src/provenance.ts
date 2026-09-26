import { UUID } from "./events.ts";

// Who caused an event (requests: Provenance is stamped by the server;
// activity-log: The activity log holds domain events and security events;
// design.md, Design rules: Requests and events and Self-hosting decisions: S3,
// S7). The server stamps it from the caller's token, session or job, never
// from a payload. An event is caused by a user acting through an agent or a
// web session, by the system or an integration, or by an operator command run
// on the host, which names the command and no user.

/**
 * The actor kinds of provenance. `human` stays reserved for a later
 * confirmation that proves a person acted; v1 never records it.
 */
export const ACTOR_KINDS = ["human", "agent", "system", "integration", "web_session"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const SURFACES = ["web", "mcp", "cli", "api", "github", "jira"] as const;
export type Surface = (typeof SURFACES)[number];

/** The operator commands the image's admin role runs on the host (self-host-install: setup code and recovery). */
export const OPERATOR_COMMANDS = ["admin grant", "setup reopen"] as const;
export type OperatorCommand = (typeof OPERATOR_COMMANDS)[number];

/** Who caused an event: its actor kind is one of the recorded actor kinds, or `operator` for an operator command. */
export const EVENT_ACTOR_KINDS = ["agent", "web_session", "system", "integration", "operator"] as const;
export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number];

export type Provenance =
  | {
      /** An OAuth token or a personal access token (agent), or a web session. */
      actorKind: "agent" | "web_session";
      /** The accountable human, by their Tiehall user id. */
      userId: string;
      surface: Surface;
      /** The client: its Client ID Metadata Document URL, the OAuth client, or the CLI version. */
      client?: string;
      /** The team the user acted for. */
      teamId?: string;
    }
  | {
      /** A system job or a verified integration event; it may act for a user, such as a PR's author. */
      actorKind: "system" | "integration";
      userId?: string;
      surface?: Surface;
      client?: string;
      teamId?: string;
    }
  | { actorKind: "operator"; command: OperatorCommand };

/** Every way a provenance breaks its shape, as a sentence; none when it keeps it. */
export function checkProvenance(provenance: Provenance): string[] {
  const given = provenance as Readonly<Record<string, unknown>>;
  const actorKind = String(given["actorKind"]);
  if (actorKind === "human") {
    return ["The actor kind human is reserved for a later confirmation that proves a person acted; v1 never records it."];
  }
  if (!(EVENT_ACTOR_KINDS as readonly string[]).includes(actorKind)) {
    return [`The actor kind ${actorKind} is not one of ${EVENT_ACTOR_KINDS.join(", ")}.`];
  }
  if (actorKind === "operator") {
    const command = String(given["command"]);
    const problems = (OPERATOR_COMMANDS as readonly string[]).includes(command)
      ? []
      : [`The operator command ${command} is not one of ${OPERATOR_COMMANDS.join(", ")}.`];
    if (Object.keys(given).some((key) => key !== "actorKind" && key !== "command")) {
      problems.push("An operator command names the command and no user, client, surface or team.");
    }
    return problems;
  }
  const problems: string[] = [];
  const { userId, surface, teamId, client } = given;
  if (actorKind === "agent" || actorKind === "web_session") {
    if (userId === undefined || surface === undefined) {
      problems.push(`An event caused through ${actorKind === "agent" ? "an agent" : "a web session"} names its user and surface.`);
    }
  }
  if (userId !== undefined && (typeof userId !== "string" || !UUID.test(userId))) {
    problems.push("The user who caused an event is named by their Tiehall id, a UUID.");
  }
  if (surface !== undefined && !(SURFACES as readonly unknown[]).includes(surface)) {
    problems.push(`The surface ${String(surface)} is not one of ${SURFACES.join(", ")}.`);
  }
  if (teamId !== undefined && (typeof teamId !== "string" || !UUID.test(teamId))) {
    problems.push("The team a user acted for is named by its Tiehall id, a UUID.");
  }
  if (client !== undefined && (typeof client !== "string" || client === "")) {
    problems.push("The client is named by a non-empty string.");
  }
  return problems;
}

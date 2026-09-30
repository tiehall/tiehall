import { z } from "zod";
import { defineCommand } from "./command.ts";

// A member's grants to agent clients (agent-access: Approving an agent client
// uses the confirmation step; agent-access: Users list and revoke their own
// agent grants and tokens; agent-safety: Actions that need the confirmation
// step; agent-access: The device approval page cannot be prefilled). Approving
// a client is a change to who may act for the member, so it needs the
// confirmation step and runs only in the web UI, from the consent screen or,
// for the tiehall CLI, from the device approval page; revoking a grant only
// takes access away, so it needs none, but runs only in the web UI too, from
// the member's Connected agents and tokens page, which lists their grants. No
// agent surface offers any of them.

export const approveAgentClient = defineCommand({
  id: "agent_clients.approve",
  summary: "Approve an agent client's authorization request for the signed-in member, so the client acts for them within the scopes it asked for.",
  input: z.object({
    authorization: z
      .string()
      .min(1)
      .max(8192)
      .meta({ description: "The agent client's authorization request, as the query string the authorization server sent the consent screen." }),
  }),
  output: z.object({
    grantId: z.uuid(),
    /** Where the browser goes on: the authorization endpoint, with the request, which now gives the client its code. */
    continue: z.string(),
  }),
  scopes: [],
  commitment: false,
  confirm: true,
  surfaces: [],
  stability: "beta",
});

export const approveDevice = defineCommand({
  id: "agent_clients.approve_device",
  summary: "Approve the sign-in of the tiehall CLI that printed this code, for the signed-in member, so the CLI acts for them within the scopes it asked for.",
  input: z.object({
    userCode: z
      .string()
      .min(1)
      .max(64)
      .meta({ description: "The code tiehall login printed, as the member typed it on the device approval page." }),
  }),
  output: z.object({ grantId: z.uuid() }),
  scopes: [],
  commitment: false,
  confirm: true,
  surfaces: [],
  stability: "beta",
});

export const revokeAgentGrant = defineCommand({
  id: "agent_grants.revoke",
  summary: "Revoke one of the signed-in member's agent grants, which stops the refresh tokens of its client at once.",
  input: z.object({ grantId: z.uuid() }),
  output: z.object({ grantId: z.uuid() }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const listAgentGrants = defineCommand({
  id: "agent_grants.list",
  summary: "List the grants the signed-in member gave agent clients, the tiehall CLI's included, with who each client says it is and what it may do.",
  input: z.object({}),
  output: z.object({
    grants: z.array(
      z.object({
        id: z.uuid(),
        client: z.object({
          /** The name the client gives itself, its own claim; null when it gave none. For the tiehall CLI, Tiehall's own name for it. */
          name: z.string().nullable(),
          /** Whether the client is the tiehall CLI, which signs in through the device flow. */
          cli: z.boolean(),
          /** For a client identified by its Client ID Metadata Document, the verified host of the document's URL; null otherwise. */
          verifiedHost: z.string().nullable(),
          /** Whether the client registered itself, so nothing verifies who it is. */
          unverified: z.boolean(),
        }),
        /** What the client may do for the member. */
        scopes: z.array(z.string()),
        /** When the member last approved the client. */
        approvedAt: z.iso.datetime(),
      }),
    ),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const AGENT_CLIENT_COMMANDS = [approveAgentClient, approveDevice, revokeAgentGrant, listAgentGrants];

import { z } from "zod";
import { defineCommand } from "./command.ts";

// A member's grants to agent clients (agent-access: Approving an agent client
// uses the confirmation step; agent-access: Users list and revoke their own
// agent grants and tokens; agent-safety: Actions that need the confirmation
// step). Approving a client is a change to who may act for the member, so it
// needs the confirmation step and runs only in the web UI, from the consent
// screen; revoking a grant only takes access away, so it needs none, but runs
// only in the web UI too. No agent surface offers either.

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

export const AGENT_CLIENT_COMMANDS = [approveAgentClient, revokeAgentGrant];

import { z } from "zod";
import { defineCommand } from "./command.ts";
import { proposal } from "./proposals.ts";

// The standing list of a person's web inbox (requester-loop: The web inbox;
// requests: Where a proposal waits). It holds what stays listed whether or not
// the person has acknowledged anything in their update feed: every proposal
// that waits for a confirmation they may give now, decided at the moment of
// the read, so it follows claims, releases, removals and team changes at once,
// the receipts of their confirmations, each with its sentence in Tiehall's
// words (requests: Receipts), and the reminders that their personal access
// tokens expire soon, while each token may still be used (agent-access: PAT
// owners are reminded before expiry). Only the web UI reads it.

export const standingList = defineCommand({
  id: "inbox.standing_list",
  summary:
    "The standing list of your web inbox: the proposals that wait for a confirmation you may give now, the receipts of your confirmations, and the reminders that your personal access tokens expire soon, oldest first.",
  input: z.object({}),
  output: z.object({
    waiting: z.array(proposal),
    receipts: z.array(
      z.object({
        id: z.uuid(),
        kind: z.enum(["waits_for_other_side", "took_effect", "undone"]),
        /** What the receipt says, in Tiehall's words. */
        text: z.string(),
        /** For the receipt that says a due date, a scope change, a reassignment or a decline took effect: until when its undo page, /confirm/{proposal}/undo, undoes it. */
        undoUntil: z.iso.datetime().nullable(),
        createdAt: z.iso.datetime(),
        proposal,
      }),
    ),
    reminders: z.array(
      z.object({
        id: z.uuid(),
        /** The personal access token the reminder is about. */
        tokenId: z.uuid(),
        /** How many days before the token's expiry day the reminder came: 14 or 3. */
        daysBefore: z.int(),
        /** What the reminder says, in Tiehall's words. */
        text: z.string(),
        expiresAt: z.iso.datetime(),
        createdAt: z.iso.datetime(),
      }),
    ),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const INBOX_COMMANDS = [standingList];

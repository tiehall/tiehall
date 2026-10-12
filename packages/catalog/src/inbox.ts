import { z } from "zod";
import { defineCommand } from "./command.ts";
import { proposal } from "./proposals.ts";
import { teamRef } from "./requests.ts";

// The standing list of a person's web inbox (requester-loop: The web inbox;
// requests: Where a proposal waits). It holds what stays listed whether or not
// the person has acknowledged anything in their update feed: every proposal
// that waits for a confirmation they may give now, decided at the moment of
// the read, so it follows claims, releases, removals and team changes at once,
// the receipts of their confirmations, each with its sentence in Tiehall's
// words (requests: Receipts), and the reminders that their personal access
// tokens expire soon, while each token may still be used (agent-access: PAT
// owners are reminded before expiry), and the requests to re-confirm the
// declarations of their teams that they consume an API, while each waits
// (contract-changes: Declarations are re-confirmed every 90 days), and their
// teams' daily WARN digests, newest first, each listed once its UTC day has
// ended, until the person dismisses it or for 7 days, with each API's count of
// WARN-level changes, its name and its provider pull request, never the
// changes' text (contract-changes: Potentially breaking changes go to a daily
// digest; decisions-from-groups-15-28, D55 (69), (70)). Only the web UI reads
// it, and dismisses a WARN digest from the person's own list.

export const standingList = defineCommand({
  id: "inbox.standing_list",
  summary:
    "The standing list of your web inbox: the proposals that wait for a confirmation you may give now, the receipts of your confirmations, the reminders that your personal access tokens expire soon, your teams' daily WARN digests, and the requests to re-confirm the APIs your teams declared they consume.",
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
    warnDigests: z.array(
      z.object({
        /** The reader's team the digest is for, and the UTC day it covers, which has ended. */
        team: teamRef,
        day: z.iso.date(),
        /** What the digest says, in Tiehall's words. */
        text: z.string(),
        /** Each change set whose WARN-level changes opened no request that day: the API, the provider pull request and how many changes. */
        changeSets: z.array(
          z.object({
            api: z.string(),
            pullRequest: z.object({ repository: z.string(), number: z.int(), url: z.string() }),
            /** How many WARN-level changes the day's latest report has. */
            warnChanges: z.int(),
          }),
        ),
      }),
    ),
    reconfirmations: z.array(
      z.object({
        /** The API the declaration is about, and the reader's team that declared it consumes it. */
        api: z.object({ id: z.uuid(), name: z.string() }),
        team: teamRef,
        lastConfirmedAt: z.iso.datetime(),
        /** When the daily job asked the team to re-confirm it. */
        requestedAt: z.iso.datetime(),
        stale: z.boolean(),
        /** What the request says, in Tiehall's words. */
        text: z.string(),
      }),
    ),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

// Dismissing a WARN digest from the standing list (contract-changes:
// Potentially breaking changes go to a daily digest; decisions-from-groups-
// 15-28, D55 (69)). A member of the team dismisses the team's digest of a day
// from their own list; the other members keep it. It needs no confirmation
// step, as it changes nothing but the person's own list, and only the web UI
// offers it.

export const dismissWarnDigest = defineCommand({
  id: "inbox.dismiss_warn_digest",
  summary: "Dismiss one of your team's daily WARN digests from the standing list of your web inbox; the team's other members keep it.",
  input: z.object({
    team: z.uuid().meta({ description: "The team the digest is for, one you are a member of." }),
    day: z.iso.date().meta({ description: "The UTC day the digest covers." }),
  }),
  output: z.object({ team: teamRef, day: z.iso.date() }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const INBOX_COMMANDS = [standingList, dismissWarnDigest];

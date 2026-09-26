import { z } from "zod";
import { defineCommand } from "./command.ts";
import { proposal } from "./proposals.ts";

// The standing list of a person's web inbox (requester-loop: The web inbox;
// requests: Where a proposal waits). It holds what stays listed whether or not
// the person has acknowledged anything in their update feed: every proposal
// that waits for a confirmation they may give now, decided at the moment of
// the read, so it follows claims, releases, removals and team changes at once.
// Only the web UI reads it.

export const standingList = defineCommand({
  id: "inbox.standing_list",
  summary: "The standing list of your web inbox: the proposals that wait for a confirmation you may give now, oldest first.",
  input: z.object({}),
  output: z.object({ waiting: z.array(proposal) }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const INBOX_COMMANDS = [standingList];

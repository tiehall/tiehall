import { EVENT_READ_HANDLERS } from "./event-reads.ts";
import type { Handlers } from "./execute.ts";
import { MEMBER_HANDLERS } from "./member-changes.ts";
import { MESSAGE_HANDLERS } from "./messages.ts";
import { PACKET_HANDLERS } from "./packets.ts";
import { PROPOSAL_CONFIRMATION_HANDLERS } from "./proposal-confirmations.ts";
import { PROPOSAL_HANDLERS } from "./proposals.ts";
import { REQUEST_HANDLERS } from "./requests.ts";
import { TEAM_HANDLERS } from "./teams.ts";
import { USER_HANDLERS } from "./users.ts";
import { WRITE_LIMIT_HANDLERS } from "./write-limits.ts";

// One handler per operation of the catalog, by the operation's id (design.md,
// Technical decisions: T3). Each task that adds an operation to the catalog
// adds its handler here; execute() refuses to start while one is missing.
export const HANDLERS: Handlers = {
  ...MEMBER_HANDLERS,
  ...TEAM_HANDLERS,
  ...USER_HANDLERS,
  ...REQUEST_HANDLERS,
  ...MESSAGE_HANDLERS,
  ...PACKET_HANDLERS,
  ...PROPOSAL_HANDLERS,
  ...PROPOSAL_CONFIRMATION_HANDLERS,
  ...EVENT_READ_HANDLERS,
  ...WRITE_LIMIT_HANDLERS,
};

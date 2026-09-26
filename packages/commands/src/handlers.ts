import { EVENT_READ_HANDLERS } from "./event-reads.ts";
import type { Handlers } from "./execute.ts";
import { MEMBER_HANDLERS } from "./member-changes.ts";
import { MESSAGE_HANDLERS } from "./messages.ts";
import { REQUEST_HANDLERS } from "./requests.ts";
import { TEAM_HANDLERS } from "./teams.ts";
import { USER_HANDLERS } from "./users.ts";

// One handler per operation of the catalog, by the operation's id (design.md,
// Technical decisions: T3). Each task that adds an operation to the catalog
// adds its handler here; execute() refuses to start while one is missing.
export const HANDLERS: Handlers = {
  ...MEMBER_HANDLERS,
  ...TEAM_HANDLERS,
  ...USER_HANDLERS,
  ...REQUEST_HANDLERS,
  ...MESSAGE_HANDLERS,
  ...EVENT_READ_HANDLERS,
};

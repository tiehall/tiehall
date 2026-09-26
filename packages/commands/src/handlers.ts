import type { Handlers } from "./execute.ts";
import { MEMBER_HANDLERS } from "./member-changes.ts";
import { TEAM_HANDLERS } from "./teams.ts";

// One handler per operation of the catalog, by the operation's id (design.md,
// Technical decisions: T3). Each task that adds an operation to the catalog
// adds its handler here; execute() refuses to start while one is missing.
export const HANDLERS: Handlers = { ...MEMBER_HANDLERS, ...TEAM_HANDLERS };

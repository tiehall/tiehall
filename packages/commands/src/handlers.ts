import type { Handlers } from "./execute.ts";

// One handler per operation of the catalog, by the operation's id (design.md,
// Technical decisions: T3). Each task that adds an operation to the catalog
// adds its handler here; execute() refuses to start while one is missing.
export const HANDLERS: Handlers = {};

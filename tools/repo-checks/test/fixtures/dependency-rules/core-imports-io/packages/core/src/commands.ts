// Fixture: packages/core reaching into packages/commands, which does I/O.
import { execute } from "@tiehall/commands";

export const run: unknown = execute;

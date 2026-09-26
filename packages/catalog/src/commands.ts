import { defineCatalog } from "./catalog.ts";
import { MEMBER_COMMANDS } from "./members.ts";
import { REQUEST_COMMANDS } from "./requests.ts";
import { TEAM_COMMANDS } from "./teams.ts";

// Tiehall's operations, one definition each (public-api: One definition per
// operation, the same on every surface). Each task that builds an operation
// adds its definition here, and registering the catalog checks it.
export const CATALOG = defineCatalog([...MEMBER_COMMANDS, ...TEAM_COMMANDS, ...REQUEST_COMMANDS]);

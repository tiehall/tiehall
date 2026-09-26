import { ACTIVITY_LOG_COMMANDS } from "./activity-log.ts";
import { defineCatalog } from "./catalog.ts";
import { EVENT_COMMANDS } from "./events.ts";
import { INBOX_COMMANDS } from "./inbox.ts";
import { MEMBER_COMMANDS } from "./members.ts";
import { MESSAGE_COMMANDS } from "./messages.ts";
import { PACKET_COMMANDS } from "./packets.ts";
import { PROPOSAL_COMMANDS } from "./proposals.ts";
import { REQUEST_COMMANDS } from "./requests.ts";
import { SETTINGS_COMMANDS } from "./settings.ts";
import { TEAM_COMMANDS } from "./teams.ts";

// Tiehall's operations, one definition each (public-api: One definition per
// operation, the same on every surface). Each task that builds an operation
// adds its definition here, and registering the catalog checks it.
export const CATALOG = defineCatalog([...MEMBER_COMMANDS, ...TEAM_COMMANDS, ...REQUEST_COMMANDS, ...MESSAGE_COMMANDS, ...PACKET_COMMANDS, ...PROPOSAL_COMMANDS, ...INBOX_COMMANDS, ...EVENT_COMMANDS, ...SETTINGS_COMMANDS, ...ACTIVITY_LOG_COMMANDS]);

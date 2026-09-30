import { ACTIVITY_LOG_COMMANDS } from "./activity-log.ts";
import { AGENT_CLIENT_COMMANDS } from "./agent-clients.ts";
import { defineCatalog } from "./catalog.ts";
import { EVENT_COMMANDS } from "./events.ts";
import { GITHUB_COMMANDS } from "./github.ts";
import { INBOX_COMMANDS } from "./inbox.ts";
import { INVITE_COMMANDS } from "./invites.ts";
import { MEMBER_COMMANDS } from "./members.ts";
import { MESSAGE_COMMANDS } from "./messages.ts";
import { PACKET_COMMANDS } from "./packets.ts";
import { PERSONAL_ACCESS_TOKEN_COMMANDS } from "./personal-access-tokens.ts";
import { PROPOSAL_COMMANDS } from "./proposals.ts";
import { REQUEST_COMMANDS } from "./requests.ts";
import { SETTINGS_COMMANDS } from "./settings.ts";
import { TEAM_COMMANDS } from "./teams.ts";

// Tiehall's operations, one definition each (public-api: One definition per
// operation, the same on every surface). Each task that builds an operation
// adds its definition here, and registering the catalog checks it.
export const CATALOG = defineCatalog([...MEMBER_COMMANDS, ...INVITE_COMMANDS, ...TEAM_COMMANDS, ...REQUEST_COMMANDS, ...MESSAGE_COMMANDS, ...PACKET_COMMANDS, ...PROPOSAL_COMMANDS, ...INBOX_COMMANDS, ...EVENT_COMMANDS, ...SETTINGS_COMMANDS, ...ACTIVITY_LOG_COMMANDS, ...GITHUB_COMMANDS, ...AGENT_CLIENT_COMMANDS, ...PERSONAL_ACCESS_TOKEN_COMMANDS]);

import { ACTIVITY_LOG_COMMANDS } from "./activity-log.ts";
import { API_COMMANDS } from "./apis.ts";
import { AGENT_CLIENT_COMMANDS } from "./agent-clients.ts";
import { DIRECTORY_COMMANDS } from "./directory.ts";
import { EMAIL_SETTINGS_COMMANDS } from "./email-settings.ts";
import { defineCatalog } from "./catalog.ts";
import { EVENT_COMMANDS } from "./events.ts";
import { GITHUB_COMMANDS } from "./github.ts";
import { INBOX_COMMANDS } from "./inbox.ts";
import { INSTALL_COMMANDS } from "./install.ts";
import { INVITE_COMMANDS } from "./invites.ts";
import { MEMBER_COMMANDS } from "./members.ts";
import { MESSAGE_COMMANDS } from "./messages.ts";
import { PACKET_COMMANDS } from "./packets.ts";
import { PERSONAL_ACCESS_TOKEN_COMMANDS } from "./personal-access-tokens.ts";
import { PROPOSAL_COMMANDS } from "./proposals.ts";
import { PROPOSE_COMMANDS } from "./propose.ts";
import { PULL_REQUEST_COMMANDS } from "./pull-requests.ts";
import { REQUEST_PAGE_COMMANDS } from "./request-pages.ts";
import { REQUEST_COMMANDS } from "./requests.ts";
import { SETTINGS_COMMANDS } from "./settings.ts";
import { TEAM_COMMANDS } from "./teams.ts";
import { UPDATE_COMMANDS } from "./updates.ts";

// Tiehall's operations, one definition each (public-api: One definition per
// operation, the same on every surface). Each task that builds an operation
// adds its definition here, and registering the catalog checks it.
export const CATALOG = defineCatalog([...MEMBER_COMMANDS, ...INVITE_COMMANDS, ...TEAM_COMMANDS, ...REQUEST_COMMANDS, ...PULL_REQUEST_COMMANDS, ...REQUEST_PAGE_COMMANDS, ...DIRECTORY_COMMANDS, ...MESSAGE_COMMANDS, ...PACKET_COMMANDS, ...PROPOSAL_COMMANDS, ...PROPOSE_COMMANDS, ...INBOX_COMMANDS, ...UPDATE_COMMANDS, ...EMAIL_SETTINGS_COMMANDS, ...EVENT_COMMANDS, ...SETTINGS_COMMANDS, ...ACTIVITY_LOG_COMMANDS, ...GITHUB_COMMANDS, ...AGENT_CLIENT_COMMANDS, ...PERSONAL_ACCESS_TOKEN_COMMANDS, ...INSTALL_COMMANDS, ...API_COMMANDS]);

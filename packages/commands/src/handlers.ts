import { ACTIVITY_LOG_EXPORT_HANDLERS } from "./activity-log-export.ts";
import { ACTIVITY_LOG_HANDLERS } from "./activity-log.ts";
import { AGENT_GRANT_HANDLERS } from "./agent-grants.ts";
import { DEVICE_APPROVAL_HANDLERS } from "./device-approval.ts";
import { DIRECTORY_HANDLERS } from "./directory.ts";
import { EVENT_READ_HANDLERS } from "./event-reads.ts";
import type { Handlers } from "./execute.ts";
import { GITHUB_APP_KEY_HANDLERS } from "./github-app-key.ts";
import { GITHUB_INSTALLATION_HANDLERS } from "./github-installation-changes.ts";
import { GITHUB_MODE_HANDLERS, GITHUB_WEBHOOK_SECRET_HANDLERS } from "./github-mode.ts";
import { INVITE_HANDLERS } from "./invites.ts";
import { MEMBER_HANDLERS } from "./member-changes.ts";
import { MESSAGE_HANDLERS } from "./messages.ts";
import { SIGN_IN_POLICY_HANDLERS } from "./sign-in-policy.ts";
import { PACKET_HANDLERS } from "./packets.ts";
import { PERSONAL_ACCESS_TOKEN_HANDLERS } from "./personal-access-tokens.ts";
import { PROPOSAL_CONFIRMATION_HANDLERS } from "./proposal-confirmations.ts";
import { PROPOSAL_ENDING_HANDLERS } from "./proposal-endings.ts";
import { PROPOSAL_UNDO_HANDLERS } from "./proposal-undo.ts";
import { PROPOSAL_WAITING_HANDLERS } from "./proposal-waiting.ts";
import { PROPOSAL_HANDLERS } from "./proposals.ts";
import { PROPOSE_HANDLERS } from "./propose.ts";
import { PULL_REQUEST_LINK_HANDLERS } from "./pull-request-links.ts";
import { REQUEST_PAGE_HANDLERS } from "./request-pages.ts";
import { REQUEST_HANDLERS } from "./requests.ts";
import { TEAM_HANDLERS } from "./teams.ts";
import { USER_HANDLERS } from "./users.ts";
import { WRITE_LIMIT_HANDLERS } from "./write-limits.ts";

// One handler per operation of the catalog, by the operation's id (design.md,
// Technical decisions: T3). Each task that adds an operation to the catalog
// adds its handler here; execute() refuses to start while one is missing.
export const HANDLERS: Handlers = {
  ...MEMBER_HANDLERS,
  ...INVITE_HANDLERS,
  ...TEAM_HANDLERS,
  ...USER_HANDLERS,
  ...REQUEST_HANDLERS,
  ...PULL_REQUEST_LINK_HANDLERS,
  ...REQUEST_PAGE_HANDLERS,
  ...DIRECTORY_HANDLERS,
  ...MESSAGE_HANDLERS,
  ...PACKET_HANDLERS,
  ...PROPOSAL_HANDLERS,
  ...PROPOSE_HANDLERS,
  ...PROPOSAL_CONFIRMATION_HANDLERS,
  ...PROPOSAL_ENDING_HANDLERS,
  ...PROPOSAL_UNDO_HANDLERS,
  ...PROPOSAL_WAITING_HANDLERS,
  ...EVENT_READ_HANDLERS,
  ...WRITE_LIMIT_HANDLERS,
  ...SIGN_IN_POLICY_HANDLERS,
  ...ACTIVITY_LOG_HANDLERS,
  ...ACTIVITY_LOG_EXPORT_HANDLERS,
  ...GITHUB_INSTALLATION_HANDLERS,
  ...GITHUB_MODE_HANDLERS,
  ...GITHUB_WEBHOOK_SECRET_HANDLERS,
  ...GITHUB_APP_KEY_HANDLERS,
  ...AGENT_GRANT_HANDLERS,
  ...DEVICE_APPROVAL_HANDLERS,
  ...PERSONAL_ACCESS_TOKEN_HANDLERS,
};

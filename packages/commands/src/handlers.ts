import { ACTIVITY_LOG_EXPORT_HANDLERS } from "./activity-log-export.ts";
import { ADMIN_ALERT_HANDLERS } from "./admin-alerts.ts";
import { API_CONSUMER_HANDLERS } from "./api-consumers.ts";
import { API_HANDLERS } from "./apis.ts";
import { CLOSE_ON_MERGE_HANDLERS } from "./close-on-merge.ts";
import { CONTRACT_ATTACHMENT_HANDLERS } from "./contract-attachments.ts";
import { CONTRACT_FAN_OUT_HANDLERS } from "./contract-fan-out.ts";
import { CONTRACT_REPORT_HANDLERS } from "./contract-reports.ts";
import { CONTRACT_ROUTING_HANDLERS } from "./contract-routing.ts";
import { WARN_DIGEST_HANDLERS } from "./contract-warn-digests.ts";
import { ACTIVITY_LOG_HANDLERS } from "./activity-log.ts";
import { AGENT_GRANT_HANDLERS } from "./agent-grants.ts";
import { DEVICE_APPROVAL_HANDLERS } from "./device-approval.ts";
import { DIRECTORY_HANDLERS } from "./directory.ts";
import { EMAIL_SETTINGS_HANDLERS } from "./email-settings.ts";
import { EVENT_READ_HANDLERS } from "./event-reads.ts";
import { WAIT_HANDLERS } from "./events-wait.ts";
import type { Handlers } from "./execute.ts";
import { GITHUB_APP_KEY_HANDLERS } from "./github-app-key.ts";
import { GITHUB_INSTALLATION_HANDLERS } from "./github-installation-changes.ts";
import { GITHUB_MODE_HANDLERS, GITHUB_WEBHOOK_SECRET_HANDLERS } from "./github-mode.ts";
import { INSTALL_STATUS_HANDLERS } from "./install-status.ts";
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
import { PROVIDER_PULL_REQUEST_HANDLERS } from "./provider-pull-requests.ts";
import { PULL_REQUEST_LINK_HANDLERS } from "./pull-request-links.ts";
import { REQUEST_PAGE_HANDLERS } from "./request-pages.ts";
import { REQUEST_HANDLERS } from "./requests.ts";
import { TEAM_HANDLERS } from "./teams.ts";
import { MIRROR_FAILURE_HANDLERS } from "./mirror-failures.ts";
import { TRACKER_CHANGE_HANDLERS } from "./tracker-changes.ts";
import { TRACKER_MAPPING_HANDLERS } from "./tracker-mappings.ts";
import { UPDATE_HANDLERS } from "./updates.ts";
import { USER_HANDLERS } from "./users.ts";
import { WEB_SHELL_HANDLERS } from "./web-shell.ts";
import { REQUEST_ACTIVITY_HANDLERS } from "./request-activity.ts";
import { HALL_HANDLERS } from "./hall.ts";
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
  ...CLOSE_ON_MERGE_HANDLERS,
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
  ...UPDATE_HANDLERS,
  ...WAIT_HANDLERS,
  ...EMAIL_SETTINGS_HANDLERS,
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
  ...INSTALL_STATUS_HANDLERS,
  ...ADMIN_ALERT_HANDLERS,
  ...API_HANDLERS,
  ...API_CONSUMER_HANDLERS,
  ...CONTRACT_REPORT_HANDLERS,
  ...PROVIDER_PULL_REQUEST_HANDLERS,
  ...CONTRACT_ATTACHMENT_HANDLERS,
  ...CONTRACT_ROUTING_HANDLERS,
  ...WARN_DIGEST_HANDLERS,
  ...CONTRACT_FAN_OUT_HANDLERS,
  ...TRACKER_MAPPING_HANDLERS,
  ...TRACKER_CHANGE_HANDLERS,
  ...MIRROR_FAILURE_HANDLERS,
  ...WEB_SHELL_HANDLERS,
  ...REQUEST_ACTIVITY_HANDLERS,
  ...HALL_HANDLERS,
};

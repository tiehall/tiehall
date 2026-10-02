import { ACTIVITY_LOG_DOWNLOADS, ACTIVITY_LOG_REVIEWS } from "./activity-log-export.ts";
import { AGENT_GRANT_REDIRECTS, AGENT_GRANT_REVIEWS } from "./agent-grants.ts";
import { API_REVIEWS } from "./apis.ts";
import { CONTRACT_FAN_OUT_REVIEWS } from "./contract-fan-out.ts";
import type { ConfirmDownloads, ConfirmEntries, ConfirmMessages, ConfirmRedirects } from "./confirm-route.ts";
import type { ConfirmationSubjects, Reviews } from "./confirmation-step.ts";
import { DEVICE_APPROVAL_ENTRIES, DEVICE_APPROVAL_MESSAGES, DEVICE_APPROVAL_REVIEWS } from "./device-approval.ts";
import { GITHUB_APP_KEY_REVIEWS } from "./github-app-key.ts";
import { GITHUB_INSTALLATION_REVIEWS } from "./github-installation-changes.ts";
import { GITHUB_MODE_REVIEWS } from "./github-mode.ts";
import { INVITE_REVIEWS } from "./invites.ts";
import { MEMBER_REVIEWS } from "./member-changes.ts";
import { PERSONAL_ACCESS_TOKEN_MESSAGES, PERSONAL_ACCESS_TOKEN_REVIEWS, PERSONAL_ACCESS_TOKEN_SETTINGS_REVIEWS } from "./personal-access-tokens.ts";
import { PROPOSAL_CONFIRMATION_SUBJECTS, PROPOSAL_REVIEWS } from "./proposal-confirmations.ts";
import { UNDO_REVIEWS } from "./proposal-undo.ts";
import { SIGN_IN_POLICY_REVIEWS } from "./sign-in-policy.ts";
import { WRITE_LIMIT_REVIEWS } from "./write-limits.ts";

// One review per command of the catalog that needs the confirmation step, by
// the command's id (agent-safety: The review page of the confirmation step).
// Each task that adds such a command adds its review here; the confirmation
// step refuses to start while one is missing.
export const REVIEWS: Reviews = {
  ...MEMBER_REVIEWS,
  ...INVITE_REVIEWS,
  ...WRITE_LIMIT_REVIEWS,
  ...SIGN_IN_POLICY_REVIEWS,
  ...PROPOSAL_REVIEWS,
  ...UNDO_REVIEWS,
  ...ACTIVITY_LOG_REVIEWS,
  ...GITHUB_INSTALLATION_REVIEWS,
  ...GITHUB_MODE_REVIEWS,
  ...GITHUB_APP_KEY_REVIEWS,
  ...AGENT_GRANT_REVIEWS,
  ...DEVICE_APPROVAL_REVIEWS,
  ...PERSONAL_ACCESS_TOKEN_REVIEWS,
  ...PERSONAL_ACCESS_TOKEN_SETTINGS_REVIEWS,
  ...API_REVIEWS,
  ...CONTRACT_FAN_OUT_REVIEWS,
};

// What a command's confirmation nonce is bound to, where it is not the
// command's input (agent-safety: One confirmation approves one action): a
// proposal's confirmation binds it to what the proposal proposes and the
// request it applies to.
export const CONFIRMATION_SUBJECTS: ConfirmationSubjects = { ...PROPOSAL_CONFIRMATION_SUBJECTS };

// The commands whose confirmation answers with a file made from the command's
// output instead of the "Confirmed" page (activity-log: Exporting the activity
// log): the activity log's export gives its JSONL file.
export const CONFIRM_DOWNLOADS: ConfirmDownloads = { ...ACTIVITY_LOG_DOWNLOADS };

// The commands whose confirmation sends the browser on to a path on the
// install instead of the "Confirmed" page (agent-access: Approving an agent
// client uses the confirmation step): an agent client's approval goes back to
// the authorization, which gives the client its code.
export const CONFIRM_REDIRECTS: ConfirmRedirects = { ...AGENT_GRANT_REDIRECTS };

// The commands whose review page only a page of their own serves (agent-access:
// The device approval page cannot be prefilled): the tiehall CLI's approval is
// reviewed on the device approval page, for the code the person typed there.
export const CONFIRM_ENTRIES: ConfirmEntries = { ...DEVICE_APPROVAL_ENTRIES };

// The commands whose confirmation answers with a page in their own words
// instead of the "Confirmed" page: the tiehall CLI's approval sends the person
// back to their terminal, and a new personal access token's page shows its
// value, this once.
export const CONFIRM_MESSAGES: ConfirmMessages = { ...DEVICE_APPROVAL_MESSAGES, ...PERSONAL_ACCESS_TOKEN_MESSAGES };

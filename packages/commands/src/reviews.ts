import { ACTIVITY_LOG_DOWNLOADS, ACTIVITY_LOG_REVIEWS } from "./activity-log-export.ts";
import type { ConfirmDownloads } from "./confirm-route.ts";
import type { ConfirmationSubjects, Reviews } from "./confirmation-step.ts";
import { GITHUB_INSTALLATION_REVIEWS } from "./github-installation-changes.ts";
import { MEMBER_REVIEWS } from "./member-changes.ts";
import { PROPOSAL_CONFIRMATION_SUBJECTS, PROPOSAL_REVIEWS } from "./proposal-confirmations.ts";
import { UNDO_REVIEWS } from "./proposal-undo.ts";
import { WRITE_LIMIT_REVIEWS } from "./write-limits.ts";

// One review per command of the catalog that needs the confirmation step, by
// the command's id (agent-safety: The review page of the confirmation step).
// Each task that adds such a command adds its review here; the confirmation
// step refuses to start while one is missing.
export const REVIEWS: Reviews = {
  ...MEMBER_REVIEWS,
  ...WRITE_LIMIT_REVIEWS,
  ...PROPOSAL_REVIEWS,
  ...UNDO_REVIEWS,
  ...ACTIVITY_LOG_REVIEWS,
  ...GITHUB_INSTALLATION_REVIEWS,
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

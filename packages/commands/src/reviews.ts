import type { Reviews } from "./confirmation-step.ts";
import { MEMBER_REVIEWS } from "./member-changes.ts";

// One review per command of the catalog that needs the confirmation step, by
// the command's id (agent-safety: The review page of the confirmation step).
// Each task that adds such a command adds its review here; the confirmation
// step refuses to start while one is missing.
export const REVIEWS: Reviews = { ...MEMBER_REVIEWS };

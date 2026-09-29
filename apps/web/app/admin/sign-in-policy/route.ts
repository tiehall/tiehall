import { signInPolicyRoute } from "@tiehall/commands/web";

// The sign-in policy page of the admin UI (sign-in: The sign-in policy): a
// signed-in admin sees the policy in force and follows a link to the review
// page that changes it, with the confirmation step. A GET reads through
// execute() in a read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return signInPolicyRoute(process.env)(request);
}

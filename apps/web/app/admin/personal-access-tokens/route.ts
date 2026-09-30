import { personalAccessTokenSettingsRoute } from "@tiehall/commands/web";

// The personal access tokens page of the admin UI (agent-access: An admin sets
// the PAT switch and the maximum lifetime): a signed-in admin sees whether
// personal access tokens are switched on and the longest lifetime of a new
// one, follows a link to the review page that switches them, and posts a form
// that leads to the review page of a new longest lifetime; each change needs
// the confirmation step. A GET reads through execute() in a read-only
// transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return personalAccessTokenSettingsRoute(process.env)(request);
}

export { handle as GET, handle as POST };

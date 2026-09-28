import { githubWebhookRoute } from "@tiehall/commands/webhooks";

// Where GitHub delivers the install's GitHub App's webhooks (tracker-mirrors:
// GitHub webhooks are verified, deduplicated and processed in the background):
// a delivery whose signature verifies with the stored webhook secret is stored
// once by its delivery id, answered with 202 and processed in a background
// job; any other gets 401, as does every delivery while no webhook secret is
// stored. The setup gate serves it from the moment the setup screen has stored
// the App's credentials. A GET is answered with 404.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return githubWebhookRoute(process.env)(request);
}

export { handle as GET, handle as POST };

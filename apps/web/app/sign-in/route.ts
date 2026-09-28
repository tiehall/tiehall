import { signInPageRoute } from "@tiehall/commands/web";

// The sign-in page (sign-in: GitHub is the only way to sign in): its GET
// offers sign-in with GitHub and nothing else, and its form's POST, sent from
// the page on the install's own URL, sends the browser to GitHub to authorize
// the install's App, which sends it back to the sign-in callback.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return signInPageRoute(process.env)(request);
}

export { handle as GET, handle as POST };

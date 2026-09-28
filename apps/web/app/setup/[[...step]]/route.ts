import { setupRoute } from "@tiehall/commands/web";

// The setup screen (self-host-install: The setup code guards the setup
// screen; self-host-install: The GitHub App is created with GitHub's manifest
// flow; self-host-install: Setup names the company and makes the first admin):
// the form for the setup code the app prints to its log, which opens a setup
// session in the browser that enters it, then the company's name, the GitHub
// App step, /setup/github, where GitHub sends the operator back from the
// manifest flow, and the sign-in with GitHub under /setup/sign-in that
// completes setup.
// The segment is an optional catch-all, so /setup and every path under it
// reach the one route, which reads the path itself. It answers 404 once setup
// is complete.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return setupRoute(process.env)(request);
}

export { handle as GET, handle as POST };

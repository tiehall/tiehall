import { setupRoute } from "@tiehall/commands/setup";

// The setup screen (self-host-install: The setup code guards the setup
// screen): the form for the setup code the app prints to its log, which opens
// a setup session in the browser that enters it. It answers 404 once setup is
// complete.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return setupRoute(process.env)(request);
}

export { handle as GET, handle as POST };

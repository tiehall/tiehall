import { adminRoute } from "@tiehall/commands/web";

// The admin page, the first page of the admin UI (self-host-install: The
// admin page warns about missing backups): when the last backup finished, and
// a warning when none has, or none in the last 7 days. A GET reads through
// execute() in a read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return adminRoute(process.env)(request);
}

export { handle as GET };

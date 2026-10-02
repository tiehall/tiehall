import { apisRoute } from "@tiehall/commands/web";

// The APIs page of the admin UI (contract-changes: Admins register APIs, each
// bound to one repository): a signed-in admin sees the registered APIs and
// fills in the form that leads to a registration's review page, where it takes
// effect with the confirmation step. A GET reads through execute() in a
// read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return apisRoute(process.env)(request);
}

export { handle as GET, handle as POST };

import { requestListsRoute } from "@tiehall/commands/web";

// The web UI's request lists (requests: Every member sees every request): the
// requests addressed to the member's teams, those they opened, and every
// request of the install, newest first, each read through execute() as the
// member's web session; ?list=opened and ?list=all pick the other two lists,
// ?state= narrows one to a state, and ?page= turns its pages.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return requestListsRoute(process.env)(request);
}

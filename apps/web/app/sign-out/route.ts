import { signOutRoute } from "@tiehall/commands/web";

// Signing out (sign-in: Signing out and ending sessions): the web UI's
// sign-out form posts here, with the session's CSRF token, from a page of the
// install. It ends that web session at once, and only that one; the user's
// agents keep their grants and tokens.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return signOutRoute(process.env)(request);
}

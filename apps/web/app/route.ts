import { homeRoute } from "@tiehall/commands/web";

// The home page (sign-in: GitHub is the only way to sign in; sign-in: Signing
// out and ending sessions): a person who is not signed in is sent to the
// sign-in page, and a signed-in member gets the web UI with the sign-out form.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return homeRoute(process.env)(request);
}

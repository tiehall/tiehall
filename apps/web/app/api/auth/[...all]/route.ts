import { signInServiceRoute } from "@tiehall/commands/web";

// The sign-in service's own routes under /api/auth (sign-in: GitHub is the
// only way to sign in; design.md, Technical decisions: T7 and T8). Over HTTP
// it serves only GitHub's return to the sign-in callback, which turns a sign-in
// with GitHub into a web session; every other route answers 404, as the error
// model answers a route the install does not serve. The segment is a
// catch-all, so every path under /api/auth reaches the service, which reads
// the path itself.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return signInServiceRoute(process.env)(request);
}

export { handle as GET, handle as POST };

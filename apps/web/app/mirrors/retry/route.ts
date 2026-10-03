import { mirrorRetryRoute } from "@tiehall/commands/web";

// The target of the Retry button of a failed mirror job's banner
// (tracker-mirrors: Failed mirror jobs are shown with a Retry button): an
// admin, or a member of the request's target team, runs the request's mirror
// job again with a form that passes the web UI's write checks, and is led
// back to the page the banner showed on. It answers posts alone.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return mirrorRetryRoute(process.env)(request);
}

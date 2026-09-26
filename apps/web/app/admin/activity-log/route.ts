import { activityLogRoute } from "@tiehall/commands/web";

// The activity log's page (activity-log: The admin view; activity-log:
// Security events are shown to admins only): a signed-in admin views the
// install's domain and security events, newest first, filtered by time,
// actor, request and event type. A GET reads through execute() in a
// read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return activityLogRoute(process.env)(request);
}

import { emailSettingsRoute } from "@tiehall/commands/web";

// A member's email settings (requester-loop: Email for people, only when SMTP
// is set): where Tiehall emails them, and the form that turns their daily
// digest off or on, whose POST passes the web UI's write checks; no setting
// stops transactional email. A GET reads through execute() in a read-only
// transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return emailSettingsRoute(process.env)(request);
}

export { handle as GET, handle as POST };

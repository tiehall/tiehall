import { deviceApprovalRoute } from "@tiehall/commands/web";

// The device approval page (agent-access: The device approval page cannot be
// prefilled): a signed-in member types the code `tiehall login` printed, reads
// where and when that sign-in started, and approves it with the confirmation
// step. The page ignores any code its link carries. A browser without a
// session is sent to sign in first, and comes back.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return deviceApprovalRoute(process.env)(request);
}

export { handle as GET, handle as POST };

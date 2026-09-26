"use server";

import { headers } from "next/headers";
import { webCommands, type WebResult } from "@tiehall/commands/web";

// How a server action writes through an operation (public-api: One definition
// per operation, the same on every surface; agent-safety: One confirmation
// approves one action; design.md, Technical decisions: T3). The form that
// calls it sends the session's CSRF token; the write runs only when that token
// is the signed-in session's, the request's Origin is TIEHALL_URL and its
// Sec-Fetch-Site is same-origin, and then through execute(), in this process,
// as the user's web session, so the web UI has no rights the same user lacks
// over /api/v1. It gets back the output or the same RFC 9457 problem. An action
// that needs the confirmation step is applied only from its review page.

export async function writeCommand<Output = unknown>(commandId: string, input: unknown, csrfToken: string): Promise<WebResult<Output>> {
  const request = await headers();
  const ipAddress = request.get("x-forwarded-for") ?? undefined;
  const userAgent = request.get("user-agent") ?? undefined;
  return webCommands(process.env).write<Output>(
    commandId,
    input,
    { origin: request.get("origin"), fetchSite: request.get("sec-fetch-site"), csrfToken },
    { origin: { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) } },
  );
}

import { NextResponse } from "next/server";
import { setupGate } from "@tiehall/commands/setup";
import { requestUrlOf, requestUrlRoute } from "@tiehall/commands/web";

// Runs before every route (self-host-install: The setup code guards the setup
// screen; design.md, Self-hosting decisions: S3). Until setup is complete, the
// setup gate answers every call but /setup, /healthz and, once the setup
// screen has stored the GitHub App's credentials, with or without a webhook
// secret, /webhooks/github: a page leads to /setup and an API call gets 503
// setup-required. Afterwards every call goes on to its route, except a call to
// a request's URL, /<KEY> with or without .md or .json, which is negotiated
// here (agent-surfaces: Negotiated request URLs; design.md, Technical
// decisions: T3): markdown, JSON, a redirect or a refusal is answered here, and
// HTML goes on to the web UI's request page with the headers every answer of a
// request URL carries, and the cookie that renews the session, which a server
// component cannot set.

export async function proxy(request: Request): Promise<Response> {
  const gated = await setupGate(process.env)(request);
  if (gated !== undefined) return gated;
  if (requestUrlOf(new URL(request.url).pathname) === undefined) return NextResponse.next();
  const answer = await requestUrlRoute(process.env)(request);
  if (answer === undefined) return NextResponse.next();
  if ("response" in answer) return answer.response;
  const next = NextResponse.next();
  answer.page.headers.forEach((value, name) => {
    if (name !== "set-cookie") next.headers.set(name, value);
  });
  for (const cookie of answer.page.headers.getSetCookie()) next.headers.append("set-cookie", cookie);
  return next;
}

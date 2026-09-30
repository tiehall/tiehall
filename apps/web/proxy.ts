import { NextResponse } from "next/server";
import { setupGate } from "@tiehall/commands/setup";
import { negotiatedUrlOf, pageContentSecurityPolicy, requestUrlRoute } from "@tiehall/commands/web";

// Runs before every route (self-host-install: The setup code guards the setup
// screen; design.md, Self-hosting decisions: S3). Until setup is complete, the
// setup gate answers every call but /setup, /healthz and, once the setup
// screen has stored the GitHub App's credentials, with or without a webhook
// secret, /webhooks/github: a page leads to /setup and an API call gets 503
// setup-required. Afterwards every call goes on to its route, except a call to
// a request's URL, /<KEY> with or without .md or .json, or to a team's intake
// page, /<TEAM> with or without them, which is negotiated here
// (agent-surfaces: Negotiated request URLs; agent-surfaces: Team intake pages;
// design.md, Technical decisions: T3): markdown, JSON, a redirect or a refusal
// is answered here, and HTML goes on to the web UI's page with the headers
// every answer of a negotiated URL carries, and the cookie that renews the
// session, which a server component cannot set. The page's content security
// policy, whose script
// nonce is made for each answer, goes to Next.js with the call too, which then
// puts the nonce on the page's scripts (agent-safety: The web UI renders no
// raw HTML and no remote images); so does the policy of a form's post to the
// page, whose answer is the page again when the browser runs no script.

/** Lets the call go on to its route with the page's content security policy, which Next.js reads its script nonce from. */
function withPolicy(request: Request, policy: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  const next = NextResponse.next({ request: { headers } });
  next.headers.set("content-security-policy", policy);
  return next;
}

export async function proxy(request: Request): Promise<Response> {
  const gated = await setupGate(process.env)(request);
  if (gated !== undefined) return gated;
  if (negotiatedUrlOf(new URL(request.url).pathname) === undefined) return NextResponse.next();
  const answer = await requestUrlRoute(process.env)(request);
  // A form's post to the page, which runs the page's server action.
  if (answer === undefined) return withPolicy(request, pageContentSecurityPolicy());
  if ("response" in answer) return answer.response;
  const next = withPolicy(request, answer.page.headers.get("content-security-policy") ?? pageContentSecurityPolicy());
  answer.page.headers.forEach((value, name) => {
    if (name !== "set-cookie") next.headers.set(name, value);
  });
  for (const cookie of answer.page.headers.getSetCookie()) next.headers.append("set-cookie", cookie);
  return next;
}

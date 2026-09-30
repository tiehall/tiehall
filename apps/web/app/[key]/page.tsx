import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { readRequestPageAs, webCommands } from "@tiehall/commands/web";
import { RequestPage } from "../../lib/request-page.tsx";

// The web UI's page of a request, at its URL, /<KEY> (agent-surfaces:
// Negotiated request URLs; agent-safety: The needs_human flag is visible and
// reaches the people on the request; design.md, Technical decisions: T3). The
// proxy negotiates the URL first (apps/web/proxy.ts): it answers markdown,
// JSON, redirects and refusals itself, and lets a call that negotiates HTML
// reach this page only for a signed-in member and the request's canonical
// key, with the headers of every answer of a request URL and the cookie that
// renews the session, which a server component cannot set. The page is a
// server component that reads the request with its thread, its packet and its
// proposals through execute() in this process, as the signed-in user's web
// session, in read-only transactions (request-page-data.ts), and renders them
// (lib/request-page.tsx), with the forms of the actions the reader may take
// there, which run through a server action (lib/request-actions.ts) and carry
// the session's CSRF token. A path that is no request's key is no page. Should
// the session end, or the request go, between the proxy's read and this one,
// the page sends the browser to sign in, or says what refused it.

// Rendered for every request, never prerendered or cached.
export const dynamic = "force-dynamic";

/** A request's key, such as FE-142: a team key, a hyphen and a number. */
const REQUEST_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/;

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!REQUEST_KEY.test(key)) notFound();
  const web = webCommands(process.env, async () => new Headers(await headers()));
  const read = await readRequestPageAs(web, key);
  if (!read.ok) {
    if (read.problem.status === 401) redirect(`/sign-in?return=${encodeURIComponent(`/${key}`)}`);
    if (read.problem.status === 404) notFound();
    return (
      <main>
        <h1>{read.problem.title}</h1>
        <p>{read.problem.detail}</p>
      </main>
    );
  }
  // The CSRF token the page's forms carry, which each of their writes must send (web-writes.ts).
  const csrf = await web.csrfToken();
  if (csrf === undefined) redirect(`/sign-in?return=${encodeURIComponent(`/${key}`)}`);
  return <RequestPage data={read.output} csrf={csrf} />;
}

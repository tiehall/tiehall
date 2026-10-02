import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { NEGOTIATED_KEY_HEADER, readRequestPageAs, webCommands, type TeamApisView, type TeamIntakeView } from "@tiehall/commands/web";
import { IntakePage } from "../../lib/intake-page.tsx";
import { RequestPage } from "../../lib/request-page.tsx";

// The web UI's page of a request, at its URL, /<KEY>, and a team's intake
// page, at /<TEAM> (agent-surfaces: Negotiated request URLs; agent-surfaces:
// Team intake pages; agent-safety: The needs_human flag is visible and
// reaches the people on the request; design.md, Technical decisions: T3). The
// proxy negotiates the URL first (apps/web/proxy.ts): it answers markdown,
// JSON, redirects and refusals itself, and lets a call that negotiates HTML
// reach this page only for a signed-in member and the request's or the team's
// current key, with the headers of every answer of a negotiated URL and the
// cookie that renews the session, which a server component cannot set. It
// names that key to the page in a header of its own, which it takes from
// every other call; the page renders only a call the proxy named its key for,
// and is no page for any other, such as a path or a method Next.js would
// bring here that the proxy did not negotiate, so nothing reaches it around
// the negotiation. An
// intake page reads the team through teams.get and shows it, with the
// registered APIs and the team's declarations that it consumes them, which
// apis.list_for_team reads, and their forms (lib/intake-page.tsx). The page of a request is a
// server component that reads the request with its thread, its packet and its
// proposals through execute() in this process, as the signed-in user's web
// session, in read-only transactions (request-page-data.ts), and renders them
// (lib/request-page.tsx), with the forms of the actions the reader may take
// there, which run through a server action (lib/request-actions.ts) and carry
// the session's CSRF token. A path that is neither a request's key nor a
// team's is no page. Should the session end, or the request go, between the
// proxy's read and this one,
// the page sends the browser to sign in, or says what refused it.

// Rendered for every request, never prerendered or cached.
export const dynamic = "force-dynamic";

/** A request's key, such as FE-142: a team key, a hyphen and a number. */
const REQUEST_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/;
/** A team's key, such as FE, whose intake page this path is. */
const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // Only a call the proxy negotiated as this key's page.
  if ((await headers()).get(NEGOTIATED_KEY_HEADER) !== key) notFound();
  const web = webCommands(process.env, async () => new Headers(await headers()));
  if (TEAM_KEY.test(key)) {
    // A team's intake page, which the proxy lets through only for a signed-in member and the team's current key.
    const team = await web.read<TeamIntakeView>("teams.get", { key });
    if (!team.ok) return refusal(team.problem, key);
    // The registered APIs with the team's declarations, and the CSRF token its members' forms carry.
    const apis = await web.read<TeamApisView>("apis.list_for_team", { team: key });
    const csrf = await web.csrfToken();
    return <IntakePage team={team.output} apis={apis.ok ? apis.output : undefined} csrf={csrf} />;
  }
  if (!REQUEST_KEY.test(key)) notFound();
  const read = await readRequestPageAs(web, key);
  if (!read.ok) return refusal(read.problem, key);
  // The CSRF token the page's forms carry, which each of their writes must send (web-writes.ts).
  const csrf = await web.csrfToken();
  if (csrf === undefined) redirect(`/sign-in?return=${encodeURIComponent(`/${key}`)}`);
  return <RequestPage data={read.output} csrf={csrf} />;
}

/** A read the page needs was refused: a browser that is not signed in signs in and comes back, and any other refusal is said. */
function refusal(problem: { status: number; title: string; detail: string }, key: string) {
  if (problem.status === 401) redirect(`/sign-in?return=${encodeURIComponent(`/${key}`)}`);
  if (problem.status === 404) notFound();
  return (
    <main>
      <h1>{problem.title}</h1>
      <p>{problem.detail}</p>
    </main>
  );
}

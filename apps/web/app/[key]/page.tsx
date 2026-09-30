import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { webCommands } from "@tiehall/commands/web";

// The web UI's page of a request, at its URL, /<KEY> (agent-surfaces:
// Negotiated request URLs; design.md, Technical decisions: T3). The proxy
// negotiates the URL first (apps/web/proxy.ts): it answers markdown, JSON,
// redirects and refusals itself, and lets a call that negotiates HTML reach
// this page only for a signed-in member and the request's canonical key. The
// page is a server component that reads the request through execute() in this
// process, as the signed-in user's web session, in a read-only transaction.
// A path that is no request's key is no page. Should the session end, or the
// request go, between the proxy's read and this one, the page sends the
// browser to sign in, or says so.

// Rendered for every request, never prerendered or cached.
export const dynamic = "force-dynamic";

/** A request's key, such as FE-142: a team key, a hyphen and a number. */
const REQUEST_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/;

interface RequestRead {
  key: string;
  state: string;
  targetTeam: { key: string };
  requester: { user: { login: string } | null; team: { key: string } };
  claimant: { login: string } | null;
  untrusted: { title: string };
}

export default async function RequestPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!REQUEST_KEY.test(key)) notFound();
  const web = webCommands(process.env, async () => new Headers(await headers()));
  const read = await web.read<RequestRead>("requests.get", { key });
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
  const request = read.output;
  return (
    <main>
      <h1>
        {request.key}: {request.untrusted.title}
      </h1>
      <p>
        {request.key} is {request.state}, addressed to team {request.targetTeam.key}.
      </p>
    </main>
  );
}

// GitHub's answers to a requester that may not see an organization's members
// (sign-in: Who may sign in; sign-in: Leaving the GitHub organization ends
// access). GitHub documents that `GET /orgs/{org}/members/{username}` answers
// such a requester 302, to `/orgs/{org}/public_members/{username}`, which
// answers 204 for a public member and 404 for anyone else, and that
// `GET /orgs/{org}/members` lists it the public members only. An
// installation's token is such a requester when GitHub issued it without the
// Members permission, and for an organization that is not the installation's
// own. The GitHub stub refuses those calls with 403 instead, so a test that
// needs GitHub's own answers reaches the stub through this fetch.

export interface PublicMembersOptions {
  /** The organization's login, as Tiehall asks by it. */
  org: string;
  /** The accounts GitHub shows anyone as the organization's members, by login and numeric id. */
  publicMembers: readonly { login: string; id: number }[];
  /** GitHub issues the installation's tokens without the Members permission, as after an owner removed it. */
  withoutMembersPermission?: boolean;
  /** The numeric id of another organization that holds the login now, as after a rename, when one took it. */
  loginNowNames?: number;
}

function pathOf(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

/** A fetch that reaches the stub, except for the calls GitHub answers with the organization's public members only. */
export function publicMembersOnly(options: PublicMembersOptions): typeof fetch {
  const { org, publicMembers } = options;
  return async (input, init) => {
    const url = pathOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname) && options.withoutMembersPermission === true) {
      const issued = await fetch(input, init);
      if (issued.status !== 201) return issued;
      const token = (await issued.json()) as { permissions?: Record<string, string> };
      const { members: _removed, ...permissions } = token.permissions ?? {};
      return Response.json({ ...token, permissions }, { status: 201 });
    }
    if (method === "GET" && url.pathname === `/users/${org}` && options.loginNowNames !== undefined) {
      return Response.json({ login: org, id: options.loginNowNames, type: "Organization" });
    }
    const check = new RegExp(`^/orgs/${org}/members/([^/]+)$`).exec(url.pathname);
    if (method === "GET" && check !== null) {
      // The redirect as GitHub answers it, or, for a fetch that follows it, the public members' answer.
      if (init?.redirect === "manual" || init?.redirect === "error") {
        return new Response(null, { status: 302, headers: { location: `${url.origin}/orgs/${org}/public_members/${check[1]}` } });
      }
      return publicMembers.some(({ login }) => login === check[1]) ? new Response(null, { status: 204 }) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (method === "GET" && url.pathname === `/orgs/${org}/members`) {
      return Response.json(publicMembers.map(({ login, id }) => ({ login, id, type: "User" })));
    }
    return fetch(input, init);
  };
}

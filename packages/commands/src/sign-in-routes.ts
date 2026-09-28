// The classification of the sign-in service's own routes (agent-safety: The
// confirmation step runs only in the web UI; design.md, Technical decisions:
// T8). Better Auth brings routes Tiehall does not use, and some of them answer
// even with their flow switched off. An agent that drives a browser could call
// any of them with same-origin requests and a session cookie alone, so the
// sign-in service's route guard serves over HTTP only what this list allows:
// - harmless: served to anyone, such as GitHub's return to the sign-in
//   callback, with the only value each of its parameters may take;
// - gated: served only with the confirmation step's nonce for that exact
//   action; none is gated yet, and the guard refuses a gated route until the
//   task that needs one gates it;
// - blocked: never served over HTTP, answered with 404 as the error model
//   answers a route the install does not serve. Tiehall's own pages still call
//   some of them in the same process, such as starting a sign-in from the
//   sign-in page.
// A route is its method and its path under /api/auth, as the library defines
// it, such as `GET /callback/:id`. The route inventory test lists every route
// of the service as it is built and fails on any route this list does not
// classify, so a route that a library upgrade or a plugin adds is classified
// before it ships.

export type SignInRouteClass =
  | { kind: "harmless"; params?: Readonly<Record<string, string>>; why: string }
  | { kind: "gated"; why: string }
  | { kind: "blocked"; why: string };

const EMAIL_AND_PASSWORD = "Email and password is not a way to sign in to Tiehall (sign-in: GitHub is the only way to sign in).";
const SESSIONS = "Tiehall's own pages manage web sessions; this route would let a same-origin request do it with the cookie alone.";

export const SIGN_IN_ROUTES: Readonly<Record<string, SignInRouteClass>> = {
  "GET /callback/:id": {
    kind: "harmless",
    params: { id: "github" },
    why: "GitHub's return to the sign-in callback, which turns an authorized sign-in with GitHub into a web session.",
  },
  "POST /callback/:id": { kind: "blocked", why: "GitHub returns to the sign-in callback with a GET; the form-post return is not used." },
  "POST /sign-in/social": {
    kind: "blocked",
    why: "Tiehall's sign-in page starts a sign-in with GitHub in the same process, after checking the form's origin.",
  },
  "GET /get-session": { kind: "blocked", why: "Tiehall reads a request's web session in the same process; no page needs it over HTTP." },
  "POST /get-session": { kind: "blocked", why: "Tiehall reads a request's web session in the same process; no page needs it over HTTP." },
  "POST /sign-out": { kind: "blocked", why: "Tiehall's own sign-out, which passes the web UI's write checks, ends the session in the same process." },
  "POST /sign-up/email": { kind: "blocked", why: EMAIL_AND_PASSWORD },
  "POST /sign-in/email": { kind: "blocked", why: EMAIL_AND_PASSWORD },
  "POST /reset-password": { kind: "blocked", why: EMAIL_AND_PASSWORD },
  "POST /verify-password": { kind: "blocked", why: EMAIL_AND_PASSWORD },
  "POST /request-password-reset": { kind: "blocked", why: EMAIL_AND_PASSWORD },
  "GET /reset-password/:token": { kind: "blocked", why: EMAIL_AND_PASSWORD },
  "POST /change-password": { kind: "blocked", why: EMAIL_AND_PASSWORD },
  "GET /verify-email": { kind: "blocked", why: "The email address comes from GitHub, which verified it (sign-in: The email address comes from GitHub)." },
  "POST /send-verification-email": {
    kind: "blocked",
    why: "The email address comes from GitHub, which verified it (sign-in: The email address comes from GitHub).",
  },
  "POST /change-email": {
    kind: "blocked",
    why: "The email address comes from GitHub at each sign-in; nobody changes it in Tiehall (sign-in: The email address comes from GitHub).",
  },
  "POST /update-user": {
    kind: "blocked",
    why: "A user's login and email address come from their GitHub account at each sign-in; nobody changes them in Tiehall.",
  },
  "POST /update-session": { kind: "blocked", why: SESSIONS },
  "GET /list-sessions": { kind: "blocked", why: SESSIONS },
  "POST /revoke-session": { kind: "blocked", why: SESSIONS },
  "POST /revoke-sessions": { kind: "blocked", why: SESSIONS },
  "POST /revoke-other-sessions": { kind: "blocked", why: SESSIONS },
  "POST /delete-user": { kind: "blocked", why: "A user stays when they leave; an admin removes a member with the confirmation step instead." },
  "GET /delete-user/callback": { kind: "blocked", why: "A user stays when they leave; an admin removes a member with the confirmation step instead." },
  "POST /link-social": {
    kind: "blocked",
    why: "A Tiehall user has exactly one GitHub account and no other sign-in identity (sign-in: One Tiehall user per GitHub account).",
  },
  "POST /unlink-account": {
    kind: "blocked",
    why: "A Tiehall user has exactly one GitHub account and no other sign-in identity (sign-in: One Tiehall user per GitHub account).",
  },
  "GET /list-accounts": { kind: "blocked", why: "Tiehall shows a user's GitHub account on its own pages; no page needs the list over HTTP." },
  "POST /refresh-token": { kind: "blocked", why: "Tiehall keeps no GitHub user token to refresh (sign-in: Tiehall keeps no GitHub user token)." },
  "POST /get-access-token": { kind: "blocked", why: "Tiehall keeps no GitHub user token to hand out (sign-in: Tiehall keeps no GitHub user token)." },
  "GET /account-info": {
    kind: "blocked",
    why: "It would call GitHub with the user's token, which Tiehall does not keep; Tiehall calls GitHub as its App only.",
  },
  "GET /ok": { kind: "blocked", why: "The install's health is /healthz, which answers only up or down." },
  "GET /error": { kind: "blocked", why: "A sign-in that did not complete returns to Tiehall's own sign-in page, which says why." },
};

/** A route of a sign-in service instance: its method and its path under /api/auth. */
interface Endpoint {
  path?: string;
  options?: { method?: string | readonly string[] };
}

/** Every route of a sign-in service instance's API, one per method, such as `GET /callback/:id`; an endpoint without a path serves no route. */
export function routeInventory(api: Readonly<Record<string, unknown>>): string[] {
  const routes = new Set<string>();
  for (const endpoint of Object.values(api) as Endpoint[]) {
    if (typeof endpoint?.path !== "string") continue;
    const method = endpoint.options?.method;
    const methods = method === undefined || method === "*" ? ["*"] : typeof method === "string" ? [method] : [...method];
    for (const each of methods) routes.add(`${each.toUpperCase()} ${endpoint.path}`);
  }
  return [...routes].sort();
}

/** The routes the classification does not mark, which the route inventory test fails on. */
export function unclassifiedRoutes(routes: readonly string[], classification: Readonly<Record<string, SignInRouteClass>> = SIGN_IN_ROUTES): string[] {
  return routes.filter((route) => !Object.hasOwn(classification, route));
}

/** Whether the route guard serves this request over HTTP: a harmless route, with its parameters' one value each. */
export function servedOverHttp(method: string, path: string, params: Readonly<Record<string, unknown>>): boolean {
  const route = SIGN_IN_ROUTES[`${method.toUpperCase()} ${path}`];
  if (route?.kind !== "harmless") return false;
  return Object.entries(route.params ?? {}).every(([name, value]) => params[name] === value);
}

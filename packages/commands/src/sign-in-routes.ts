// The classification of the sign-in service's own routes (agent-safety: The
// confirmation step runs only in the web UI; design.md, Technical decisions:
// T8). Better Auth brings routes Tiehall does not use, and some of them answer
// even with their flow switched off. An agent that drives a browser could call
// any of them with same-origin requests and a session cookie alone, so the
// sign-in service's route guard serves over HTTP only what this list allows:
// - harmless: served to anyone, such as GitHub's return to the sign-in
//   callback, with the only value each of its parameters may take, and the
//   routes an agent client runs the OAuth flow through, which grant it
//   nothing a person has not approved (agent-access: Tiehall is the
//   authorization server for agent clients);
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
const CLIENTS = "Agent clients register themselves or are identified by their metadata document; nobody manages them through this route.";
const GRANTS =
  "A person approves an agent client on the consent screen with the confirmation step, and sees and revokes their grants on Tiehall's own pages; this route would let a same-origin request change a grant with the cookie alone.";
const RESOURCES = "The install has one protected resource, its MCP endpoint, which the authorization server sets up itself; nobody manages resources.";
const NO_OPENID = "Tiehall offers the three OAuth scopes and no OpenID Connect sign-in, so no client reads user information or ends a session through it.";

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
  // The install's authorization server for agent clients (authorization-server.ts).
  "GET /oauth2/authorize": {
    kind: "harmless",
    why: "The authorization endpoint an agent client sends a person's browser to: it signs the person in and asks them to approve the client, and gives a code only for an approval they confirmed, to a web session the install's pages take.",
  },
  "POST /oauth2/authorize": { kind: "blocked", why: "Agent clients send the person's browser to the authorization endpoint with a GET; the form-post variant is not used." },
  "POST /oauth2/token": {
    kind: "harmless",
    why: "The token endpoint, where an agent client exchanges an authorization code or a refresh token, with PKCE, for access tokens.",
  },
  "POST /oauth2/register": {
    kind: "harmless",
    why: "Dynamic Client Registration, which stays on for agent clients: a registered client is unverified and gets nothing until a person approves it.",
  },
  "POST /oauth2/revoke": { kind: "harmless", why: "Token revocation (RFC 7009), with which an agent client gives up a token it holds; it only takes access away." },
  "GET /jwks": { kind: "harmless", why: "The public keys that sign the install's access tokens; the private keys never leave the database." },
  "POST /oauth2/consent": { kind: "blocked", why: GRANTS },
  "POST /oauth2/continue": { kind: "blocked", why: "Tiehall uses no account selection or post-login step in the authorization flow." },
  "GET /oauth2/get-consent": { kind: "blocked", why: GRANTS },
  "GET /oauth2/get-consents": { kind: "blocked", why: GRANTS },
  "POST /oauth2/update-consent": { kind: "blocked", why: GRANTS },
  "POST /oauth2/delete-consent": { kind: "blocked", why: GRANTS },
  "GET /oauth2/get-client": { kind: "blocked", why: CLIENTS },
  "GET /oauth2/get-clients": { kind: "blocked", why: CLIENTS },
  "GET /oauth2/public-client": { kind: "blocked", why: "The consent screen shows who is asking in Tiehall's own words; no page reads a client over HTTP." },
  "POST /oauth2/public-client-prelogin": { kind: "blocked", why: "The consent screen shows who is asking in Tiehall's own words; no page reads a client over HTTP." },
  "POST /oauth2/create-client": { kind: "blocked", why: CLIENTS },
  "POST /oauth2/update-client": { kind: "blocked", why: CLIENTS },
  "POST /oauth2/delete-client": { kind: "blocked", why: CLIENTS },
  "POST /oauth2/client/rotate-secret": { kind: "blocked", why: CLIENTS },
  "POST /oauth2/client/rotate-keys": { kind: "blocked", why: CLIENTS },
  "POST /admin/oauth2/create-client": { kind: "blocked", why: CLIENTS },
  "PATCH /admin/oauth2/update-client": { kind: "blocked", why: CLIENTS },
  "GET /admin/oauth2/resources": { kind: "blocked", why: RESOURCES },
  "POST /admin/oauth2/resources": { kind: "blocked", why: RESOURCES },
  "GET /admin/oauth2/resources/:identifier": { kind: "blocked", why: RESOURCES },
  "PATCH /admin/oauth2/resources/:identifier": { kind: "blocked", why: RESOURCES },
  "DELETE /admin/oauth2/resources/:identifier": { kind: "blocked", why: RESOURCES },
  "POST /admin/oauth2/resources/:identifier/clients/:client_id": { kind: "blocked", why: RESOURCES },
  "DELETE /admin/oauth2/resources/:identifier/clients/:client_id": { kind: "blocked", why: RESOURCES },
  "POST /oauth2/introspect": { kind: "blocked", why: "The install checks its own access tokens in the same process; no resource server introspects them." },
  "GET /oauth2/userinfo": { kind: "blocked", why: NO_OPENID },
  "POST /oauth2/userinfo": { kind: "blocked", why: NO_OPENID },
  "GET /oauth2/end-session": { kind: "blocked", why: NO_OPENID },
  "POST /oauth2/end-session": { kind: "blocked", why: NO_OPENID },
  "POST /oauth2/end-session/confirm": { kind: "blocked", why: NO_OPENID },
  "GET /.well-known/oauth-authorization-server": {
    kind: "blocked",
    why: "The authorization server metadata is served at the install's own /.well-known/oauth-authorization-server, not under /api/auth.",
  },
  "GET /.well-known/openid-configuration": { kind: "blocked", why: NO_OPENID },
  "GET /token": { kind: "blocked", why: "The signing keys sign agents' access tokens only; a web session gets no JWT." },
  // The CLI's device flow (device-flow.ts).
  "POST /device/code": {
    kind: "harmless",
    why: "The device authorization endpoint, which serves the tiehall CLI alone: its guard refuses every other client id with unauthorized_client, and a code grants nothing until a member approves it on the device approval page with the confirmation step.",
  },
  "POST /device/token": {
    kind: "blocked",
    why: "The library's own device token endpoint would hand the CLI a web session's token; the CLI exchanges its code at the OAuth token endpoint for an access token for the MCP resource instead.",
  },
  "GET /device": {
    kind: "blocked",
    why: "It would bind a device code to whoever opens it signed in, before they approved it; Tiehall's device approval page reads a typed code and stores nothing until the approval is confirmed.",
  },
  "POST /device/approve": {
    kind: "blocked",
    why: "A member approves a device code on Tiehall's device approval page with the confirmation step; this route would let a same-origin request approve one with the cookie alone.",
  },
  "POST /device/deny": {
    kind: "blocked",
    why: "A device code nobody approves expires after 10 minutes; nothing needs a denial over HTTP.",
  },
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

/**
 * Whether the route guard serves a request to this path under /api/auth over
 * HTTP, judged from its method and path alone, before the service reads the
 * request: a harmless route, with its parameters' one value each. The service
 * answers every other path with 404 at once, so no part of a blocked route runs,
 * not even the check of its body's media type.
 */
export function servedOverHttpAt(method: string, path: string): boolean {
  for (const [route, entry] of Object.entries(SIGN_IN_ROUTES)) {
    if (entry.kind !== "harmless") continue;
    const [routeMethod = "", routePath = ""] = route.split(" ");
    if (routeMethod !== method.toUpperCase()) continue;
    const names: string[] = [];
    const pattern = routePath
      .split("/")
      .map((segment) => {
        if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        names.push(segment.slice(1));
        return "([^/]+)";
      })
      .join("/");
    const match = new RegExp(`^${pattern}$`).exec(path);
    if (match === null) continue;
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]));
    } catch {
      // A path segment that is not valid percent-encoding names nothing.
      continue;
    }
    if (servedOverHttp(routeMethod, routePath, params)) return true;
  }
  return false;
}

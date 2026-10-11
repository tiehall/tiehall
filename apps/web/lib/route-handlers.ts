// The paths the web app's route handlers serve, as their folders under app/
// name them (web-ui: The content security policy of each kind of page;
// design.md, Design: The content security policy of each kind of page; D57
// (9)). Next.js keeps a header the proxy set on its answer over the one a
// route handler gives it (send-response.js appends a header only when it is
// not set yet), so the proxy puts the framework pages' policy on the answer
// only where no route handler answers, and every route handler's answer keeps
// the policy it gives itself. test/route-handlers.test.ts holds this list to
// the route files under app/.

/** Every route handler's path, with its dynamic segments as Next.js writes them, and /favicon.ico, which next.config.ts rewrites to the asset route. */
export const ROUTE_HANDLERS = [
  "/",
  "/.well-known/[...path]",
  "/admin",
  "/admin/activity-log",
  "/admin/apis",
  "/admin/github",
  "/admin/invites",
  "/admin/personal-access-tokens",
  "/admin/sign-in-policy",
  "/admin/teams",
  "/api/auth/[...all]",
  "/api/v1/[...path]",
  "/assets/[...path]",
  "/confirm/[...command]",
  "/consent",
  "/device",
  "/docs/api",
  "/docs/api/changelog",
  "/docs/api/reference.js",
  "/docs/api/scalar.js",
  "/favicon.ico",
  "/hall",
  "/hall/state",
  "/hall/wait",
  "/healthz",
  "/inbox",
  "/mcp",
  "/members",
  "/mirrors/retry",
  "/requests",
  "/requests/new",
  "/schemas/packet/v1-beta.json",
  "/settings/email",
  "/setup/[[...step]]",
  "/sign-in",
  "/sign-out",
  "/teams/apis",
  "/tokens",
  "/webhooks/github",
] as const;

/** Each route handler's path as a pattern: a catch-all takes one or more segments, an optional one none or more. */
const PATTERNS: readonly RegExp[] = ROUTE_HANDLERS.map((route) => {
  const source = route
    .split("/")
    .slice(1)
    .map((segment) => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return "(?:/[^/]+)*";
      if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return "(?:/[^/]+)+";
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    })
    .join("");
  return new RegExp(`^${source === "/" ? "/" : source}$`);
});

/** Whether a route handler of the web app answers this path, which then gives its answer its own policy. */
export function servedByRouteHandler(pathname: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(pathname));
}

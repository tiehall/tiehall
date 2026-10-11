import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTE_HANDLERS, servedByRouteHandler } from "../lib/route-handlers.ts";

// The paths the web app's route handlers serve, which the proxy puts no policy
// on (web-ui: The content security policy of each kind of page; design.md,
// Design: The content security policy of each kind of page; D57 (9)). Next.js
// keeps a header the proxy set on its answer over the one a route handler
// gives, so the proxy gives the framework pages' policy only to the answers no
// route handler makes: the page for a path no route serves, and the page shown
// when rendering one fails. The list is held to the route files under app/.

const APP = fileURLToPath(new URL("../app/", import.meta.url));

/** Every route handler's path, as its folder under app/ names it, such as /api/v1/[...path]. */
function routeFolders(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "route.ts") found.push(`/${relative(APP, dir).split(sep).join("/")}`.replace(/\/$/, "") || "/");
    }
  };
  walk(APP);
  return found.sort();
}

describe("the paths of the web app's route handlers", () => {
  it("are every route file under app/, and /favicon.ico, which next.config.ts rewrites to the asset route", () => {
    expect([...ROUTE_HANDLERS].sort()).toEqual([...routeFolders(), "/favicon.ico"].sort());
  });

  it.each([
    ["/", true],
    ["/inbox", true],
    ["/admin/activity-log", true],
    ["/api/v1/requests/FE-1", true],
    ["/api/auth/callback/github", true],
    ["/confirm/members.change_role", true],
    ["/setup", true],
    ["/setup/github/app", true],
    ["/assets/tiehall.css", true],
    ["/favicon.ico", true],
    ["/.well-known/oauth-protected-resource", true],
    ["/docs/api", true],
    ["/docs/api/changelog", true],
    ["/hall", true],
    ["/hall/state", true],
    ["/hall/wait", true],
    ["/no-such-page", false],
    ["/no-such-page/at-all", false],
    ["/admin/xyz", false],
    ["/api", false],
    ["/assets", false],
    ["/FE-1", false],
    ["/FE", false],
    ["/inbox/", false],
  ])("%s is served by a route handler: %s", (path, served) => {
    expect(servedByRouteHandler(path)).toBe(served);
  });
});

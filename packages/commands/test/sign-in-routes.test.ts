import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { routeInventory, SIGN_IN_ROUTES, unclassifiedRoutes } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// The route inventory of the sign-in service (agent-safety: The confirmation
// step runs only in the web UI; design.md, Technical decisions: T8). An agent
// that drives a browser could call the sign-in service's own routes with
// same-origin requests and a session cookie alone, so a guard before every
// route serves over HTTP only the routes a committed classification marks as
// harmless, or gated by the confirmation step, and answers every other one,
// blocked, with 404. This test lists every route of the service as it is built
// and fails on any route the classification does not mark, so a new route,
// from an upgrade of the library or a plugin, is classified before it ships.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  harness = await startSignIn(install, stub);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

describe("the route inventory", () => {
  it("finds every route of the sign-in service classified, and no classification without its route", async () => {
    const routes = await harness.service.routes();
    expect(routes.length).toBeGreaterThan(20);
    expect(routes).toContain("GET /callback/:id");
    expect(routes).toContain("POST /sign-in/email");
    expect(unclassifiedRoutes(routes)).toEqual([]);
    expect(Object.keys(SIGN_IN_ROUTES).sort()).toEqual([...routes].sort());
  });

  it("fails on a route that nobody classified, such as one a plugin adds", () => {
    const fixture = {
      id: "tiehall-fixture",
      endpoints: {
        unclassified: createAuthEndpoint("/tiehall-fixture/unclassified", { method: "POST" }, async (context) => context.json({ ok: true })),
      },
    };
    const auth = betterAuth({ baseURL: URL_OF_INSTALL, secret: "a fixture secret that is at least thirty-two characters long", plugins: [fixture] });
    expect(unclassifiedRoutes(routeInventory(auth.api))).toEqual(["POST /tiehall-fixture/unclassified"]);
  });

  it("lists each method of a route that takes several on its own", () => {
    const auth = betterAuth({ baseURL: URL_OF_INSTALL, secret: "a fixture secret that is at least thirty-two characters long" });
    const routes = routeInventory(auth.api);
    expect(routes).toContain("GET /get-session");
    expect(routes).toContain("POST /get-session");
  });

  it("serves only the routes it marks as harmless, GitHub's return and the agent clients' OAuth flow, and gates none yet", () => {
    const served = Object.entries(SIGN_IN_ROUTES).filter(([, route]) => route.kind !== "blocked");
    expect(served.map(([route, { kind }]) => `${kind} ${route}`)).toEqual([
      "harmless GET /callback/:id",
      "harmless GET /oauth2/authorize",
      "harmless POST /oauth2/token",
      "harmless POST /oauth2/register",
      "harmless POST /oauth2/revoke",
      "harmless GET /jwks",
    ]);
    for (const route of Object.values(SIGN_IN_ROUTES)) expect(route.why.length).toBeGreaterThan(20);
  });
});

describe("a blocked route", () => {
  const blocked = Object.entries(SIGN_IN_ROUTES).filter(([, route]) => route.kind === "blocked");

  it.each(blocked.map(([route]) => route))("%s answers 404 over HTTP, sets no cookie and creates no session", async (route) => {
    const [method = "GET", path = ""] = route.split(" ");
    const sessions = Number((await install.owner.query("SELECT count(*) FROM web_sessions")).rows[0].count);
    const url = `${URL_OF_INSTALL}/api/auth${path.replace(/:[a-z]+/gi, "github")}`;
    const response = await harness.service.handler(
      new Request(url, {
        method,
        headers: { origin: URL_OF_INSTALL, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ provider: "github", callbackURL: "/", email: "ana@acme.example", password: "correct horse battery" }) }),
      }),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { type: string }).type).toBe("https://tiehall.com/problems/route-not-found");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(Number((await install.owner.query("SELECT count(*) FROM web_sessions")).rows[0].count)).toBe(sessions);
  });
});

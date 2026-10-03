import { readFileSync } from "node:fs";
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

  it("serves only the routes it marks as harmless, GitHub's return, the agent clients' OAuth flow and the CLI's device authorization, and gates none yet", () => {
    const served = Object.entries(SIGN_IN_ROUTES).filter(([, route]) => route.kind !== "blocked");
    expect(served.map(([route, { kind }]) => `${kind} ${route}`)).toEqual([
      "harmless GET /callback/:id",
      "harmless GET /oauth2/authorize",
      "harmless POST /oauth2/token",
      "harmless POST /oauth2/register",
      "harmless POST /oauth2/revoke",
      "harmless GET /jwks",
      "harmless POST /device/code",
    ]);
    for (const route of Object.values(SIGN_IN_ROUTES)) expect(route.why.length).toBeGreaterThan(20);
  });
});

// The sign-in library turns its origin and CSRF checks off by itself when NODE_ENV is test or TEST is set, as Vitest
// sets them, so the service sets both checks on explicitly: the tests then run the checks production runs.
describe("the sign-in service's origin check, in tests as in production", () => {
  const registration = (headers: Record<string, string>) =>
    harness.service.handler(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ client_name: "An agent", redirect_uris: ["http://127.0.0.1:43123/callback"], token_endpoint_auth_method: "none", application_type: "native" }),
      }),
    );

  it("runs although the test runner sets NODE_ENV to test", () => {
    expect(process.env["NODE_ENV"]).toBe("test");
  });

  it("refuses a POST that carries a cookie from another origin with 403, and serves the same POST from the install's own origin", async () => {
    const refused = await registration({ cookie: "tiehall.session_token=whatever", origin: "https://evil.example" });
    expect(refused.status).toBe(403);
    const { rows } = await install.owner.query("SELECT count(*)::int AS count FROM oauth_clients WHERE name = 'An agent'");
    expect(rows[0].count).toBe(0);

    expect((await registration({ cookie: "tiehall.session_token=whatever", origin: URL_OF_INSTALL })).status).toBe(201);
    expect((await registration({})).status).toBe(201);
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

// The route inventory, re-run against the pinned sign-in library with every
// plugin in use (agent-safety: The confirmation step runs only in the web UI;
// design.md, Technical decisions: T7 and T8). The inventory above lists the
// routes of the service as the usual sign-in builds it. The service builds
// three instances in all: the usual one, whose authorization server
// identifies agent clients by their metadata documents unless
// TIEHALL_CLIENT_METADATA_FETCH switches that off, and the one that completes
// setup; every one of them is served under /api/auth behind the same guard.
// So the inventory covers the routes of all three, and each plugin any of them
// uses is a plugin of the usual instance, whose routes the inventory lists;
// and it runs on the library and plugins the commands package pins exactly,
// as installed and as the lockfile resolves them, so an upgrade changes the
// inventory only through a reviewed change of the pin.

/** The sign-in library and the plugins of it that Tiehall uses (design.md, Technical decisions: T7). */
const SIGN_IN_PACKAGES = ["better-auth", "@better-auth/mcp", "@better-auth/cimd", "@better-auth/oauth-provider"];

describe("the route inventory, against the pinned sign-in library with every plugin in use", () => {
  it("runs on the sign-in library and its plugins pinned exactly, as installed and as the lockfile resolves them", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    const lockfile = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
    const importer = lockfile.slice(lockfile.indexOf("\n  packages/commands:\n"), lockfile.indexOf("\n  packages/core:\n"));
    for (const name of SIGN_IN_PACKAGES) {
      const pinned = manifest.dependencies[name] ?? "";
      expect(pinned, name).toMatch(/^\d+\.\d+\.\d+$/);
      const installed = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")) as { version: string };
      expect(installed.version, name).toBe(pinned);
      const key = name.startsWith("@") ? `'${name}'` : name;
      expect(importer, name).toContain(`\n      ${key}:\n        specifier: ${pinned}\n        version: ${pinned}(`);
    }
  });

  it("finds every route of every instance the service builds classified: sign-in with metadata documents on and off, and setup", async () => {
    const withoutDocuments = await startSignIn(install, stub, { sameAppAs: harness, agentClients: { metadataDocuments: false } });
    const inventories = {
      "sign-in": await harness.service.routes("sign-in"),
      "sign-in without metadata documents": await withoutDocuments.service.routes(),
      setup: await harness.service.routes("setup"),
    };
    for (const [instance, routes] of Object.entries(inventories)) {
      expect(routes.length, instance).toBeGreaterThan(20);
      expect(unclassifiedRoutes(routes), instance).toEqual([]);
    }
    const all = [...new Set(Object.values(inventories).flat())].sort();
    expect(Object.keys(SIGN_IN_ROUTES).sort()).toEqual(all);
    // The usual instance's routes hold every other instance's, so the inventory above sees every route.
    expect(all).toEqual(inventories["sign-in"]);
  });

  it("builds the usual instance, whose routes the inventory lists, with every plugin any instance uses", async () => {
    const withoutDocuments = await startSignIn(install, stub, { sameAppAs: harness, agentClients: { metadataDocuments: false } });
    const usual = await harness.service.plugins("sign-in");
    const inUse = [...new Set([...usual, ...(await harness.service.plugins("setup")), ...(await withoutDocuments.service.plugins())])].sort();
    expect(usual).toEqual(inUse);
    // The plugins of design.md, T7, by the ids they register: jwt(), mcp() as "oauth-provider", cimd() and
    // oauthDeviceAuthorization() as "device-authorization"; and Tiehall's own.
    expect(inUse).toEqual(
      [
        "jwt",
        "oauth-provider",
        "cimd",
        "device-authorization",
        "tiehall-github-endpoints",
        "tiehall-offered-scopes",
        "tiehall-pkce-refusals",
        "tiehall-client-registrations",
        "tiehall-cli-device-flow",
        "tiehall-grant-checks",
      ].sort(),
    );
  });
});

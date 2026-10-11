import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { GitHubStub } from "@tiehall/testing/github";
import type { TestInstall } from "./install.ts";
import { addUser } from "./members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./requests.ts";

// The inventory of the web app's routes (web-ui: The content security policy
// of each kind of page; self-host-install: No telemetry and a documented list
// of outbound connections; design.md, Design: Testing; D57 (9)): every route
// file under apps/web/app, named as a page of the web UI with the paths that
// show it, or as no page, with why. The browser tests that visit every page,
// such as web-ui-hosts-browser.test.ts, and the table test of each page's
// policy, page-policies.test.ts, share it, so a route that is neither fails
// them and a new page is visited once it is added. It lives here rather than
// in a test file, since importing a test file would register its suites and
// run its hooks. seedInventory() gives an install the teams, people, request,
// proposal and token the paths below show.

/** The web app's routes, apps/web/app. */
export const APP = fileURLToPath(new URL("../../../../apps/web/app/", import.meta.url));

/** The pages of the web UI, by their route file under apps/web/app, and the paths a signed-in admin opens to see them. */
export const PAGES: Readonly<Record<string, readonly string[]>> = {
  "route.ts": ["/"],
  "inbox/route.ts": ["/inbox"],
  "settings/email/route.ts": ["/settings/email"],
  "members/route.ts": ["/members"],
  "requests/route.ts": ["/requests", "/requests?list=opened", "/requests?list=all"],
  "requests/new/route.ts": ["/requests/new", "/requests/new?team=FE"],
  "[key]/page.tsx": ["/FE-1", "/FE", "/QA"],
  "tokens/route.ts": ["/tokens"],
  "admin/route.ts": ["/admin"],
  "admin/invites/route.ts": ["/admin/invites"],
  "admin/teams/route.ts": ["/admin/teams"],
  "admin/sign-in-policy/route.ts": ["/admin/sign-in-policy"],
  "admin/personal-access-tokens/route.ts": ["/admin/personal-access-tokens"],
  "admin/github/route.ts": ["/admin/github"],
  "admin/apis/route.ts": ["/admin/apis"],
  "admin/activity-log/route.ts": ["/admin/activity-log"],
  // A proposal's confirm page and an admin action's review page; seedInventory() gives their paths.
  "confirm/[...command]/route.ts": [],
  // Reached from an agent client's authorization request, which the admin's browser starts once the client has
  // registered; without one, it answers with a page that says so.
  "consent/route.ts": ["/consent"],
  // Where a member types the code `tiehall login` printed; the test also types a code and opens its review.
  "device/route.ts": ["/device"],
  "docs/api/route.ts": ["/docs/api"],
  "docs/api/changelog/route.ts": ["/docs/api/changelog"],
};

/** The pages a browser signed in as nobody opens. */
export const SIGNED_OUT_PAGES: Readonly<Record<string, readonly string[]>> = {
  "sign-in/route.ts": ["/sign-in"],
};

/** The setup screen, which only an install whose setup is not complete serves; its steps are visited in order. */
export const SETUP = "setup/[[...step]]/route.ts";

/** The routes that are no page of the web UI, and why. */
export const NOT_PAGES: Readonly<Record<string, string>> = {
  ".well-known/[...path]/route.ts": "discovery documents for agent clients",
  "api/auth/[...all]/route.ts": "the sign-in service's routes, which GitHub's pages lead back to",
  "api/v1/[...path]/route.ts": "the REST API",
  "mcp/route.ts": "the MCP endpoint",
  "webhooks/github/route.ts": "GitHub's webhook deliveries",
  "schemas/packet/v1-beta.json/route.ts": "the packet schema, a JSON document",
  "healthz/route.ts": "the health check",
  "sign-out/route.ts": "the sign-out form's target, which only answers its post",
  "teams/apis/route.ts": "the target of the forms of a team's page, which only answers their posts",
  "mirrors/retry/route.ts": "the target of a failed mirror job's Retry button, which only answers its post",
  "docs/api/reference.js/route.ts": "a script of the API reference page, which that page loads",
  "docs/api/scalar.js/route.ts": "a script of the API reference page, which that page loads",
  "assets/[...path]/route.ts": "the install's own assets, such as its stylesheet, fonts and icons, which the pages load",
};

/** A path no route serves, which gets the web app's own page that says so. */
export const NO_SUCH_PAGE = "/no-such-page";

/** Every route file of the web app: its route handlers and its pages. */
export function routeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "route.ts" || entry.name === "page.tsx") found.push(relative(APP, path).split(sep).join("/"));
    }
  };
  walk(APP);
  return found.sort();
}

/** Every route file the inventory names, as a page, a signed-out page, the setup screen or no page. */
export function namedRoutes(): string[] {
  return [...Object.keys(PAGES), ...Object.keys(SIGNED_OUT_PAGES), SETUP, ...Object.keys(NOT_PAGES)].sort();
}

/** What seedInventory() made: the people's ids and the paths of the confirm pages. */
export interface InventorySeed {
  /** Pia, an admin and a member of FE. */
  pia: string;
  /** Alice, a member of BE, who opened FE-1. */
  alice: string;
  /** The confirm page of Pia's proposal to decline FE-1, and the review page of making Alice an admin. */
  confirmPaths: string[];
}

/**
 * Gives an install what the inventory's paths show: the teams BE, FE, whose
 * intake notes and required fields the new request form shows, and QA; Pia,
 * an admin in FE, and Alice, a member in BE, both GitHub users of the stub;
 * FE-1, which Alice opened with a packet whose need is a remote image and a
 * comment that holds markup; Pia's proposal to decline it; and a personal
 * access token of Pia's, which the tokens page lists.
 */
export async function seedInventory(install: TestInstall, stub: GitHubStub): Promise<InventorySeed> {
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  await addTeam(install.owner, "QA");
  await install.owner.query("UPDATE teams SET intake_notes = 'One request per screen.', required_fields = ARRAY['acceptance_criteria'] WHERE key = 'FE'");
  const pia = await addUser(install.owner, { login: "pia", role: "admin", githubAccountId: stub.addUser({ login: "pia" }).id });
  const alice = await addUser(install.owner, { login: "alice", githubAccountId: stub.addUser({ login: "alice" }).id });
  await joinTeams(install.owner, pia, fe);
  await joinTeams(install.owner, alice, be);
  await openRequest(install, tokenOf(alice), {
    targetTeam: "FE",
    title: "Add a dark mode",
    packet: {
      schema_version: "1-beta",
      kind: "request",
      untrusted: { need: "![x](https://tracker.example/pixel.png)", acceptance_criteria: ["It follows the system setting."], links: [{ url: "https://design.example.com/dark" }] },
    },
  });
  expect((await callApi(install, tokenOf(alice), "POST", "/api/v1/requests/FE-1/messages", { kind: "comment", body: "<img src=https://tracker.example/pixel.png>" })).status).toBe(200);
  const declined = await callApi(install, tokenOf(pia), "POST", "/api/v1/requests/FE-1/status", { state: "declined" });
  expect(declined.status).toBe(202);
  const confirmPaths = [
    `/confirm/${declined.body.proposal.id}`,
    `/confirm/members.change_role?input=${encodeURIComponent(JSON.stringify({ userId: alice, role: "admin" }))}`,
  ];
  // A personal access token, which the tokens page lists.
  expect((await install.confirm(sessionOf(pia), "personal_access_tokens.create", { name: "Agent", scopes: ["requests:read"], expiresInDays: 30 })).status).toBe(200);
  return { pia, alice, confirmPaths };
}

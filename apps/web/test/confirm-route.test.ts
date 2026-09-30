/// <reference types="vitest/importMeta" />
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_PATH,
  CONFIRM_ROUTE_PATHS,
  GITHUB_ADMIN_PATH,
  INVITES_PATH,
  MANIFEST_REDIRECT_PATH,
  MEMBERS_PATH,
  PACKET_SCHEMA_PATH,
  COMPANY_PATH,
  SETUP_PATH,
  SETUP_SIGN_IN_CALLBACK_PATH,
  SETUP_SIGN_IN_PATH,
  SIGN_IN_CALLBACK_PATH,
  SIGN_IN_PATH,
  SIGN_IN_POLICY_PATH,
  SIGN_OUT_PATH,
  TEAMS_PATH,
  WEBHOOKS_GITHUB_PATH,
} from "@tiehall/commands";
import { GET } from "../app/confirm/[...command]/route.ts";

// The review pages of the confirmation step (agent-safety: The review page of
// the confirmation step; requests: The proposal's confirm page; requests: The
// undo window for reversible commitments). The app mounts the one confirm route
// on every path it serves, the undo page's two segments under /confirm
// included, so the link a receipt emails reaches the page and not the app's
// 404. A browser without a session cookie is sent to sign in first, with
// nothing of the page, and even that answer cannot be framed.
// packages/commands/test/review-page.test.ts tests the pages themselves
// against a database.

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Every route handler under app/, by its path from app/, with a loader for its
 * module; a glob skips a folder whose name starts with a dot unless it names
 * it, so /.well-known is named.
 */
const routeFiles = import.meta.glob(["../app/**/route.ts", "../app/.well-known/**/route.ts"]);

/**
 * Whether Next.js routes a URL with these segments to the route file whose
 * folders these are: a folder [x] takes one segment, [...x] one or more,
 * [[...x]] any number, and any other folder its own name.
 */
function mounts(folders: readonly string[], segments: readonly string[]): boolean {
  const [folder, ...rest] = folders;
  if (folder === undefined) return segments.length === 0;
  if (folder.startsWith("[[...")) return rest.length === 0;
  if (folder.startsWith("[...")) return rest.length === 0 && segments.length > 0;
  if (folder.startsWith("[")) return segments.length > 0 && mounts(rest, segments.slice(1));
  return segments[0] === folder && mounts(rest, segments.slice(1));
}

/** The route files a URL path reaches. */
function routesOf(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment !== "");
  return Object.keys(routeFiles).filter((file) => {
    const folders = file.replace(/^\.\.\/app\//, "").replace(/\/route\.ts$/, "").split("/");
    return mounts(folders, segments);
  });
}

describe("the app", () => {
  it("has route files under app/", () => {
    expect(Object.keys(routeFiles)).toContain("../app/healthz/route.ts");
  });

  it.each(CONFIRM_ROUTE_PATHS)("mounts the confirm route on %s, for a GET and a POST", async (pattern) => {
    // A braced part stands for one segment, such as a command id or a proposal id.
    const path = pattern.replaceAll(/\{[a-z]+\}/g, "x");
    const files = routesOf(path);
    expect(files, `the route files ${path} reaches`).toHaveLength(1);
    const [file] = files;
    const module = (await routeFiles[file ?? ""]?.()) as Record<string, unknown> | undefined;
    expect(module?.["GET"], `${file} exports GET`).toBeTypeOf("function");
    expect(module?.["POST"], `${file} exports POST`).toBeTypeOf("function");
  });

  it("does not mount the confirm route on /confirm itself, which names no page", () => {
    expect(routesOf("/confirm")).toEqual([]);
  });

  // The other pages the commands package serves at a fixed path: the admin
  // view of the activity log (activity-log: The admin view) and the packet
  // schema (handoff-packet: The beta label). A page that
  // no route file mounts answers with the app's 404, whatever its handler does.
  // The web UI's sign-out form (sign-in: Signing out and ending sessions), which only posts.
  // The GitHub page of the admin UI (tracker-mirrors: Admins connect GitHub
  // installations with the confirmation step), whose form posts a disconnect.
  it("mounts the GitHub admin page on its path, for a GET and a POST", async () => {
    const files = routesOf(GITHUB_ADMIN_PATH);
    expect(files, `the route files ${GITHUB_ADMIN_PATH} reaches`).toHaveLength(1);
    const module = (await routeFiles[files[0] ?? ""]?.()) as Record<string, unknown> | undefined;
    expect(module?.["GET"]).toBeTypeOf("function");
    expect(module?.["POST"]).toBeTypeOf("function");
  });

  // The members page, which every member opens and whose forms set and clear
  // the bot flag, and the admin UI's invites and teams pages, whose forms
  // revoke invites and change teams (teams-and-roles: What admins and members
  // may do).
  it.each([MEMBERS_PATH, INVITES_PATH, TEAMS_PATH])("mounts its page on %s, for a GET and a POST", async (path) => {
    const files = routesOf(path);
    expect(files, `the route files ${path} reaches`).toHaveLength(1);
    const module = (await routeFiles[files[0] ?? ""]?.()) as Record<string, unknown> | undefined;
    expect(module?.["GET"]).toBeTypeOf("function");
    expect(module?.["POST"]).toBeTypeOf("function");
  });

  it("mounts the sign-out on its path, for a POST", async () => {
    const files = routesOf(SIGN_OUT_PATH);
    expect(files, `the route files ${SIGN_OUT_PATH} reaches`).toHaveLength(1);
    const module = (await routeFiles[files[0] ?? ""]?.()) as Record<string, unknown> | undefined;
    expect(module?.["POST"]).toBeTypeOf("function");
  });

  // The discovery documents of the install's authorization server for agent
  // clients (agent-access: Tiehall is the authorization server for agent
  // clients), which clients fetch at the install's own /.well-known paths.
  it.each([
    { name: "the activity log's admin page", path: ACTIVITY_LOG_PATH },
    { name: "the packet schema", path: PACKET_SCHEMA_PATH },
    { name: "the sign-in policy's admin page", path: SIGN_IN_POLICY_PATH },
    { name: "the protected resource metadata of the MCP resource", path: "/.well-known/oauth-protected-resource/mcp" },
    { name: "the protected resource metadata at the root", path: "/.well-known/oauth-protected-resource" },
    { name: "the authorization server metadata", path: "/.well-known/oauth-authorization-server" },
    { name: "the consent screen", path: "/consent" },
  ])("mounts $name on $path, for a GET", async ({ path }) => {
    const files = routesOf(path);
    expect(files, `the route files ${path} reaches`).toHaveLength(1);
    const [file] = files;
    const module = (await routeFiles[file ?? ""]?.()) as Record<string, unknown> | undefined;
    expect(module?.["GET"], `${file} exports GET`).toBeTypeOf("function");
  });

  // The setup screen, the page GitHub sends the operator back to from the
  // manifest flow (self-host-install: The GitHub App is created with GitHub's
  // manifest flow), the company's name and the sign-in that completes setup,
  // with GitHub's return to it (self-host-install: Setup names the company and
  // makes the first admin): one route reads the path, so all of them reach it.
  // Where GitHub delivers the App's webhooks (tracker-mirrors: GitHub webhooks
  // are verified, deduplicated and processed in the background).
  // The sign-in page, and the sign-in service's routes, among them GitHub's
  // return to the sign-in callback (sign-in: GitHub is the only way to sign in),
  // whose own guard answers every other route under /api/auth with 404.
  it.each([SETUP_PATH, MANIFEST_REDIRECT_PATH, COMPANY_PATH, SETUP_SIGN_IN_PATH, SETUP_SIGN_IN_CALLBACK_PATH, WEBHOOKS_GITHUB_PATH, SIGN_IN_PATH, SIGN_IN_CALLBACK_PATH, "/api/auth/sign-in/email"])("mounts its route on %s, for a GET and a POST", async (path) => {
    const files = routesOf(path);
    expect(files, `the route files ${path} reaches`).toHaveLength(1);
    const [file] = files;
    const module = (await routeFiles[file ?? ""]?.()) as Record<string, unknown> | undefined;
    expect(module?.["GET"], `${file} exports GET`).toBeTypeOf("function");
    expect(module?.["POST"], `${file} exports POST`).toBeTypeOf("function");
  });
});

describe("a review page", () => {
  it("sends a browser without a signed-in user to sign in first, with a Content-Security-Policy that forbids framing", async () => {
    // Settings that name an app role and a password, never used: nothing reaches the database.
    vi.stubEnv("TIEHALL_URL", "https://tiehall.example.com");
    vi.stubEnv("TIEHALL_DATABASE_APP_URL", "postgres://tiehall_app@127.0.0.1:1/tiehall");
    vi.stubEnv("TIEHALL_DATABASE_APP_PASSWORD", "unused");
    const input = encodeURIComponent(JSON.stringify({ scope: "requests:read" }));
    const response = await GET(new Request(`https://tiehall.example.com/confirm/tokens.create?input=${input}`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(`/confirm/tokens.create?input=${input}`)}`);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

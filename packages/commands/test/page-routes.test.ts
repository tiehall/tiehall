import { describe, expect, it } from "vitest";
import { wayOnOfPageRoute } from "../src/index.ts";

// The page routes, for an answer given before any route sees the call, such as
// the web role's request guard's 413 and 503 (public-api: One error model for
// Tiehall's own refusals; github-layer-hardening: design.md, Decisions this
// change rests on: D50 (7); Technical decisions: T5). The routes that serve
// the web UI's pages, the setup screen, the review pages and confirmations
// under /confirm/… and GitHub's return to either sign-in callback answer a
// browser's refusal with a page, whose link leads on as their own refusals
// do: to the page that was asked for, back to the page whose form was refused,
// to the sign-in page for the sign-in, and back to the setup screen for the
// setup screen and its sign-in. Every call to /api (GitHub's return to the
// sign-in callback aside), /mcp, /.well-known, /webhooks, /schemas and
// /healthz is no page route, and always gets the problem.

describe("the page routes, as an answer before any route knows them", () => {
  it.each([
    ["GET", "/", "/"],
    ["GET", "/members", "/members"],
    ["GET", "/admin/invites", "/admin/invites"],
    ["POST", "/admin/invites", "/admin/invites"],
    ["POST", "/admin/teams", "/admin/teams"],
    ["GET", "/admin/activity-log?type=member.removed", "/admin/activity-log?type=member.removed"],
    ["GET", "/confirm/members.change_role?input=%7B%7D", "/confirm/members.change_role?input=%7B%7D"],
    ["POST", "/confirm/members.change_role", "/confirm/members.change_role"],
    ["GET", "/docs/api", "/docs/api"],
    ["GET", "/setup", "/setup"],
    ["POST", "/setup/github", "/setup"],
    ["GET", "/setup/sign-in/callback/github?code=c&state=s", "/setup"],
    ["GET", "/sign-in", "/sign-in"],
    ["POST", "/sign-in", "/sign-in"],
    ["POST", "/sign-out", "/"],
    ["GET", "/api/auth/callback/github?code=c&state=s", "/sign-in"],
  ])("%s %s is a page route whose refusal leads on to %s", (method, target, href) => {
    expect(wayOnOfPageRoute(method, target)?.href).toBe(href);
  });

  it.each([
    ["GET", "/api/v1/requests"],
    ["POST", "/api/v1/requests"],
    ["GET", "/api/v1/openapi.json"],
    ["POST", "/api/auth/sign-in/social"],
    ["GET", "/api/auth/get-session"],
    ["POST", "/mcp"],
    ["GET", "/.well-known/oauth-authorization-server"],
    ["POST", "/webhooks/github"],
    ["GET", "/schemas/packet/v1-beta.json"],
    ["GET", "/healthz"],
  ])("%s %s is no page route", (method, target) => {
    expect(wayOnOfPageRoute(method, target)).toBeUndefined();
  });

  // A review page's form posts to /confirm/<command> without the review page's query, which holds its input: the
  // page whose form was refused is the one the browser posted from, which its Referer names on the install.
  it("leads a refused form back to the page it was posted from, as its Referer names it, such as a review page with its input", () => {
    const review = "http://localhost:3000/confirm/members.change_role?input=%7B%22role%22%3A%22admin%22%7D";
    expect(wayOnOfPageRoute("POST", "/confirm/members.change_role", review)?.href).toBe("/confirm/members.change_role?input=%7B%22role%22%3A%22admin%22%7D");
    expect(wayOnOfPageRoute("POST", "/admin/invites", "http://localhost:3000/admin/invites")?.href).toBe("/admin/invites");
  });

  it("leads a refused form back to its own target when the page it names is no page route, or names none", () => {
    expect(wayOnOfPageRoute("POST", "/admin/invites", "http://localhost:3000/api/v1/requests")?.href).toBe("/admin/invites");
    expect(wayOnOfPageRoute("POST", "/admin/invites", "not a URL")?.href).toBe("/admin/invites");
    expect(wayOnOfPageRoute("POST", "/admin/invites", undefined)?.href).toBe("/admin/invites");
  });

  it("leads a refused page, which is asked for, not posted, to that page whatever page it was opened from", () => {
    expect(wayOnOfPageRoute("GET", "/members", "http://localhost:3000/admin/invites")?.href).toBe("/members");
  });

  it("never leads on to another host from the page a form was posted from", () => {
    for (const referrer of ["http://localhost:3000//evil.example/members", "http://localhost:3000/%2F%2Fevil.example"]) {
      const href = wayOnOfPageRoute("POST", "/admin/invites", referrer)?.href;
      expect(href, referrer).toMatch(/^\/(?![/\\])/);
      expect(new URL(href!, "https://tiehall.example.com").origin, referrer).toBe("https://tiehall.example.com");
    }
  });

  it("never leads on to another host, whatever path the call names", () => {
    for (const target of ["//evil.example/members", "/.//evil.example/members", "///evil.example", "/%2F%2Fevil.example"]) {
      const href = wayOnOfPageRoute("GET", target)?.href;
      expect(href, target).toMatch(/^\/(?![/\\])/);
      expect(new URL(href!, "https://tiehall.example.com").origin, target).toBe("https://tiehall.example.com");
    }
  });
});

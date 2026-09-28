import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAppManifest } from "../src/index.ts";

// The allowlist of the install's GitHub App (tracker-mirrors: The GitHub App
// asks for narrow permissions and every event up front; task 7.5 of
// add-tiehall-oss-v1, as task 1.2 of github-app-reachability changes it).
// CI fails when the manifest the setup screen posts asks for any permission
// beyond Metadata read, Pull requests read, Issues read and write,
// organization Members read and account Email addresses read; subscribes to
// any event beyond pull_request, issues and organization; lists either
// installation event, which every App receives without subscribing and GitHub
// refuses as a default event; or subscribes to events without a webhook,
// which GitHub refuses too. The allowlist is written out here, apart from the
// manifest builder's own table, so that widening the table fails this test.

const ALLOWED_PERMISSIONS: ReadonlyMap<string, "read" | "write"> = new Map([
  ["metadata", "read"],
  ["pull_requests", "read"],
  ["issues", "write"],
  ["members", "read"],
  ["emails", "read"],
]);
const ALLOWED_EVENTS: ReadonlySet<string> = new Set(["pull_request", "issues", "organization"]);
const INSTALLATION_EVENTS: ReadonlySet<string> = new Set(["installation", "installation_repositories"]);

/** What a manifest asks for beyond the allowlist, one line each; none for a manifest within it. */
function violations(manifest: Record<string, unknown>): string[] {
  const found: string[] = [];
  const permissions = (manifest["default_permissions"] ?? {}) as Record<string, unknown>;
  for (const [key, level] of Object.entries(permissions)) {
    const allowed = ALLOWED_PERMISSIONS.get(key);
    if (allowed === undefined || (level !== "read" && level !== "write") || (level === "write" && allowed === "read")) {
      found.push(`asks for the permission ${key}: ${String(level)}`);
    }
  }
  const events = Array.isArray(manifest["default_events"]) ? (manifest["default_events"] as unknown[]) : [];
  for (const event of events) {
    if (typeof event === "string" && INSTALLATION_EVENTS.has(event)) found.push(`lists ${event}, which every App receives without subscribing`);
    else if (typeof event !== "string" || !ALLOWED_EVENTS.has(event)) found.push(`subscribes to the event ${String(event)}`);
  }
  const hook = manifest["hook_attributes"] as { url?: unknown } | undefined;
  if (events.length > 0 && (typeof hook?.url !== "string" || hook.url === "")) found.push("subscribes to events without a webhook");
  return found;
}

const FIXTURES = new URL("./fixtures/github-manifests/", import.meta.url);

/** Each fixture adds one thing the allowlist refuses to the manifest of https://tiehall.example.com. */
const EXPECTED: Readonly<Record<string, string>> = {
  "adds-contents.json": "asks for the permission contents: read",
  "writes-members.json": "asks for the permission members: write",
  "adds-push-event.json": "subscribes to the event push",
  "lists-installation.json": "lists installation, which every App receives without subscribing",
  "lists-installation-repositories.json": "lists installation_repositories, which every App receives without subscribing",
  "events-without-hook.json": "subscribes to events without a webhook",
};

describe("the manifests the setup screen posts", () => {
  const cases = [
    { url: "http://localhost:3000", unreachable: false, kind: "a trial URL, without a webhook" },
    { url: "https://tiehall.example.com", unreachable: false, kind: "an HTTPS URL, with a webhook" },
    { url: "https://tiehall.example.com", unreachable: true, kind: "an HTTPS URL whose operator says GitHub cannot reach it" },
  ];
  for (const { url, unreachable, kind } of cases) {
    it(`stay within the allowlist for ${kind}`, () => {
      expect(violations({ ...buildAppManifest({ url, name: "Tiehall", unreachable }) })).toEqual([]);
    });
  }
});

describe("a manifest beyond the allowlist", () => {
  it("has one fixture for each way out of it", () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [file, expected] of Object.entries(EXPECTED)) {
    it(`fails: ${file}`, () => {
      const manifest = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as Record<string, unknown>;
      expect(violations(manifest)).toEqual([expected]);
    });
  }
});

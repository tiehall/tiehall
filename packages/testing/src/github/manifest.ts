// What GitHub's new-App page does with a posted App manifest
// (github-app-reachability: design.md, Technical decisions: T4). The words of
// every refusal the spike of task 1.6 met are GitHub's own, recorded on
// 2026-09-28 (test/fixtures/github-app-spike/answers-2026-09-28.json):
// - a hook URL on localhost, whether the hook is active or not;
// - `installation` and `installation_repositories` among the default events,
//   which every App receives without subscribing;
// - events without a hook URL.
// The other refusals below (a hook URL a test names as unreachable, an unknown
// permission, an App name that is taken or too long) were not recorded; their
// words follow the recorded ones where they can and GitHub's usual wording
// otherwise.

export type Permission = "read" | "write";

export interface ParsedManifest {
  name: string;
  url: string;
  description: string;
  hook: { url: string; active: boolean } | null;
  redirectUrl: string | null;
  callbackUrls: string[];
  setupUrl: string | null;
  public: boolean;
  permissions: Record<string, Permission>;
  events: string[];
}

export type ManifestCheck = { ok: true; manifest: ParsedManifest } | { ok: false; messages: string[] };

/** The events each permission lets an App subscribe to (a subset of GitHub's table). */
const EVENTS_BY_PERMISSION: Readonly<Record<string, readonly string[]>> = {
  metadata: ["label", "public", "repository", "star", "watch", "meta"],
  pull_requests: ["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"],
  issues: ["issues", "issue_comment", "milestone"],
  members: ["organization", "membership", "team", "member"],
  contents: ["push", "create", "delete", "release", "commit_comment", "fork", "gollum"],
  checks: ["check_run", "check_suite"],
  actions: ["workflow_run", "workflow_job", "workflow_dispatch"],
  statuses: ["status"],
  deployments: ["deployment", "deployment_status"],
  administration: ["branch_protection_rule", "repository_ruleset"],
};

/** Every event an App can subscribe to. `installation` and `installation_repositories` are not among them. */
const SUBSCRIBABLE_EVENTS = new Set(Object.values(EVENTS_BY_PERMISSION).flat());

/** The permission keys the stub knows; GitHub knows more. */
export const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set([
  ...Object.keys(EVENTS_BY_PERMISSION),
  "emails",
  "followers",
  "gpg_keys",
  "git_ssh_keys",
  "profile",
  "starring",
  "organization_administration",
  "organization_hooks",
  "organization_projects",
  "repository_projects",
  "pages",
  "secrets",
  "environments",
  "vulnerability_alerts",
  "workflows",
]);

/** Account permissions, which a user grants when authorizing the App, never an installation. */
export const ACCOUNT_PERMISSIONS: ReadonlySet<string> = new Set(["emails", "followers", "gpg_keys", "git_ssh_keys", "profile", "starring"]);

/** Organization permissions, which only an installation on an organization gets. */
export const ORGANIZATION_PERMISSIONS: ReadonlySet<string> = new Set([
  "members",
  "organization_administration",
  "organization_hooks",
  "organization_projects",
]);

/** GitHub App names are at most 34 characters. */
export const MAX_APP_NAME_LENGTH = 34;

/** GitHub's list of words: "a", "a and b", "a, b, and c". */
function sentence(words: readonly string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)!}`;
}

export interface ManifestRules {
  /** Why a hook URL is unreachable, such as "localhost", or undefined when GitHub takes it. */
  unreachable(url: URL): string | undefined;
}

/** Checks a manifest as GitHub's new-App page does, in the order GitHub lists its refusals. */
export function checkManifest(text: string, rules: ManifestRules): ManifestCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, messages: ["Manifest is not valid JSON"] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, messages: ["Manifest is not valid JSON"] };
  const input = raw as Record<string, unknown>;
  const messages: string[] = [];

  const name = typeof input["name"] === "string" ? input["name"].trim() : "";
  if (name === "") messages.push("Name can't be blank");
  const url = typeof input["url"] === "string" ? input["url"] : "";
  if (url === "") messages.push("Url can't be blank");

  const permissions: Record<string, Permission> = {};
  const unknownPermissions: string[] = [];
  const rawPermissions = input["default_permissions"];
  if (typeof rawPermissions === "object" && rawPermissions !== null) {
    for (const [key, level] of Object.entries(rawPermissions as Record<string, unknown>)) {
      if (KNOWN_PERMISSIONS.has(key) && (level === "read" || level === "write")) permissions[key] = level;
      else unknownPermissions.push(key);
    }
  }
  // Every App can read metadata.
  permissions["metadata"] ??= "read";

  let hook: ParsedManifest["hook"] = null;
  let hookInvalid = false;
  const rawHook = input["hook_attributes"];
  const hookUrl = typeof rawHook === "object" && rawHook !== null ? (rawHook as { url?: unknown }).url : undefined;
  if (typeof hookUrl === "string" && hookUrl !== "") {
    const parsed = parseUrl(hookUrl);
    const reason = parsed === undefined ? "invalid" : rules.unreachable(parsed);
    if (reason !== undefined) {
      messages.push(`Hook url is not supported because it isn't reachable over the public Internet (${reason})`, "Hook is invalid");
      hookInvalid = true;
    } else {
      hook = { url: hookUrl, active: (rawHook as { active?: unknown }).active !== false };
    }
  }

  const events = Array.isArray(input["default_events"]) ? input["default_events"].filter((event): event is string => typeof event === "string") : [];
  if (events.length > 0 && hook === null && !hookInvalid) messages.push("Hook url cannot be blank", "Hook is invalid");
  const unsupported = events.filter((event) => !SUBSCRIBABLE_EVENTS.has(event));
  if (unsupported.length > 0) messages.push(`Default events unsupported: ${sentence(unsupported)}`);
  const allowed = new Set(Object.keys(permissions).flatMap((permission) => EVENTS_BY_PERMISSION[permission] ?? []));
  const withoutPermission = events.filter((event) => !allowed.has(event));
  if (withoutPermission.length > 0) messages.push(`Default events are not supported by permissions: ${sentence(withoutPermission)}`);
  if (unknownPermissions.length > 0) messages.push("Default permission records resource is not included in the list");

  if (messages.length > 0) return { ok: false, messages };
  const callbackUrls = Array.isArray(input["callback_urls"])
    ? input["callback_urls"].filter((item): item is string => typeof item === "string")
    : typeof input["callback_url"] === "string"
      ? [input["callback_url"]]
      : [];
  return {
    ok: true,
    manifest: {
      name,
      url,
      description: typeof input["description"] === "string" ? input["description"] : "",
      hook,
      redirectUrl: typeof input["redirect_url"] === "string" ? input["redirect_url"] : null,
      callbackUrls,
      setupUrl: typeof input["setup_url"] === "string" ? input["setup_url"] : null,
      public: input["public"] === true,
      permissions,
      events: [...new Set(events)],
    },
  };
}

/** Why GitHub takes a name, or its refusal. */
export function checkAppName(name: string, taken: (name: string) => boolean): string | undefined {
  if (name.trim() === "") return "Name can't be blank";
  if (name.length > MAX_APP_NAME_LENGTH) return `Name is too long (maximum is ${MAX_APP_NAME_LENGTH} characters)`;
  if (taken(name)) return "Name has already been taken";
  return undefined;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

import { isTrialUrl } from "./settings.ts";

// The manifest of the install's GitHub App, which the setup screen posts to
// GitHub's new-App page (self-host-install: The GitHub App is created with
// GitHub's manifest flow; tracker-mirrors: The GitHub App asks for narrow
// permissions and every event up front; design.md, Self-hosting decisions:
// S4). It is a pure function of the install's URL, the App's name and the
// operator's option that GitHub cannot reach the install, so the setup screen
// and the allowlist test read the same manifest (github-app-reachability:
// design.md, Technical decisions: T2).
//
// The webhook follows the install's URL (github-app-reachability: design.md,
// Design rules: The webhook and the install URL). GitHub refuses a webhook URL
// on localhost, active or not, and refuses event subscriptions without a
// webhook, leaving the operator on its own error page. So a trial URL's App,
// and the App of an operator who chooses the option, has no webhook and
// subscribes to no event, and GitHub runs in polling mode; every other App has
// the active webhook at TIEHALL_URL/webhooks/github and the three events. No
// manifest lists `installation` or `installation_repositories`: every App
// receives them without subscribing, and GitHub refuses them as default
// events. The permissions are the same either way, so moving to webhook mode
// later needs no new permission.

/** What the App asks GitHub for: one table, which the allowlist test holds the builder to. */
export const GITHUB_APP_ACCESS = {
  permissions: { metadata: "read", pull_requests: "read", issues: "write", members: "read", emails: "read" },
  events: ["pull_request", "issues", "organization"],
} as const;

/** Where GitHub sends the operator back with the manifest's code: a page of the setup screen. */
export const MANIFEST_REDIRECT_PATH = "/setup/github";
/** Where GitHub sends a person back after they authorize the App to sign them in: the sign-in service's GitHub callback. */
export const SIGN_IN_CALLBACK_PATH = "/api/auth/callback/github";
/**
 * Where the setup screen's sign-in lives, which completes setup: under
 * /setup, the one path the setup gate serves before setup completes.
 */
export const SETUP_SIGN_IN_PATH = "/setup/sign-in";
/** Where GitHub sends the operator back after they authorize the App to sign them in from the setup screen. */
export const SETUP_SIGN_IN_CALLBACK_PATH = `${SETUP_SIGN_IN_PATH}/callback/github`;
/** Where GitHub delivers the App's webhooks. */
export const WEBHOOK_PATH = "/webhooks/github";

export interface AppManifestInput {
  /** The install's URL, TIEHALL_URL, as its origin. */
  url: string;
  /** The App's name, which the operator can edit, because App names are unique on GitHub. */
  name: string;
  /** The setup screen's option "GitHub cannot reach this address", which creates the App without a webhook. */
  unreachable: boolean;
}

/** GitHub's App manifest, in the fields GitHub documents. */
export interface AppManifest {
  name: string;
  url: string;
  hook_attributes?: { url: string; active: true };
  redirect_url: string;
  callback_urls: string[];
  public: false;
  default_permissions: { [permission: string]: "read" | "write" };
  default_events: string[];
}

/** Whether the App this manifest creates has a webhook: never on a trial URL, and not when the operator says GitHub cannot reach the install. */
export function manifestHasWebhook(input: Pick<AppManifestInput, "url" | "unreachable">): boolean {
  return !isTrialUrl(input.url) && !input.unreachable;
}

export function buildAppManifest(input: AppManifestInput): AppManifest {
  const base = new URL(input.url).origin;
  const webhook = manifestHasWebhook(input);
  return {
    name: input.name,
    url: base,
    ...(webhook ? { hook_attributes: { url: `${base}${WEBHOOK_PATH}`, active: true as const } } : {}),
    redirect_url: `${base}${MANIFEST_REDIRECT_PATH}`,
    // The usual sign-in's callback, and the setup screen's, which completes setup while the setup gate serves only /setup.
    callback_urls: [`${base}${SIGN_IN_CALLBACK_PATH}`, `${base}${SETUP_SIGN_IN_CALLBACK_PATH}`],
    public: false,
    default_permissions: { ...GITHUB_APP_ACCESS.permissions },
    default_events: webhook ? [...GITHUB_APP_ACCESS.events] : [],
  };
}

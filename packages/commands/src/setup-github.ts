import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { buildAppManifest, MANIFEST_REDIRECT_PATH, manifestHasWebhook, SETUP_SIGN_IN_PATH, WEBHOOK_PATH } from "./github-manifest.ts";
import type { StoredGitHubApp } from "./github-app.ts";
import { escapeHtml } from "./html.ts";
import { isTrialUrl } from "./settings.ts";

// The GitHub App step of the setup screen (self-host-install: The GitHub App
// is created with GitHub's manifest flow; design.md, Self-hosting decisions:
// S4; github-app-reachability: design.md, Design rules: The webhook and the
// install URL). Its one button posts the App's manifest to GitHub's new-App
// page: the page of the organization the operator names as the App's owner,
// which the screen recommends, or their personal one. The pages run no
// script, so the operator's settings (the owner, the App's name and the
// option that GitHub cannot reach the install) are applied with a plain form
// that reloads the step, and the button's form carries the manifest built
// from them.
//
// Before the button, the step says what the App gets. On a trial URL the App
// has no webhook and GitHub runs in polling mode, and there is no option. On
// any other URL the App gets a webhook unless the operator chooses the option;
// GitHub may refuse the webhook URL if it cannot reach the install, and then
// leaves the operator on its own error page, so the step says beforehand how
// to come back: open TIEHALL_URL/setup again in the same browser, whose setup
// session stays valid until setup completes, and choose the option.
//
// The round trip carries a state bound to the browser's setup session: a
// fresh random nonce with an HMAC of it keyed by the session's token, which
// only that browser's cookie holds. GitHub sends the state back with the code,
// and a return whose state does not verify against the browser's session is
// refused before anything is converted or stored.

/** GitHub's web pages, where the manifest is posted and the App is installed. */
export const GITHUB_WEB_URL = "https://github.com";

/** Where the setup screen's form names the company. */
export const COMPANY_PATH = "/setup/company";

/** The longest company name, in characters, as for a team's name. */
export const COMPANY_NAME_MAX_LENGTH = 100;

/**
 * The company's name as the operator typed it, trimmed; undefined when it is
 * empty, longer than 100 characters or holds a control character.
 */
export function companyName(value: string | null): string | undefined {
  const name = (value ?? "").trim();
  if (name === "" || [...name].length > COMPANY_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return undefined;
  return name;
}

/** The step that names the company, which becomes the name of the install's one org. */
export function companyStepBody(current: string): string {
  return `      <h2>Name the company</h2>
      <p>${escapeHtml("An install of Tiehall serves one company. Its name is the name of the install, shown in the web UI.")}</p>
      <form method="post" action="${COMPANY_PATH}">
        <label for="company">The company's name</label>
        <input id="company" name="name" type="text" value="${escapeHtml(current)}" maxlength="${COMPANY_NAME_MAX_LENGTH}" autocomplete="organization" required>
        <button type="submit">Save the name</button>
      </form>
`;
}

/** The line that names the company on the later steps, with the way to change it. */
function companyLine(company: string): string {
  return `      <p>${escapeHtml(`The company: ${company}.`)} <a href="/setup?step=company">Change the name</a></p>
`;
}

/** The option that creates the App without a webhook, as the setup screen names it. */
export const UNREACHABLE_OPTION = "GitHub cannot reach this address";

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const STATE_CONTEXT = "tiehall setup: the GitHub App manifest's state\n";

/** A new state for the manifest's round trip, bound to the setup session whose token the browser's cookie holds. */
export function manifestState(sessionToken: string): string {
  const nonce = randomBytes(16).toString("base64url");
  return `${nonce}.${stateMac(sessionToken, nonce)}`;
}

/** Whether a state that came back from GitHub was made for the setup session with this token. */
export function stateMatches(sessionToken: string, state: string | null): boolean {
  const [nonce, mac, ...rest] = (state ?? "").split(".");
  if (nonce === undefined || mac === undefined || rest.length > 0 || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) return false;
  const expected = Buffer.from(stateMac(sessionToken, nonce), "utf8");
  const given = Buffer.from(mac, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function stateMac(sessionToken: string, nonce: string): string {
  return createHmac("sha256", sessionToken).update(`${STATE_CONTEXT}${nonce}`).digest("base64url");
}

/** The App's name unless the operator gives another: "Tiehall" and the install's host. */
export function defaultAppName(url: string): string {
  return `Tiehall ${new URL(url).hostname}`;
}

/** The operator's settings of the App step, from the step's query. */
export interface AppStepSettings {
  /** The GitHub organization that owns the App, or empty for the operator's personal account. */
  org: string;
  name: string;
  /** The option that GitHub cannot reach the install; never set on a trial URL. */
  unreachable: boolean;
}

export function appStepSettings(url: string, query: URLSearchParams): AppStepSettings {
  const name = (query.get("name") ?? "").trim();
  return {
    org: (query.get("org") ?? "").trim(),
    name: name === "" ? defaultAppName(url) : name,
    unreachable: !isTrialUrl(url) && query.get("unreachable") === "1",
  };
}

/** Where the button's form posts the manifest: the organization's new-App page, or the personal one. */
export function newAppPage(webUrl: string, org: string, state: string): string {
  const path = org === "" ? "/settings/apps/new" : `/organizations/${org}/settings/apps/new`;
  return `${webUrl}${path}?${new URLSearchParams({ state }).toString()}`;
}

/** The App step: the operator's settings, what the App gets, and the button that posts the manifest to GitHub. */
export function appStepBody(input: { url: string; webUrl: string; settings: AppStepSettings; state: string; company?: string }): string {
  const { url, webUrl, settings, state } = input;
  const trial = isTrialUrl(url);
  const orgValid = settings.org === "" || GITHUB_LOGIN.test(settings.org);
  const option = trial
    ? ""
    : `        <p>
          <input id="unreachable" name="unreachable" type="checkbox" value="1"${settings.unreachable ? " checked" : ""}>
          <label for="unreachable">${escapeHtml(UNREACHABLE_OPTION)}</label>
        </p>
`;
  const settingsForm = `      <form method="get" action="/setup">
        <p>
          <label for="org">The GitHub organization that owns the App (recommended; leave it empty to create the App on your personal account)</label>
          <input id="org" name="org" type="text" value="${escapeHtml(settings.org)}" autocomplete="off" autocapitalize="none" spellcheck="false">
        </p>
        <p>
          <label for="name">The App's name, which must be unique on GitHub</label>
          <input id="name" name="name" type="text" value="${escapeHtml(settings.name)}" maxlength="34" autocomplete="off" spellcheck="false">
        </p>
${option}        <button type="submit">Apply</button>
      </form>
`;
  const intro = `${input.company === undefined ? "" : companyLine(input.company)}      <h2>Create the install's GitHub App</h2>
      <p>${escapeHtml(
        "Tiehall signs people in with GitHub, links pull requests and mirrors requests into GitHub Issues through a GitHub App of its own. " +
          "The button below takes you to GitHub, which asks you to confirm the App and then sends you back here. " +
          "To change the App's owner, its name or the option below, change them and apply them first.",
      )}</p>
`;
  if (!orgValid) {
    return `${intro}${settingsForm}      <p>${escapeHtml(`"${settings.org}" is not the name of a GitHub organization. Correct it and apply it, or leave it empty.`)}</p>
`;
  }
  const webhook = manifestHasWebhook({ url, unreachable: settings.unreachable });
  const manifest = buildAppManifest({ url, name: settings.name, unreachable: settings.unreachable });
  const polling = "The App is created without a webhook, and GitHub runs in polling mode: Tiehall asks GitHub for changes, which reach it within 2 minutes.";
  const gets = trial
    ? `This install's URL, ${url}, is a trial URL, which GitHub cannot deliver webhooks to. ${polling}`
    : webhook
      ? `The App is created with a webhook, so that GitHub sends changes to Tiehall at once. GitHub may refuse the webhook URL, ${url}${WEBHOOK_PATH}, ` +
        "if it cannot reach this address, and then shows its own error page, with no way back here. " +
        `In that case, open ${url}/setup again in this browser, where your setup session stays open, and choose "${UNREACHABLE_OPTION}".`
      : `${polling} An admin can move to webhook mode later from the admin page.`;
  const owner = settings.org === "" ? "your personal GitHub account" : `the GitHub organization ${settings.org}`;
  return `${intro}${settingsForm}      <p>${escapeHtml(gets)}</p>
      <p>${escapeHtml(`The button creates the App "${settings.name}", owned by ${owner}. GitHub then sends you back to ${url}${MANIFEST_REDIRECT_PATH}.`)}</p>
      <form method="post" action="${escapeHtml(newAppPage(webUrl, settings.org, state))}">
        <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
        <button type="submit">Create the GitHub App</button>
      </form>
`;
}

/** Why the sign-in from the setup screen did not complete setup, by the code it returned with. */
const SIGN_IN_ERRORS: Readonly<Record<string, string>> = {
  github_failed: "GitHub could not be reached to list the App's installations, so setup is not complete. Sign in again.",
  company_not_named: "Name the company before you sign in.",
  no_app: "Create the install's GitHub App before you sign in.",
  sign_in_refused: "The sign-in did not come from the browser that entered the setup code. Sign in from that browser.",
  access_denied: "GitHub says you did not authorize the install's GitHub App, so setup is not complete. Sign in again.",
};

/** The step after the App is stored: install it on its owner, then sign in with GitHub, which completes setup. */
export function installStepBody(input: { webUrl: string; app: StoredGitHubApp; company?: string; signIn?: boolean; error?: string | null }): string {
  const { webUrl, app } = input;
  const owner = app.owner.type === "Organization" ? `the GitHub organization ${app.owner.login}` : `your GitHub account ${app.owner.login}`;
  const install = `${webUrl}/apps/${encodeURIComponent(app.slug)}/installations/new`;
  const error =
    input.error === undefined || input.error === null
      ? ""
      : `      <p>${escapeHtml(SIGN_IN_ERRORS[input.error] ?? "The sign-in with GitHub did not complete setup. Sign in again.")}</p>
`;
  const signIn =
    input.signIn === false
      ? `      <p>${escapeHtml("Then come back here to sign in with GitHub, which completes setup.")}</p>
`
      : `      <h2>Sign in to complete setup</h2>
${error}      <p>${escapeHtml(
          "Once the App is installed, sign in with your GitHub account. You become the install's first admin, the installations of the App are connected, and setup is complete.",
        )}</p>
      <form method="post" action="${SETUP_SIGN_IN_PATH}">
        <button type="submit">Sign in with GitHub</button>
      </form>
`;
  return `${input.company === undefined ? "" : companyLine(input.company)}      <h2>Install the GitHub App</h2>
      <p>${escapeHtml(`The GitHub App "${app.name}" is created, owned by ${owner}. Install it there, and choose the repositories it covers.`)}</p>
      <p><a href="${escapeHtml(install)}">${escapeHtml(`Install ${app.name} on GitHub`)}</a></p>
${signIn}`;
}

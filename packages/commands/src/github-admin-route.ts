import {
  connectGitHubInstallation,
  disconnectGitHubInstallation,
  getGitHubIntegration,
  listGitHubInstallations,
  setGitHubMode,
  storeGitHubWebhookSecret,
  uploadGitHubPrivateKey,
  webShell,
  type githubInstallation,
} from "@tiehall/catalog";
import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import type { z } from "zod";
import type { WebSessionCaller } from "./caller.ts";
import { CONFIRM_PATH } from "./confirm-route.ts";
import type { Execute } from "./execute.ts";
import { adminNav } from "./admin-pages.ts";
import { answerRefusal, escapeHtml, htmlPage, PAGE_HEADERS, wayOnFor } from "./html.ts";
import { panelSections } from "./page-parts.ts";
import { WEBHOOK_PATH } from "./github-manifest.ts";
import { createLogger, type Logger } from "./log.ts";
import { renewingSession } from "./session-renewal.ts";
import type { PageShell, ShellMember } from "./shell.ts";
import { isTrialUrl } from "./settings.ts";
import { GITHUB_WEB_URL } from "./setup-github.ts";
import { SIGN_IN_PATH } from "./sign-in.ts";
import { assertWebWrite, csrfTokenFor } from "./web-writes.ts";

// The GitHub page of the admin UI, at /admin/github (tracker-mirrors: Admins
// connect GitHub installations with the confirmation step; tracker-mirrors:
// Covered repositories follow each connected installation; teams-and-roles:
// What admins and members may do). A GET shows a signed-in admin every
// installation of the install's GitHub App that Tiehall found by listing them:
// the connected ones, with the repositories they cover and a form that
// disconnects each, and those not connected, each with a link to the review
// page that connects it with the confirmation step. Tiehall ignores an
// installation that is not connected, so leaving it there is how an admin
// ignores it. The page also shows GitHub's mode, webhook or polling, with a
// form that switches it (tracker-mirrors: GitHub and Jira each run in webhook
// mode or polling mode). While no webhook secret is stored, the switch to
// webhook mode is not offered: on an install whose URL is not a trial URL the
// page shows the steps to webhook mode instead, with the install's own
// webhook URL, the three events and a link to the App's settings on GitHub,
// and on a trial URL it says that GitHub cannot deliver webhooks there
// (github-app-reachability: design.md, Design rules: Moving to webhook mode).
// Storing the secret, or another one, goes through its review page, with the
// confirmation step. A POST disconnects an installation or switches the
// mode: neither needs the confirmation step, but each passes the checks every
// web UI write passes (the session's CSRF token, an Origin equal to
// TIEHALL_URL and Sec-Fetch-Site: same-origin), and leads back to the page.
// All run through execute(), so a member gets 403; a browser without a session
// is sent to sign in first (D28 #66). The page runs no script, loads nothing,
// and cannot be framed; a refusal is a page for a browser, which leads back to
// the page, or to sign in, and an RFC 9457 problem for every other client
// (html.ts). Every answer carries the cookie that renews the session the page
// read, when the read renewed it (sign-in: Signing out and ending sessions;
// session-renewal.ts). The other admin pages come with later tasks.

export interface GitHubAdminRouteOptions {
  execute: Execute;
  /**
   * The signed-in user's web session, from the request's session cookie;
   * undefined when nobody is signed in. The read may renew the session, and
   * adds to `renewal` the cookies the route's answer carries (session-renewal.ts).
   */
  session(request: Request, renewal?: Headers): Promise<WebSessionCaller | undefined>;
  /** The install's URL (TIEHALL_URL), as its origin, which a write's Origin must equal. */
  url: string;
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the CSRF tokens; read when it is first needed. */
  secret: () => string;
  logger?: Logger;
}

export type GitHubAdminRoute = (request: Request) => Promise<Response>;

/** Where the page lives. */
export const GITHUB_ADMIN_PATH = "/admin/github";

type Installation = z.output<typeof githubInstallation>;
type Integration = z.output<typeof getGitHubIntegration.output>;

export function createGitHubAdminRoute(options: GitHubAdminRouteOptions): GitHubAdminRoute {
  const logger = options.logger ?? createLogger();
  return (request) => renewingSession((renewal) => githubAdmin(request, renewal));

  async function githubAdmin(request: Request, renewal: Headers): Promise<Response> {
    try {
      if (request.method === "POST") return await change(request, renewal);
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await options.session(request, renewal);
      if (caller === undefined) {
        return new Response(null, {
          status: 303,
          headers: { location: `${SIGN_IN_PATH}?return=${encodeURIComponent(GITHUB_ADMIN_PATH)}`, "cache-control": "no-store", ...frameless() },
        });
      }
      // The shell's read comes first, as on every page in the app shell (web-ui: The page shell and its navigation).
      const member = (await options.execute(webShell.id, caller, {}, { readOnly: true })) as ShellMember;
      const integration = (await options.execute(getGitHubIntegration.id, caller, {}, { readOnly: true })) as Integration;
      const output = (await options.execute(listGitHubInstallations.id, caller, {}, { readOnly: true })) as { installations: Installation[] };
      const csrf = csrfTokenFor(options.secret(), caller.sessionId);
      return new Response(page(integration, output.installations, csrf, options.url, { form: "app", member, path: GITHUB_ADMIN_PATH, csrf }), { headers: PAGE_HEADERS });
    } catch (error) {
      if (error instanceof Refusal) {
        return answerRefusal(request, httpProblem(error), wayOnFor(error.reason, { href: GITHUB_ADMIN_PATH, text: "Back to the GitHub page" }));
      }
      logger.error("github admin: the page failed", { error });
      return problem(internalErrorProblem());
    }
  }

  /**
   * Disconnects the installation the page's form names, or switches GitHub's
   * mode, once the request passes the web UI's write checks.
   */
  async function change(request: Request, renewal: Headers): Promise<Response> {
    const caller = await options.session(request, renewal);
    if (caller === undefined) throw new Refusal("unauthenticated", "Sign in to Tiehall to change the GitHub integration.");
    const form = new URLSearchParams(await request.text());
    assertWebWrite(
      { origin: request.headers.get("origin"), fetchSite: request.headers.get("sec-fetch-site"), csrfToken: form.get("csrf") },
      { url: options.url, secret: options.secret(), sessionId: caller.sessionId, confirm: false },
    );
    const action = form.get("action");
    const commandId = action === "disconnect" ? disconnectGitHubInstallation.id : action === "set_mode" ? setGitHubMode.id : undefined;
    if (commandId === undefined) throw new Refusal("route-not-found", "The GitHub page offers no such action.");
    const input = action === "disconnect" ? { installation: form.get("installation") ?? "" } : { mode: form.get("mode") ?? "" };
    const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;
    await options.execute(commandId, caller, input, {
      origin: { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) },
    });
    return new Response(null, { status: 303, headers: { location: GITHUB_ADMIN_PATH, "cache-control": "no-store", ...frameless() } });
  }
}

function frameless(): Record<string, string> {
  return { "content-security-policy": PAGE_HEADERS["content-security-policy"] };
}

function problem({ status, headers, body }: HttpProblem): Response {
  // A refusal cannot be framed either.
  return new Response(JSON.stringify(body), { status, headers: { ...headers, ...frameless() } });
}

/** Where an installation is installed, in a few words. */
function accountText({ account, accountType }: Installation): string {
  return accountType === "Organization" ? `the organization ${account}` : `the personal account ${account}`;
}

/** Whether an installation works, as GitHub last reported it. */
function stateText(installation: Installation): string {
  if (installation.deleted) return "Deleted on GitHub: it covers no repository.";
  if (installation.suspended) return "Suspended on GitHub: it covers no repository until it is unsuspended.";
  return installation.repositorySelection === "all" ? "Covers every repository of the account." : "Covers the repositories chosen on GitHub.";
}

/** The review page that stores the App's webhook secret; the secret itself is entered on that page. */
const STORE_WEBHOOK_SECRET = `${CONFIRM_PATH}${storeGitHubWebhookSecret.id}?input=${encodeURIComponent("{}")}`;

/** The review page that uploads a rotated private key for the App; the key file itself is picked on that page. */
const UPLOAD_PRIVATE_KEY = `${CONFIRM_PATH}${uploadGitHubPrivateKey.id}?input=${encodeURIComponent("{}")}`;

/** The App, and the upload of a new private key after it was rotated on GitHub. */
function appSection(integration: Integration): string[] {
  const app = integration.app;
  if (app === null) return [];
  return [
    "      <h2>The GitHub App</h2>",
    `      <p>${escapeHtml(`The install's GitHub App is ${app.name}, owned by ${app.ownerType === "Organization" ? "the organization" : "the personal account"} ${app.owner}.`)}</p>`,
    `      <p>After you generate a new private key in <a href="${escapeHtml(appSettingsUrl(app))}">the App's settings on GitHub</a>, <a href="${escapeHtml(UPLOAD_PRIVATE_KEY)}">upload the new private key</a>, with a confirmation. Tiehall checks it with GitHub before it stores it.</p>`,
  ];
}

/** The App's settings on GitHub, where its webhook and events are set: under its owner, an organization or a person. */
function appSettingsUrl(app: NonNullable<Integration["app"]>): string {
  const owner = encodeURIComponent(app.owner);
  const slug = encodeURIComponent(app.slug);
  return app.ownerType === "Organization" ? `${GITHUB_WEB_URL}/organizations/${owner}/settings/apps/${slug}` : `${GITHUB_WEB_URL}/settings/apps/${slug}`;
}

/** The form that switches GitHub to the other mode. */
function switchForm(target: "webhook" | "polling", csrf: string): string[] {
  return [
    `      <form method="post" action="${GITHUB_ADMIN_PATH}">`,
    '        <input type="hidden" name="action" value="set_mode">',
    `        <input type="hidden" name="mode" value="${target}">`,
    `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
    `        <button type="submit" class="secondary">Switch to ${target} mode</button>`,
    "      </form>",
  ];
}

/** GitHub's mode, what it means, and what moves it: the switch, or the steps to webhook mode. */
function modeSection(integration: Integration, csrf: string, url: string): string[] {
  const app = integration.app;
  const heading = "      <h2>How GitHub's changes reach Tiehall</h2>";
  if (app === null) return [heading, "      <p>The install has no GitHub App yet.</p>"];
  const lines = [
    heading,
    app.mode === "webhook"
      ? "      <p>GitHub runs in webhook mode: GitHub delivers each change to the install as it happens, and Tiehall asks GitHub to redeliver deliveries that failed.</p>"
      : "      <p>GitHub runs in polling mode: Tiehall asks GitHub for changes every 60 seconds, so a change reaches it within 2 minutes.</p>",
    "      <p>A reconciliation every 15 minutes finds what either mode missed.</p>",
  ];
  if (app.webhookSecret) {
    return [
      ...lines,
      ...switchForm(app.mode === "webhook" ? "polling" : "webhook", csrf),
      `      <p>A webhook secret is stored, and verifies every delivery. <a href="${escapeHtml(STORE_WEBHOOK_SECRET)}">Store another webhook secret</a>, with a confirmation, after you change it in the App's settings on GitHub.</p>`,
    ];
  }
  if (isTrialUrl(url)) {
    return [...lines, `      <p>${escapeHtml(`GitHub cannot deliver webhooks to ${url}: it reaches no address on localhost, so GitHub stays in polling mode.`)}</p>`];
  }
  const hook = `${url}${WEBHOOK_PATH}`;
  return [
    ...lines,
    "      <p>The App has no webhook, so GitHub delivers nothing to the install. Once GitHub can reach the install, these steps move GitHub to webhook mode:</p>",
    "      <ol>",
    `        <li>In <a href="${escapeHtml(appSettingsUrl(app))}">the App's settings on GitHub</a>, under Webhook, make the webhook active, set its URL to ${escapeHtml(hook)}, and set a webhook secret.</li>`,
    "        <li>Under Permissions and events, subscribe to the events pull_request, issues and organization (Pull request, Issues and Organization). No permission changes.</li>",
    `        <li><a href="${escapeHtml(STORE_WEBHOOK_SECRET)}">Store the same secret in Tiehall</a>, and confirm it on its review page.</li>`,
    "        <li>Switch GitHub to webhook mode here, then check on the App's Advanced tab on GitHub that the next delivery succeeded.</li>",
    "      </ol>",
  ];
}

function page(integration: Integration, installations: readonly Installation[], csrf: string, url: string, shell: PageShell): string {
  const connected = installations.filter(({ connected: isConnected }) => isConnected);
  const others = installations.filter(({ connected: isConnected, deleted }) => !isConnected && !deleted);
  const connectedRows = connected.map(
    (installation) => `        <li class="item">
          <p>${escapeHtml(`${installation.account}: the App's installation on ${accountText(installation)}. ${stateText(installation)}`)}</p>
          <p>${escapeHtml(installation.repositories.length === 0 ? "No repository counts as covered." : `Covered: ${installation.repositories.join(", ")}.`)}</p>
          <form method="post" action="${GITHUB_ADMIN_PATH}">
            <input type="hidden" name="action" value="disconnect">
            <input type="hidden" name="installation" value="${escapeHtml(installation.id)}">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button type="submit" class="secondary">${escapeHtml(`Disconnect ${installation.account}`)}</button>
          </form>
        </li>`,
  );
  const otherRows = others.map((installation) => {
    const review = `${CONFIRM_PATH}${connectGitHubInstallation.id}?input=${encodeURIComponent(JSON.stringify({ installation: installation.id }))}`;
    return `        <li class="item">
          <p>${escapeHtml(`${installation.account}: the App's installation on ${accountText(installation)}. ${stateText(installation)}`)}</p>
          <p><a class="button secondary" href="${escapeHtml(review)}">${escapeHtml(`Connect ${installation.account}`)}</a> <span class="hint">With a confirmation.</span></p>
        </li>`;
  });
  return htmlPage(
    "GitHub",
    [
      "      <h1>GitHub</h1>",
      adminNav(GITHUB_ADMIN_PATH),
      ...panelSections([
        ...appSection(integration),
        ...modeSection(integration, csrf, url),
        "      <h2>Connected installations</h2>",
        '      <p class="hint">Tiehall acts on these installations of the install\'s GitHub App: the repositories they cover count as covered. Disconnecting one needs no confirmation and removes no member.</p>',
        connectedRows.length === 0 ? '      <p class="empty">No installation is connected.</p>' : `      <ul class="items">\n${connectedRows.join("\n")}\n      </ul>`,
        "      <h2>Installations not connected</h2>",
        '      <p class="hint">Tiehall ignores these until an admin connects them: their repositories do not count as covered, and membership of their GitHub organizations lets nobody sign in. Leave one here to ignore it.</p>',
        otherRows.length === 0 ? '      <p class="empty">Every installation of the App is connected.</p>' : `      <ul class="items">\n${otherRows.join("\n")}\n      </ul>`,
      ]),
    ].join("\n"),
    shell,
  );
}

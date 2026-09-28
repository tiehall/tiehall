import { connectGitHubInstallation, disconnectGitHubInstallation, listGitHubInstallations, type githubInstallation } from "@tiehall/catalog";
import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import type { z } from "zod";
import type { WebSessionCaller } from "./caller.ts";
import { CONFIRM_PATH } from "./confirm-route.ts";
import type { Execute } from "./execute.ts";
import { escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
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
// ignores it. A POST disconnects one: it needs no confirmation step, but passes
// the checks every web UI write passes (the session's CSRF token, an Origin
// equal to TIEHALL_URL and Sec-Fetch-Site: same-origin), and leads back to the
// page. Both run through execute(), so a member gets 403; a browser without a
// session is sent to sign in first (D28 #66). The page runs no script, loads
// nothing, and cannot be framed; refusals are RFC 9457 problems. The
// integrations' mode and the other admin pages come with later tasks.

export interface GitHubAdminRouteOptions {
  execute: Execute;
  /** The signed-in user's web session, from the request's session cookie; undefined when nobody is signed in. */
  session(request: Request): Promise<WebSessionCaller | undefined>;
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

export function createGitHubAdminRoute(options: GitHubAdminRouteOptions): GitHubAdminRoute {
  const logger = options.logger ?? createLogger();
  return async function githubAdmin(request) {
    try {
      if (request.method === "POST") return await disconnect(request);
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await options.session(request);
      if (caller === undefined) {
        return new Response(null, {
          status: 303,
          headers: { location: `${SIGN_IN_PATH}?return=${encodeURIComponent(GITHUB_ADMIN_PATH)}`, "cache-control": "no-store", ...frameless() },
        });
      }
      const output = (await options.execute(listGitHubInstallations.id, caller, {}, { readOnly: true })) as { installations: Installation[] };
      return new Response(page(output.installations, csrfTokenFor(options.secret(), caller.sessionId)), { headers: PAGE_HEADERS });
    } catch (error) {
      if (error instanceof Refusal) return problem(httpProblem(error));
      logger.error("github admin: the page failed", { error });
      return problem(internalErrorProblem());
    }
  };

  /** Disconnects the installation the page's form names, once the request passes the web UI's write checks. */
  async function disconnect(request: Request): Promise<Response> {
    const caller = await options.session(request);
    if (caller === undefined) throw new Refusal("unauthenticated", "Sign in to Tiehall to disconnect an installation.");
    const form = new URLSearchParams(await request.text());
    assertWebWrite(
      { origin: request.headers.get("origin"), fetchSite: request.headers.get("sec-fetch-site"), csrfToken: form.get("csrf") },
      { url: options.url, secret: options.secret(), sessionId: caller.sessionId, confirm: false },
    );
    if (form.get("action") !== "disconnect") throw new Refusal("route-not-found", "The GitHub page offers no such action.");
    const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;
    await options.execute(disconnectGitHubInstallation.id, caller, { installation: form.get("installation") ?? "" }, {
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

function page(installations: readonly Installation[], csrf: string): string {
  const connected = installations.filter(({ connected: isConnected }) => isConnected);
  const others = installations.filter(({ connected: isConnected, deleted }) => !isConnected && !deleted);
  const connectedRows = connected.map(
    (installation) => `        <li>
          <p>${escapeHtml(`${installation.account}: the App's installation on ${accountText(installation)}. ${stateText(installation)}`)}</p>
          <p>${escapeHtml(installation.repositories.length === 0 ? "No repository counts as covered." : `Covered: ${installation.repositories.join(", ")}.`)}</p>
          <form method="post" action="${GITHUB_ADMIN_PATH}">
            <input type="hidden" name="action" value="disconnect">
            <input type="hidden" name="installation" value="${escapeHtml(installation.id)}">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button type="submit">${escapeHtml(`Disconnect ${installation.account}`)}</button>
          </form>
        </li>`,
  );
  const otherRows = others.map((installation) => {
    const review = `${CONFIRM_PATH}${connectGitHubInstallation.id}?input=${encodeURIComponent(JSON.stringify({ installation: installation.id }))}`;
    return `        <li>
          <p>${escapeHtml(`${installation.account}: the App's installation on ${accountText(installation)}. ${stateText(installation)}`)}</p>
          <p><a href="${escapeHtml(review)}">${escapeHtml(`Connect ${installation.account}`)}</a>, with a confirmation.</p>
        </li>`;
  });
  return htmlPage(
    "GitHub",
    [
      "      <h1>GitHub</h1>",
      "      <h2>Connected installations</h2>",
      "      <p>Tiehall acts on these installations of the install's GitHub App: the repositories they cover count as covered. Disconnecting one needs no confirmation and removes no member.</p>",
      connectedRows.length === 0 ? "      <p>No installation is connected.</p>" : `      <ul>\n${connectedRows.join("\n")}\n      </ul>`,
      "      <h2>Installations not connected</h2>",
      "      <p>Tiehall ignores these until an admin connects them: their repositories do not count as covered, and membership of their GitHub organizations lets nobody sign in. Leave one here to ignore it.</p>",
      otherRows.length === 0 ? "      <p>Every installation of the App is connected.</p>" : `      <ul>\n${otherRows.join("\n")}\n      </ul>`,
    ].join("\n"),
  );
}

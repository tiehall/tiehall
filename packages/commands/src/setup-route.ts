import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { orgs, type Database } from "@tiehall/db";
import { readGitHubApp, storeGitHubApp } from "./github-app.ts";
import { convertManifestCode, GITHUB_API_URL, ManifestConversionError } from "./github-client.ts";
import { MANIFEST_REDIRECT_PATH } from "./github-manifest.ts";
import { escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import type { SecretBox } from "./secret-box.ts";
import { isSetupSession, openSetupSession } from "./setup-code.ts";
import { readSetupState, SETUP_PATH } from "./setup-gate.ts";
import { appStepBody, appStepSettings, GITHUB_WEB_URL, installStepBody, manifestState, stateMatches } from "./setup-github.ts";

// The setup screen at /setup (self-host-install: The setup code guards the
// setup screen; self-host-install: The GitHub App is created with GitHub's
// manifest flow; design.md, Self-hosting decisions: S3 and S4):
// - GET shows the form for the setup code, or, to a browser that holds a setup
//   session, the next step of setup: the GitHub App step until the App's
//   credentials are stored, then the step that installs the App. A browser
//   that reached the install through any origin but TIEHALL_URL's, such as its
//   address on the local network, gets neither: the page names the URL to open
//   instead, because the GitHub App that setup creates works only at
//   TIEHALL_URL.
// - POST takes the code a person typed. It is refused with 403, and opens no
//   session, unless its Origin is TIEHALL_URL's and the code is the current
//   one; otherwise it opens a setup session, sets its cookie and leads back
//   to the setup screen.
// - GET /setup/github is where GitHub sends the operator back from the
//   manifest flow, with a code and the state the App step made. A return with
//   no setup session, or whose state was not made for the browser's setup
//   session, is refused with 403 before anything is converted or stored.
//   Otherwise Tiehall converts the code at once, well within the hour GitHub
//   allows, stores the App's credentials encrypted, replacing any App stored
//   before, and leads back to the setup screen, which then sends the operator
//   on to install the App. A code GitHub no longer converts stores nothing,
//   and the page says to create the App again.
// - Once setup is complete, every path under /setup answers 404 to everyone.
// Refusals are RFC 9457 problems, as on every endpoint Tiehall serves
// (public-api: One error model for Tiehall's own refusals). The pages are
// plain HTML: no script, no style from anywhere, no framing, and forms that
// post only to the install.

export interface SetupRouteOptions {
  /** The app's database, as the app role. */
  database: Database;
  /** The install's URL (TIEHALL_URL), as its origin. */
  url: string;
  /** Encrypts the GitHub App's credentials before they are stored: TIEHALL_SECRET_KEY's box, opened when first needed. */
  secrets: () => SecretBox;
  /** GitHub's web pages and API, which a test points at the GitHub stub; github.com and api.github.com otherwise. */
  github?: { webUrl?: string; apiUrl?: string; fetch?: typeof fetch };
  logger?: Logger;
}

export type SetupRoute = (request: Request) => Promise<Response>;

/** The cookie that holds a setup session: host-only and sent only over HTTPS, except on a trial install on http://localhost. */
export function setupCookieName(url: string): string {
  return url.startsWith("https:") ? "__Host-tiehall-setup" : "tiehall-setup";
}

const CLOSED = httpProblem(new Refusal("route-not-found", "Setup is complete, so there is no setup screen."));
const NO_SUCH_STEP = httpProblem(new Refusal("route-not-found", "The setup screen has no such step."));
const FOREIGN_RETURN = httpProblem(
  new Refusal(
    "forbidden",
    "This return from GitHub does not belong to this browser's setup session, so nothing was stored. Open /setup in the browser that started creating the App.",
  ),
);
const NO_CODE = httpProblem(
  new Refusal("invalid-input", "GitHub's return carries no code.", { issues: [{ path: ["code"], message: "GitHub's return carries no code." }] }),
);
const WRONG_ORIGIN = httpProblem(
  new Refusal("forbidden", "The setup screen takes a setup code only from a form on the install's own URL, TIEHALL_URL."),
);
const WRONG_CODE = httpProblem(
  new Refusal(
    "forbidden",
    "That is not the current setup code. The app prints a new one to its log at each start: run `docker compose logs app`.",
  ),
);

export function createSetupRoute(options: SetupRouteOptions): SetupRoute {
  const logger = options.logger ?? createLogger();
  const cookieName = setupCookieName(options.url);
  const webUrl = options.github?.webUrl ?? GITHUB_WEB_URL;
  return async function setup(request) {
    try {
      if ((await readSetupState(options.database)).complete) return problem(CLOSED);
      const { pathname } = new URL(request.url);
      if (pathname === MANIFEST_REDIRECT_PATH && request.method === "GET") return await fromGitHub(request);
      if (pathname !== SETUP_PATH) return problem(NO_SUCH_STEP);
      if (request.method === "POST") return await enterCode(request);
      if (browserOrigin(request) !== options.url) return page(wrongOriginPage(options.url));
      const token = cookieOf(request, cookieName);
      if (token === undefined || !(await isSetupSession(options.database, token))) return page(codePage());
      return await nextStep(request, token);
    } catch (error) {
      logger.error("setup: the setup screen failed", { error });
      return problem(internalErrorProblem());
    }
  };

  /** The step a browser with a setup session is at: the App step, or installing the App once it is stored. */
  async function nextStep(request: Request, token: string): Promise<Response> {
    const app = await options.database.transaction(async (tx) => {
      const [org] = await tx.select({ id: orgs.id }).from(orgs).limit(1);
      return org === undefined ? undefined : readGitHubApp({ tx, orgId: org.id });
    });
    if (app !== undefined) return page(layout(installStepBody({ webUrl, app })));
    const settings = appStepSettings(options.url, new URL(request.url).searchParams);
    const body = appStepBody({ url: options.url, webUrl, settings, state: manifestState(token) });
    // The step's one button posts the manifest to GitHub's new-App page, so its forms may post there too.
    return page(layout(body), { "content-security-policy": pagePolicy(`'self' ${new URL(webUrl).origin}`) });
  }

  /** GitHub's return from the manifest flow: the code, converted and stored when the state is this browser's. */
  async function fromGitHub(request: Request): Promise<Response> {
    const token = cookieOf(request, cookieName);
    const query = new URL(request.url).searchParams;
    if (token === undefined || !stateMatches(token, query.get("state")) || !(await isSetupSession(options.database, token))) {
      return problem(FOREIGN_RETURN);
    }
    const code = query.get("code");
    if (code === null || code === "") return problem(NO_CODE);
    // Opened before the code is used: GitHub converts a code only once.
    const box = options.secrets();
    let app;
    try {
      app = await convertManifestCode(code, {
        apiUrl: options.github?.apiUrl ?? GITHUB_API_URL,
        ...(options.github?.fetch === undefined ? {} : { fetch: options.github.fetch }),
        logger,
      });
    } catch (error) {
      if (!(error instanceof ManifestConversionError)) throw error;
      logger.warn("setup: GitHub did not convert the manifest's code", { error, status: error.status });
      return page(layout(conversionFailedBody()), {}, 502);
    }
    const stored = await options.database.transaction(async (tx) => {
      // Setup may have completed meanwhile, in another browser; the org row is locked against that.
      const [org] = await tx
        .select({ id: orgs.id, setupCompletedAt: orgs.setupCompletedAt })
        .from(orgs)
        .limit(1)
        .for("update");
      if (org === undefined || org.setupCompletedAt !== null) return false;
      await storeGitHubApp({ tx, orgId: org.id }, box, app);
      return true;
    });
    if (!stored) return problem(CLOSED);
    logger.info("setup: the GitHub App's credentials are stored", { appId: app.id });
    return new Response(null, { status: 303, headers: { location: `${options.url}${SETUP_PATH}`, "cache-control": "no-store" } });
  }

  async function enterCode(request: Request): Promise<Response> {
    if (originOf(request.headers.get("origin")) !== options.url) return problem(WRONG_ORIGIN);
    const code = new URLSearchParams(await request.text()).get("code") ?? "";
    const token = await openSetupSession(options.database, code);
    if (token === undefined) return problem(WRONG_CODE);
    const secure = options.url.startsWith("https:") ? "; Secure" : "";
    return new Response(null, {
      status: 303,
      headers: {
        location: `${options.url}${SETUP_PATH}`,
        "cache-control": "no-store",
        "set-cookie": `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      },
    });
  }
}

/** The origin a URL or an Origin header names, in the form TIEHALL_URL is kept in; undefined for none. */
function originOf(value: string | null): string | undefined {
  if (value === null || value === "null") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** The origin the browser used, from the Host header and the scheme the web role's request guard set. */
function browserOrigin(request: Request): string | undefined {
  const url = new URL(request.url);
  const scheme = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  const host = request.headers.get("host") ?? url.host;
  return originOf(`${scheme}://${host}`);
}

/** A cookie's value from the Cookie header. */
function cookieOf(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function problem({ status, headers, body }: HttpProblem): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function page(html: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...headers } });
}

/** The pages' content security policy, with the places their forms may post to. */
function pagePolicy(formAction: string): string {
  return PAGE_HEADERS["content-security-policy"].replace("form-action 'self'", `form-action ${formAction}`);
}

function layout(body: string): string {
  return htmlPage("Set up Tiehall", `      <h1>Set up Tiehall</h1>\n${body}`);
}

function codePage(): string {
  return layout(`      <p>Enter the setup code. The app prints it to its log each time it starts; on the host, run <code>docker compose logs app</code> to read it.</p>
      <form method="post" action="${SETUP_PATH}">
        <label for="code">Setup code</label>
        <input id="code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
        <button type="submit">Continue</button>
      </form>`);
}

function conversionFailedBody(): string {
  return `      <h2>The GitHub App could not be stored</h2>
      <p>${escapeHtml(
        "GitHub did not give Tiehall the new App's credentials: it converts the code it sends back only once, and only within the hour. " +
          "Nothing was stored. Delete the App GitHub created, if any, in your GitHub settings, then create the App again.",
      )}</p>
      <p><a href="${SETUP_PATH}">Back to the setup screen</a></p>
`;
}

function wrongOriginPage(url: string): string {
  const setupUrl = escapeHtml(`${url}${SETUP_PATH}`);
  return layout(`      <p>This install's URL is ${escapeHtml(url)}, and setup works only there. Open <a href="${setupUrl}">${setupUrl}</a> to set it up.</p>`);
}

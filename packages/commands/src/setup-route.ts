import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import type { Database } from "@tiehall/db";
import { escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { isSetupSession, openSetupSession } from "./setup-code.ts";
import { readSetupState, SETUP_PATH } from "./setup-gate.ts";

// The setup screen at /setup (self-host-install: The setup code guards the
// setup screen; design.md, Self-hosting decisions: S3):
// - GET shows the form for the setup code, or, to a browser that holds a setup
//   session, the next step of setup. A browser that reached the install
//   through any origin but TIEHALL_URL's, such as its address on the local
//   network, gets neither: the page names the URL to open instead, because
//   the GitHub App that setup creates works only at TIEHALL_URL.
// - POST takes the code a person typed. It is refused with 403, and opens no
//   session, unless its Origin is TIEHALL_URL's and the code is the current
//   one; otherwise it opens a setup session, sets its cookie and leads back
//   to the setup screen.
// - Once setup is complete, /setup answers 404 to everyone.
// Refusals are RFC 9457 problems, as on every endpoint Tiehall serves
// (public-api: One error model for Tiehall's own refusals). The pages are
// plain HTML: no script, no style from anywhere, no framing, and forms that
// post only to the install.

export interface SetupRouteOptions {
  /** The app's database, as the app role. */
  database: Database;
  /** The install's URL (TIEHALL_URL), as its origin. */
  url: string;
  logger?: Logger;
}

export type SetupRoute = (request: Request) => Promise<Response>;

/** The cookie that holds a setup session: host-only and sent only over HTTPS, except on a trial install on http://localhost. */
export function setupCookieName(url: string): string {
  return url.startsWith("https:") ? "__Host-tiehall-setup" : "tiehall-setup";
}

const CLOSED = httpProblem(new Refusal("route-not-found", "Setup is complete, so there is no setup screen."));
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
  return async function setup(request) {
    try {
      if ((await readSetupState(options.database)).complete) return problem(CLOSED);
      if (request.method === "POST") return await enterCode(request);
      if (browserOrigin(request) !== options.url) return page(wrongOriginPage(options.url));
      const session = await isSetupSession(options.database, cookieOf(request, cookieName));
      return page(session ? acceptedPage() : codePage());
    } catch (error) {
      logger.error("setup: the setup screen failed", { error });
      return problem(internalErrorProblem());
    }
  };

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

function page(html: string): Response {
  return new Response(html, { headers: PAGE_HEADERS });
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

function acceptedPage(): string {
  return layout(`      <p>The setup code is accepted. Setup continues here: you name the company, create the install's GitHub App and sign in with GitHub.</p>`);
}

function wrongOriginPage(url: string): string {
  const setupUrl = escapeHtml(`${url}${SETUP_PATH}`);
  return layout(`      <p>This install's URL is ${escapeHtml(url)}, and setup works only there. Open <a href="${setupUrl}">${setupUrl}</a> to set it up.</p>`);
}

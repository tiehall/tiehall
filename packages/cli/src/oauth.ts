import { abortable, CliError, nowOf, sleepOf, UnreachableError, type CliEnvironment } from "./environment.ts";
import { chooseLogin, saveLogin, withLoginsLock, type SavedLogin } from "./logins.ts";
import { CLI_VERSION, CLI_VERSION_HEADER } from "./version.ts";

// How the CLI signs in, and keeps its login working (agent-access: The CLI
// signs in through a restricted device flow; agent-access: Access tokens live
// 10 minutes and refresh tokens rotate; agent-surfaces: CLI request commands;
// design.md, Technical decisions: T7). The CLI is a public client with a
// fixed client id, `tiehall-cli`, which the install registers itself. `tiehall
// login <url>` runs the OAuth device authorization grant (RFC 8628) with the
// install at that URL: it asks for a device code for its client and the
// install's MCP resource, the one audience its token has, and never for an
// OpenID Connect scope; prints the install's approval page and the code to
// type there, never a link that carries the code, since the page ignores
// one; and polls the token endpoint at the interval the install gives until
// someone approves the code, it expires, or the approval is refused. An
// access token lives 10 minutes, so a command whose saved access token has
// expired, or is refused as invalid, first exchanges the refresh token for new
// tokens, which replace the saved ones: a refresh token is good for one
// refresh.

/** The CLI's fixed client id, which each install registers. */
export const CLI_CLIENT_ID = "tiehall-cli";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/**
 * The scopes the CLI asks for: reading and writing requests, and attaching
 * classified contract changes, which `tiehall contract diff --attach` does
 * (agent-access: OAuth scopes are coarse; contract-changes: Attaching a
 * contract diff to a request by hand).
 */
const SCOPES = "requests:read requests:write contracts:report";

/**
 * Whether an answer is a redirect, which the CLI does not follow: its tokens,
 * and its sign-in's codes, go to the install at its URL and nowhere else, so a
 * redirect to another origin, from the install or a proxy in front of it,
 * gets nothing sent on. Every request of the CLI asks for the redirect itself.
 */
export function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

/** The refusal of a command whose install answered with a redirect. */
export function redirectRefusal(url: string): CliError {
  return new CliError(`${url} answered with a redirect, which the CLI does not follow, so nothing was sent on: check that ${url} is your install's own URL.`);
}

/** A form posted to the install's sign-in service, and its JSON answer; given up when `signal` aborts. */
async function post(
  environment: CliEnvironment,
  url: string,
  path: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await abortable(
      (environment.fetch ?? fetch)(
        new Request(`${url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": `tiehall/${CLI_VERSION}`, [CLI_VERSION_HEADER]: CLI_VERSION },
          body: new URLSearchParams(fields).toString(),
          redirect: "manual",
          ...(signal === undefined ? {} : { signal }),
        }),
      ),
      signal,
    );
  } catch (error) {
    throw new UnreachableError(`The CLI could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (isRedirect(response)) throw redirectRefusal(url);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {} };
}

/** When an access token that lives this many seconds from now expires. */
function expiry(environment: CliEnvironment, seconds: unknown): string {
  const lifetime = typeof seconds === "number" && seconds > 0 ? seconds : 600;
  return new Date(now(environment).getTime() + lifetime * 1000).toISOString();
}

function now(environment: CliEnvironment): Date {
  return nowOf(environment);
}

/** The tokens of an answer of the token endpoint, as a saved login for the install. */
function loginOf(environment: CliEnvironment, url: string, body: Record<string, unknown>): SavedLogin {
  const accessToken = body["access_token"];
  const refreshToken = body["refresh_token"];
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") throw new CliError(`${url} answered the CLI's sign-in without its tokens.`);
  return { url, accessToken, refreshToken, expiresAt: expiry(environment, body["expires_in"]) };
}

/** An OAuth error's code, such as authorization_pending. */
function errorOf(body: Record<string, unknown>): string {
  return typeof body["error"] === "string" ? body["error"] : "";
}

/** `tiehall login <url>`: signs in to the install through the device flow, and saves the login. */
export async function logIn(environment: CliEnvironment, configDir: string, url: string): Promise<SavedLogin> {
  const started = await post(environment, url, "/api/auth/device/code", { client_id: CLI_CLIENT_ID, resource: `${url}/mcp`, scope: SCOPES });
  const deviceCode = started.body["device_code"];
  const userCode = started.body["user_code"];
  if (started.status !== 200 || typeof deviceCode !== "string" || typeof userCode !== "string" || !/^[A-Z0-9-]{4,20}$/.test(userCode)) {
    throw new CliError(`${url} did not start the CLI's sign-in${errorOf(started.body) === "" ? "" : ` (${errorOf(started.body)})`}: check that it is your install's URL.`);
  }
  // The approval page on the install itself; the code is typed there, never carried in a link.
  environment.stdout(
    `To sign in to ${url}, open ${url}/device in a browser where you are signed in to Tiehall, and type this code: ${userCode}\n` +
      "The page shows where and when this sign-in started: continue only if you just ran tiehall login.\n",
  );
  let interval = typeof started.body["interval"] === "number" && started.body["interval"] > 0 ? started.body["interval"] : 5;
  const lifetime = typeof started.body["expires_in"] === "number" ? started.body["expires_in"] : 600;
  const until = now(environment).getTime() + lifetime * 1000;
  const sleep = sleepOf(environment);
  for (;;) {
    await sleep(interval * 1000);
    const polled = await post(environment, url, "/api/auth/oauth2/token", { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode, client_id: CLI_CLIENT_ID });
    if (polled.status === 200) {
      const login = loginOf(environment, url, polled.body);
      saveLogin(configDir, login);
      return login;
    }
    const error = errorOf(polled.body);
    if (error === "slow_down") interval += 5;
    else if (error === "expired_token" || (error === "authorization_pending" && now(environment).getTime() > until)) {
      throw new CliError("The code expired before it was approved: run tiehall login again.");
    } else if (error === "access_denied") throw new CliError("The sign-in was refused on the approval page.");
    else if (error !== "authorization_pending") throw new CliError(`${url} refused the CLI's sign-in${error === "" ? "" : ` (${error})`}: run tiehall login again.`);
  }
}

/** Whether a saved access token has expired, or does within a minute. */
export function expiresSoon(environment: CliEnvironment, login: SavedLogin): boolean {
  const at = Date.parse(login.expiresAt);
  return Number.isNaN(at) || at - now(environment).getTime() < 60_000;
}

/**
 * The saved login with new tokens, from its refresh token, saved in place of
 * the old ones. Another command may have refreshed it meanwhile: then its
 * tokens, as saved, are used. The refresh is given up when `signal` aborts,
 * as a hook's time runs out while the install does not answer.
 */
export async function refreshLogin(environment: CliEnvironment, configDir: string, login: SavedLogin, signal?: AbortSignal): Promise<SavedLogin> {
  const sleep = sleepOf(environment);
  return withLoginsLock(configDir, sleep, async () => {
    const current = chooseLogin(configDir, { install: login.url });
    if (current.accessToken !== login.accessToken && !expiresSoon(environment, current)) return current;
    const refreshed = await post(
      environment,
      login.url,
      "/api/auth/oauth2/token",
      {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: CLI_CLIENT_ID,
        resource: `${login.url}/mcp`,
      },
      signal,
    );
    // An install that cannot answer for now, such as one that restarts, may take the refresh token once it is back.
    if (refreshed.status >= 500) throw new UnreachableError(`${login.url} could not refresh the saved login for now (HTTP ${refreshed.status}): try again once it is back.`);
    if (refreshed.status !== 200) throw new CliError(`The saved login for ${login.url} no longer works: run tiehall login ${login.url} again.`);
    const next = loginOf(environment, login.url, refreshed.body);
    saveLogin(configDir, next);
    return next;
  });
}

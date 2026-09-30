import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, type CliEnvironment } from "./environment.ts";

// The CLI's saved logins (agent-surfaces: CLI request commands; agent-access:
// The CLI keeps its token readable only by the user; design.md, Design rules:
// Agent access; design.md, Self-hosting decisions: S15). `tiehall login
// <url>` keeps one saved login per install URL in `logins.json`, in the CLI's
// configuration folder: the access token, the refresh token and when the
// access token expires. The folder is the one TIEHALL_CONFIG_DIR names, or
// `tiehall` in XDG_CONFIG_HOME, in APPDATA on Windows, or in ~/.config. The
// file is readable and writable only by the user who signed in, mode 0600:
// every write goes to a new file of that mode, which then replaces the old
// one, whatever mode the old one had.
//
// A command uses the saved login of the install it is for: the one --install
// names, the one whose URL a request URL it is given starts with, or the one
// there is. With several and no way to tell, it refuses, lists them, and
// sends nothing. A URL on an origin with no saved login is refused the same
// way, so nothing, and no token, goes to a host the user has not signed in to.

/** A saved login: the install's URL and the CLI's tokens for it. */
export interface SavedLogin {
  /** The install's URL, TIEHALL_URL, as its origin, such as https://tiehall.example.com. */
  url: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, as an ISO date and time. */
  expiresAt: string;
}

/** The file's contents: the saved logins by install URL. */
export interface LoginsFile {
  logins: Record<string, Omit<SavedLogin, "url">>;
}

/** The CLI's configuration folder on this machine. */
export function configDirOf(env: CliEnvironment["env"]): string {
  const named = env["TIEHALL_CONFIG_DIR"];
  if (named !== undefined && named !== "") return named;
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, "tiehall");
  const appData = env["APPDATA"];
  if (appData !== undefined && appData !== "") return join(appData, "tiehall");
  const home = env["HOME"] ?? env["USERPROFILE"];
  if (home === undefined || home === "") throw new CliError("The CLI cannot tell where to keep its logins: set TIEHALL_CONFIG_DIR or HOME.");
  return join(home, ".config", "tiehall");
}

/** The file of saved logins in a configuration folder. */
export function loginsFileOf(configDir: string): string {
  return join(configDir, "logins.json");
}

/**
 * An install's URL as the CLI keeps it: its origin. It is an https:// URL, or
 * http://localhost with or without a port, for a trial on one machine, as an
 * install's TIEHALL_URL is; a path, a query or credentials in it are refused.
 */
export function installUrlOf(raw: string): string {
  const refusal = new CliError(
    `${raw} is not an install's URL: give its https:// URL, such as https://tiehall.example.com, or http://localhost for a trial on one machine.`,
  );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refusal;
  }
  const trial = url.protocol === "http:" && url.hostname === "localhost";
  if (!(url.protocol === "https:" || trial) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw refusal;
  if (url.pathname !== "/" && url.pathname !== "") throw refusal;
  return url.origin;
}

/** Every saved login, in the order of their URLs. */
export function savedLogins(configDir: string): SavedLogin[] {
  return Object.entries(readLoginsFile(configDir).logins)
    .filter(([, login]) => typeof login?.accessToken === "string" && typeof login.refreshToken === "string")
    .map(([url, login]) => ({ url, accessToken: login.accessToken, refreshToken: login.refreshToken, expiresAt: String(login.expiresAt ?? "") }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

function readLoginsFile(configDir: string): LoginsFile {
  const file = loginsFileOf(configDir);
  if (!existsSync(file)) return { logins: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CliError(`${file} is not the CLI's file of saved logins: remove it, and run tiehall login <url> again.`);
  }
  const logins = (parsed as Partial<LoginsFile> | null)?.logins;
  return { logins: typeof logins === "object" && logins !== null ? logins : {} };
}

/**
 * Saves a login, in place of the install's saved login if it has one, and
 * keeps every other install's. The file is written anew, readable and
 * writable only by the user, and then replaces the old one.
 */
export function saveLogin(configDir: string, login: SavedLogin): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const contents = readLoginsFile(configDir);
  contents.logins[login.url] = { accessToken: login.accessToken, refreshToken: login.refreshToken, expiresAt: login.expiresAt };
  const file = loginsFileOf(configDir);
  const written = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(written, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    // The mode a new file gets can be narrowed by the umask, never widened; this sets it whatever the umask is.
    chmodSync(written, 0o600);
    renameSync(written, file);
  } finally {
    rmSync(written, { force: true });
  }
}

/** The saved installs, one per line, as refusals list them. */
function listed(logins: readonly SavedLogin[]): string {
  return logins.map(({ url }) => `  ${url}`).join("\n");
}

/**
 * The saved login a command uses: the one --install names, the one a request
 * URL's origin picks, or the one there is; a refusal when none fits or the
 * CLI cannot tell which.
 */
export function chooseLogin(configDir: string, choice: { install?: string | undefined; requestUrl?: string | undefined }): SavedLogin {
  const logins = savedLogins(configDir);
  if (logins.length === 0) throw new CliError("The CLI is not signed in to a Tiehall install: run tiehall login <url>, with your install's URL.");
  const named = choice.install === undefined ? undefined : installUrlOf(choice.install);
  const origin = choice.requestUrl === undefined ? undefined : originOf(choice.requestUrl);
  if (named !== undefined && origin !== undefined && named !== origin) {
    throw new CliError(`${choice.requestUrl} is not on the install --install names, ${named}, so the CLI sends nothing.`);
  }
  const wanted = named ?? origin;
  if (wanted !== undefined) {
    const login = logins.find(({ url }) => url === wanted);
    if (login !== undefined) return login;
    if (named !== undefined) throw new CliError(`The CLI has no saved login for ${named}: run tiehall login ${named} first. It has saved logins for:\n${listed(logins)}`);
    throw new CliError(`${choice.requestUrl} is not on an install the CLI is signed in to, so it sends nothing there. It has saved logins for:\n${listed(logins)}`);
  }
  const [only, ...others] = logins;
  if (only !== undefined && others.length === 0) return only;
  throw new CliError(`The CLI has saved logins for several installs, so the command names the one it is for with --install <url>:\n${listed(logins)}`);
}

/** A request URL's origin; a value that is no http or https URL gives none, as a request key does. */
function originOf(value: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`${value} is neither a request key, such as FE-142, nor a request's URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CliError(`${value} is neither a request key, such as FE-142, nor a request's URL.`);
  return url.origin;
}

/**
 * Runs `work` while this process holds the lock of the saved logins, so two
 * CLIs, such as a hook and an agent's command, never use one refresh token
 * twice: a refresh token is good for one refresh.
 */
export function withLoginsLock<T>(configDir: string, sleep: (milliseconds: number) => Promise<void>, work: () => Promise<T>): Promise<T> {
  return withFileLock(configDir, "logins.lock", sleep, work);
}

/**
 * Runs `work` while this process holds the lock of this name in the CLI's
 * configuration folder, a file only one process can create. A lock left by a
 * process that stopped is taken over after 30 seconds.
 */
export async function withFileLock<T>(configDir: string, name: string, sleep: (milliseconds: number) => Promise<void>, work: () => Promise<T>): Promise<T> {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const lock = join(configDir, name);
  for (let attempt = 0; ; attempt += 1) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      const since = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if (since !== undefined && Date.now() - since > 30_000) rmSync(lock, { force: true });
      else if (attempt >= 100) throw new CliError(`Another tiehall command holds ${lock}; if none is running, remove it.`);
      else await sleep(100);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
  }
}

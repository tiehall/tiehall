import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, type CliEnvironment } from "./environment.ts";

// The CLI's saved logins (agent-surfaces: CLI request commands; agent-access:
// The CLI keeps its token readable only by the user; design.md, Self-hosting
// decisions: S15). `tiehall login <url>` keeps one saved login per install
// URL in `logins.json`, in the CLI's configuration folder: the access token,
// the refresh token and when the access token expires. The folder is the one
// TIEHALL_CONFIG_DIR names, or `tiehall` in XDG_CONFIG_HOME, in APPDATA on
// Windows, or in ~/.config.

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

/** Every saved login, in the order of their URLs. */
export function savedLogins(configDir: string): SavedLogin[] {
  const file = loginsFileOf(configDir);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CliError(`${file} is not the CLI's file of saved logins: remove it, and run tiehall login <url> again.`);
  }
  const logins = (parsed as Partial<LoginsFile> | null)?.logins;
  if (typeof logins !== "object" || logins === null) return [];
  return Object.entries(logins)
    .filter(([, login]) => typeof login?.accessToken === "string" && typeof login.refreshToken === "string")
    .map(([url, login]) => ({ url, accessToken: login.accessToken, refreshToken: login.refreshToken, expiresAt: String(login.expiresAt ?? "") }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/** The saved login a command uses: the one there is. */
export function loginToUse(configDir: string): SavedLogin {
  const logins = savedLogins(configDir);
  const [only, ...others] = logins;
  if (only === undefined) throw new CliError("The CLI is not signed in to a Tiehall install: run tiehall login <url>, with your install's URL.");
  if (others.length > 0) {
    throw new CliError(
      ["The CLI is signed in to several installs, so a command names the one it is for with --install <url>. The saved installs are:", ...logins.map(({ url }) => `  ${url}`)].join("\n"),
    );
  }
  return only;
}

import { createTiehallClient, type TiehallClient } from "@tiehall/client";
import { UnreachableError, type CliEnvironment } from "./environment.ts";
import { configDirOf, type SavedLogin } from "./logins.ts";
import { expiresSoon, isRedirect, redirectRefusal, refreshLogin } from "./oauth.ts";
import { CLI_VERSION, CLI_VERSION_HEADER } from "./version.ts";

// The calls of one command to its install (agent-surfaces: CLI request
// commands; agent-access: Access tokens live 10 minutes and refresh tokens
// rotate; design.md, Technical decisions: T7 and T15). Each call carries the
// saved login's access token and the CLI's version, never follows a redirect,
// and is answered with its status, its headers and its JSON body. An access
// token that has expired, or expires within a minute, is refreshed first, and
// one the install refuses with 401 is refreshed once and the call sent again.
// A command that makes a call or two refreshes at most once; one that runs
// for long, such as the Stop hook's waiter, whose 30 minutes outlast an access
// token, refreshes whenever its token expires, but still only once for each
// call the install refuses.

/** A client of the saved login's install, which sends its token and says which CLI calls. */
function clientFor(environment: CliEnvironment, login: SavedLogin): TiehallClient {
  return createTiehallClient({
    baseUrl: login.url,
    headers: { authorization: `Bearer ${login.accessToken}`, "user-agent": `tiehall/${CLI_VERSION}`, [CLI_VERSION_HEADER]: CLI_VERSION },
    // Redirects are not followed (isRedirect()): the call is answered with the redirect itself.
    fetch: (request) => (environment.fetch ?? fetch)(new Request(request, { redirect: "manual" })),
  });
}

/** What the install answered: its status, its headers and its JSON body. */
export interface Answer {
  ok: boolean;
  status: number;
  headers: Headers;
  body: unknown;
}

export type Call = (client: TiehallClient) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

/** The calls of one command to its install, with the saved login's tokens, refreshed when they expire. */
export interface Session {
  /** The install's URL. */
  readonly url: string;
  send(call: Call): Promise<Answer>;
}

export function sessionFor(environment: CliEnvironment, saved: SavedLogin, { longRunning = false }: { longRunning?: boolean } = {}): Session {
  const configDir = configDirOf(environment.env);
  let login = saved;
  let refreshed = false;
  const once = async (call: Call): Promise<Answer> => {
    let answered: { data?: unknown; error?: unknown; response: Response };
    try {
      answered = await call(clientFor(environment, login));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new UnreachableError(`The CLI could not reach ${login.url}: ${why}`);
    }
    const { response } = answered;
    if (isRedirect(response)) throw redirectRefusal(login.url);
    return { ok: response.ok, status: response.status, headers: response.headers, body: response.ok ? answered.data : answered.error };
  };
  return {
    url: saved.url,
    async send(call) {
      let refreshedNow = false;
      if ((longRunning || !refreshed) && expiresSoon(environment, login)) {
        login = await refreshLogin(environment, configDir, login);
        refreshed = refreshedNow = true;
      }
      const answer = await once(call);
      // An access token the install no longer takes, such as one it refused before it expired, is refreshed once.
      if (answer.status !== 401 || (longRunning ? refreshedNow : refreshed)) return answer;
      login = await refreshLogin(environment, configDir, login);
      refreshed = true;
      return once(call);
    },
  };
}

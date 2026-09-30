import { COMMAND_TABLE, createTiehallClient, type CommandEntry, type TiehallClient } from "@tiehall/client";
import { callOf, optionOf, optionsOf } from "./arguments.ts";
import { CliError, type CliEnvironment } from "./environment.ts";
import { configDirOf, loginToUse, type SavedLogin } from "./logins.ts";
import { answerText, isProblem, problemText } from "./output.ts";
import { CLI_VERSION } from "./version.ts";

// The tiehall CLI (agent-surfaces: The CLI package; agent-surfaces: CLI
// request commands; public-api: The license map; design.md, Technical
// decisions: T3; design.md, Self-hosting decisions: S16). Its request
// commands come from the command table of @tiehall/client, which is generated
// from the OpenAPI document, so the Apache-2.0 CLI never imports the command
// catalog: each runs the operation behind its MCP tool over /api/v1, with the
// access token of the install's saved login, and prints the answer as fenced
// text, or with --json as JSON. Every command also takes --help, and `tiehall
// --help` lists the commands.

/** The options every command takes. */
interface Globals {
  json: boolean;
  help: boolean;
  version: boolean;
}

/** Runs one `tiehall` command; returns its exit code: 0 once it has done what it was asked, 1 otherwise. */
export async function run(environment: CliEnvironment): Promise<number> {
  try {
    return await dispatch(environment);
  } catch (error) {
    if (error instanceof CliError) {
      environment.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function dispatch(environment: CliEnvironment): Promise<number> {
  const { globals, words, rest } = parseGlobals(environment.argv);
  if (globals.version) {
    environment.stdout(`tiehall ${CLI_VERSION}\n`);
    return 0;
  }
  const entry = COMMAND_TABLE.find(({ command }) => command === words.join(" "));
  if (words.length === 0 || words[0] === "help") {
    environment.stdout(overview());
    return words.length === 0 && !globals.help ? 1 : 0;
  }
  if (entry === undefined) throw new CliError(`tiehall has no command ${words.join(" ")}. Run tiehall --help for its commands.`);
  if (globals.help) {
    environment.stdout(commandHelp(entry));
    return 0;
  }
  const call = await callOf(entry, rest, environment.stdin ?? (async () => ""));
  const login = loginToUse(configDirOf(environment.env));
  const client = clientFor(environment, login);
  const answer = await send(environment, login, () =>
    client.request(entry.method.toLowerCase() as "get", entry.path as never, {
      params: { path: call.path, query: call.query, header: call.header },
      ...(call.body === undefined ? {} : { body: call.body }),
    } as never),
  );
  if (!answer.ok) return refused(environment, globals, answer.body, answer.status);
  // Text is fenced by origin, which the teams the user belongs to decide, as the install says.
  const reader = globals.json ? undefined : { teams: await teamsOf(environment, login, client) };
  environment.stdout(answerText(entry.operationId, answer.body, reader));
  return 0;
}

/** The options every command takes, and the rest: the command's words, then its own arguments. */
function parseGlobals(argv: readonly string[]): { globals: Globals; words: string[]; rest: string[] } {
  const globals: Globals = { json: false, help: false, version: false };
  const others: string[] = [];
  let ended = false;
  for (const token of argv) {
    if (ended) others.push(token);
    else if (token === "--") {
      ended = true;
      others.push(token);
    } else if (token === "--json") globals.json = true;
    else if (token === "--help" || token === "-h") globals.help = true;
    else if (token === "--version") globals.version = true;
    else others.push(token);
  }
  // The command is its longest run of leading words that names one, such as "contract report".
  const leading: string[] = [];
  for (const token of others) {
    if (token.startsWith("-")) break;
    leading.push(token);
  }
  const names = new Set(COMMAND_TABLE.map(({ command }) => command));
  let length = Math.min(1, leading.length);
  for (let words = leading.length; words > 1; words -= 1) {
    if (names.has(leading.slice(0, words).join(" "))) {
      length = words;
      break;
    }
  }
  return { globals, words: leading.slice(0, length), rest: others.slice(length) };
}

/** A client of the saved login's install, which sends its token and says which CLI calls. */
function clientFor(environment: CliEnvironment, login: SavedLogin): TiehallClient {
  return createTiehallClient({
    baseUrl: login.url,
    headers: { authorization: `Bearer ${login.accessToken}`, "user-agent": `tiehall/${CLI_VERSION}` },
    fetch: (request) => (environment.fetch ?? fetch)(request),
  });
}

/** What the install answered: its status and its JSON body. */
interface Answer {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Makes a call and reads its answer; an install that cannot be reached is the CLI's own refusal. */
async function send(
  _environment: CliEnvironment,
  login: SavedLogin,
  call: () => Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<Answer> {
  let answered: { data?: unknown; error?: unknown; response: Response };
  try {
    answered = await call();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new CliError(`The CLI could not reach ${login.url}: ${why}`);
  }
  const { response } = answered;
  return { ok: response.ok, status: response.status, body: response.ok ? answered.data : answered.error };
}

/** Prints a refusal: the problem the install answered with, or what the CLI can say of an answer that is none. */
function refused(environment: CliEnvironment, globals: Globals, body: unknown, status: number): number {
  if (globals.json && isProblem(body)) environment.stdout(`${JSON.stringify(body, null, 2)}\n`);
  else if (isProblem(body)) environment.stderr(problemText(body));
  else environment.stderr(`The install answered with HTTP ${status}, and no problem the CLI can show.\n`);
  return 1;
}

/** The keys of the teams the user belongs to, as the install says. */
async function teamsOf(environment: CliEnvironment, login: SavedLogin, client: TiehallClient): Promise<string[]> {
  const answer = await send(environment, login, () => client.GET("/api/v1/whoami"));
  if (!answer.ok) {
    throw new CliError(isProblem(answer.body) ? problemText(answer.body).trimEnd() : `The install answered whoami with HTTP ${answer.status}.`);
  }
  return ((answer.body as { teams?: { key: string }[] }).teams ?? []).map(({ key }) => key);
}

/** The usage of a command: its name and its positional arguments. */
function usageOf(entry: CommandEntry): string {
  return [`tiehall ${entry.command}`, ...entry.arguments.map((name) => `<${name}>`)].join(" ");
}

/** `tiehall --help`: every command, with what it does. */
function overview(): string {
  const width = Math.max(...COMMAND_TABLE.map((entry) => usageOf(entry).length)) + 2;
  return [
    `tiehall ${CLI_VERSION}: the command line of Tiehall, for people and their agents.`,
    "",
    "Usage: tiehall <command> [arguments] [options]",
    "",
    "Commands:",
    ...COMMAND_TABLE.map((entry) => `  ${usageOf(entry).padEnd(width)}${entry.summary}`),
    "",
    "Every command takes:",
    "  --json      print the install's JSON answer instead of text",
    "  --help      show the command's arguments and options",
    "",
    "Run tiehall <command> --help for a command's arguments and options.",
    "",
  ].join("\n");
}

/** `tiehall <command> --help`: its usage, what it does, and its options. */
function commandHelp(entry: CommandEntry): string {
  const lines = [`Usage: ${usageOf(entry)} [options]`, "", entry.summary, ""];
  const options = optionsOf(entry);
  if (options.length > 0) lines.push("Options:");
  for (const field of options) {
    const type = field.values !== undefined ? field.values.filter((value) => value !== null).join(" | ") : field.types.join(" | ") || "string";
    const described = field.description === undefined ? "" : ` ${field.description}`;
    const set = Object.hasOwn(entry.defaults, field.name) ? ` ${String(entry.defaults[field.name])} unless given.` : "";
    const argument = entry.arguments.includes(field.name) ? ` Also the argument <${field.name}>.` : "";
    lines.push(`  ${optionOf(field.name)} <${type}>${field.required ? " (required)" : ""}:${described}${set}${argument}`);
  }
  lines.push("  --json: print the install's JSON answer instead of text.", "");
  return lines.join("\n");
}

import { COMMAND_TABLE, type CommandEntry } from "@tiehall/client";
import { forgetAnnounced } from "./announced.ts";
import { callOf, optionOf, optionsOf, type CommandCall } from "./arguments.ts";
import { CliError, type CliEnvironment } from "./environment.ts";
import { HOOK_COMMANDS, hookSessionEnd, hookSessionStart, hookWait } from "./hooks.ts";
import { chooseLogin, configDirOf, installUrlOf } from "./logins.ts";
import { logIn } from "./oauth.ts";
import { answerText, isProblem, problemText } from "./output.ts";
import { sessionFor, type Session } from "./session.ts";
import { watch } from "./watch.ts";
import { CLI_VERSION } from "./version.ts";

// The tiehall CLI (agent-surfaces: The CLI package; agent-surfaces: CLI
// request commands; public-api: The license map; design.md, Technical
// decisions: T3; design.md, Self-hosting decisions: S15, S16). Its request
// commands come from the command table of @tiehall/client, which is generated
// from the OpenAPI document, so the Apache-2.0 CLI never imports the command
// catalog: each runs the operation behind its MCP tool over /api/v1, with the
// access token of the saved login of the install it is for, and prints the
// answer as fenced text, or with --json as JSON. `tiehall login <url>` signs
// in to an install. Every command also takes --install <url>, which names the
// install when the CLI is signed in to several, and --help, and `tiehall
// --help` lists the commands.

/** The options every command takes. */
interface Globals {
  json: boolean;
  help: boolean;
  version: boolean;
  /** The install --install names, as given. */
  install?: string;
}

/** The commands the CLI has besides the request commands of the command table, with their usage and what they do. */
const OWN_COMMANDS: readonly { usage: string; summary: string }[] = [
  { usage: "tiehall login <url>", summary: "Sign in to the Tiehall install at this URL, through its approval page, and keep the login: one per install." },
];

/** The commands that run until they are stopped, with their usage and what they do. */
const RUNNING: readonly { usage: string; summary: string }[] = [
  {
    usage: "tiehall watch",
    summary:
      "Print a line for each new update on your requests, with its request key, event type, team and URL, until you stop it; it acknowledges nothing. The Claude Code plugin can run it as a monitor.",
  },
];

/** The commands that serve the Claude Code plugin's hooks, which `tiehall hook` lists. */
const HOOKS: readonly { usage: string; summary: string }[] = HOOK_COMMANDS.map(({ command, summary }) => ({ usage: `tiehall ${command}`, summary }));

/** The names of the CLI's own commands of more than one word, and the words that lead to them, such as "hook". */
const OWN_NAMES: readonly string[] = ["hook", ...HOOK_COMMANDS.map(({ command }) => command)];

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
  if (words.length === 0 || words[0] === "help") {
    environment.stdout(overview());
    return words.length === 0 && !globals.help ? 1 : 0;
  }
  if (words.join(" ") === "login") return login(environment, globals, rest);
  if (words[0] === "hook") return hook(environment, globals, words.join(" "));
  if (words.join(" ") === "watch") {
    if (globals.help) {
      environment.stdout(listing("Usage: tiehall watch [--install <url>]\n", RUNNING));
      return 0;
    }
    if (rest.length > 0) throw new CliError("tiehall watch takes no arguments: tiehall watch [--install <url>].");
    return watch(environment, globals.install);
  }
  const entry = COMMAND_TABLE.find(({ command }) => command === words.join(" "));
  if (entry === undefined) throw new CliError(`tiehall has no command ${words.join(" ")}. Run tiehall --help for its commands.`);
  if (globals.help) {
    environment.stdout(commandHelp(entry));
    return 0;
  }
  const call = await callOf(entry, rest, environment.stdin ?? (async () => ""));
  const session = sessionFor(environment, chooseLogin(configDirOf(environment.env), { install: globals.install, requestUrl: requestOf(call) }));
  const answer = await session.send((client) =>
    client.request(entry.method.toLowerCase() as "get", entry.path as never, {
      params: { path: call.path, query: call.query, header: call.header },
      ...(call.body === undefined ? {} : { body: call.body }),
    } as never),
  );
  if (!answer.ok) return refused(environment, globals, answer.body, answer.status);
  // Text is fenced by origin, which the teams the user belongs to decide, as the install says.
  const reader = globals.json ? undefined : { teams: await teamsOf(session) };
  environment.stdout(answerText(entry.operationId, answer.body, reader));
  return 0;
}

/**
 * `tiehall hook <name>`: the command a hook of the Claude Code plugin runs,
 * which writes only what the hook passes on to Claude; `tiehall hook` lists
 * them.
 */
async function hook(environment: CliEnvironment, globals: Globals, command: string): Promise<number> {
  if (command === "hook" || globals.help) {
    const found = HOOKS.filter(({ usage }) => command === "hook" || usage === `tiehall ${command}`);
    environment.stdout(listing("Usage: tiehall hook <name>\n\nThe commands the Claude Code plugin's hooks run:", found.length > 0 ? found : HOOKS));
    return command === "hook" && !globals.help ? 1 : 0;
  }
  if (command === "hook session-start") return hookSessionStart(environment, globals.install);
  if (command === "hook wait") return hookWait(environment, globals.install);
  if (command === "hook session-end") return hookSessionEnd(environment);
  return 0;
}

/** A heading and commands, each with what it does, in two columns. */
function listing(heading: string, commands: readonly { usage: string; summary: string }[]): string {
  const width = Math.max(...commands.map(({ usage }) => usage.length)) + 2;
  return [heading, ...commands.map(({ usage, summary }) => `  ${usage.padEnd(width)}${summary}`), ""].join("\n");
}

/** `tiehall login <url>`: signs in to the install at that URL, and keeps the login. */
async function login(environment: CliEnvironment, globals: Globals, rest: readonly string[]): Promise<number> {
  if (globals.help) {
    environment.stdout(
      "Usage: tiehall login <url>\n\n" +
        "Signs in to the Tiehall install at <url>, such as https://tiehall.example.com: you type the code the CLI prints on the install's approval page, " +
        "in a browser where you are signed in to Tiehall. The CLI keeps one login per install, in a file only you can read.\n",
    );
    return 0;
  }
  const [raw, ...others] = rest;
  if (raw === undefined || others.length > 0 || raw.startsWith("-")) throw new CliError("tiehall login takes one argument, the install's URL: tiehall login <url>.");
  const url = installUrlOf(raw);
  const configDir = configDirOf(environment.env);
  await logIn(environment, configDir, url);
  // The hooks' mark of the news announced starts anew, since this login may be another user's (requester-loop: News is announced once).
  await forgetAnnounced(configDir, url);
  environment.stdout(`Signed in to ${url}.\n`);
  return 0;
}

/**
 * The request URL a command is given, whose origin picks the install: the
 * value of its operation's field named request, as get_request's is, when
 * that is a URL rather than a key.
 */
function requestOf(call: CommandCall): string | undefined {
  const value = call.path["request"] ?? call.query["request"] ?? call.body?.["request"];
  return typeof value === "string" && /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : undefined;
}

/** The options every command takes, and the rest: the command's words, then its own arguments. */
function parseGlobals(argv: readonly string[]): { globals: Globals; words: string[]; rest: string[] } {
  const globals: Globals = { json: false, help: false, version: false };
  const others: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      others.push(...argv.slice(index));
      break;
    }
    if (token === "--json") globals.json = true;
    else if (token === "--help" || token === "-h") globals.help = true;
    else if (token === "--version") globals.version = true;
    else if (token === "--install" || token.startsWith("--install=")) {
      if (globals.install !== undefined) throw new CliError("--install is given once.");
      const value = token === "--install" ? argv[(index += 1)] : token.slice("--install=".length);
      if (value === undefined || value === "") throw new CliError("--install needs the install's URL: --install <url>.");
      globals.install = value;
    } else others.push(token);
  }
  // The command is its longest run of leading words that names one, such as "contract report".
  const leading: string[] = [];
  for (const token of others) {
    if (token.startsWith("-")) break;
    leading.push(token);
  }
  const names = new Set([...COMMAND_TABLE.map(({ command }) => command), ...OWN_NAMES]);
  let length = Math.min(1, leading.length);
  for (let words = leading.length; words > 1; words -= 1) {
    if (names.has(leading.slice(0, words).join(" "))) {
      length = words;
      break;
    }
  }
  return { globals, words: leading.slice(0, length), rest: others.slice(length) };
}

/** Prints a refusal: the problem the install answered with, or what the CLI can say of an answer that is none. */
function refused(environment: CliEnvironment, globals: Globals, body: unknown, status: number): number {
  if (globals.json && isProblem(body)) environment.stdout(`${JSON.stringify(body, null, 2)}\n`);
  else if (isProblem(body)) environment.stderr(problemText(body));
  else environment.stderr(`The install answered with HTTP ${status}, and no problem the CLI can show.\n`);
  return 1;
}

/** The keys of the teams the user belongs to, as the install says. */
async function teamsOf(session: Session): Promise<string[]> {
  const answer = await session.send((client) => client.GET("/api/v1/whoami"));
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
  const commands = [...OWN_COMMANDS, ...COMMAND_TABLE.map((entry) => ({ usage: usageOf(entry), summary: entry.summary })), ...RUNNING, ...HOOKS];
  const width = Math.max(...commands.map(({ usage }) => usage.length)) + 2;
  return [
    `tiehall ${CLI_VERSION}: the command line of Tiehall, for people and their agents.`,
    "",
    "Usage: tiehall <command> [arguments] [options]",
    "",
    "Commands:",
    ...commands.map(({ usage, summary }) => `  ${usage.padEnd(width)}${summary}`),
    "",
    "Every command takes:",
    "  --json            print the install's JSON answer instead of text",
    "  --install <url>   the install the command is for, when the CLI is signed in to several",
    "  --help            show the command's arguments and options",
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

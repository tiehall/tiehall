import { readFileSync } from "node:fs";
import { COMMAND_TABLE } from "@tiehall/client";
import { CliError, type CliEnvironment } from "./environment.ts";
import { installUrlOf } from "./logins.ts";
import { isProblem, problemText } from "./output.ts";
import { CLI_VERSION } from "./version.ts";

// tiehall contract report, the step the contract Action calls (agent-surfaces:
// CLI contract and hook commands; contract-changes: One report operation that
// never takes a whole spec; contract-changes: The Action reports to the
// install its workflow names; agent-access: CI authenticates with GitHub
// Actions OIDC bound to registered repositories; design.md, Technical
// decisions: T12). In the provider's CI, the Action runs the pinned diff
// engine on the pull request's base and head and hands this command the
// engine's changelog, as `oasdiff changelog --format json` writes it. The
// command reports it, through contract.report, to the install that --install
// names, which needs no saved login:
// - the registered API, from --api;
// - the pull request's number and its base and head refs and commit SHAs,
//   from the pull_request event GitHub Actions hands the run at
//   GITHUB_EVENT_PATH, unless --pull-request, --base-ref, --base-sha,
//   --head-ref and --head-sha name them;
// - the engine's name, oasdiff unless --engine names another, and its
//   version, from --engine-version;
// - each change the engine classified, by the engine's id for it, its level
//   (the engine's 3, 2 and 1 are ERR, WARN and INFO) and the operation it
//   touches, such as GET /payments/{id}, or the section of the document for a
//   change that touches none.
// It sends no OpenAPI document and none of the engine's own text about a
// change, which quotes the document. It authenticates with the run's GitHub
// Actions OIDC token, which it asks GitHub Actions for with the install's URL
// as its audience; a job gets one only when its permissions include
// id-token: write. Like every call of the CLI, the report names the CLI's
// version, which contract.report holds to its own floor. On success it says
// what it reported, or, with --json, prints the install's JSON answer; a
// refusal of the install is printed as the install wrote it, and a refusal,
// an install it cannot reach and a mistake in its input each end the run with
// 1, which the Action reads to fail open.

/** The commands of `tiehall contract`, with their usage and what they do. */
export const CONTRACT_COMMANDS: readonly { command: string; usage: string; summary: string }[] = [
  {
    command: "contract report",
    usage: "tiehall contract report --install <url> --api <name> --changes <file> --engine-version <version>",
    summary:
      "Report the classified changes of a pull request to a registered API, from the changelog of the diff engine, in a GitHub Actions job with id-token: write: the step the contract Action runs. It sends no OpenAPI document.",
  },
];

/** The options `tiehall contract report` takes, besides the global ones, each with what it gives. */
const REPORT_OPTIONS: Readonly<Record<string, string>> = {
  "--api": "The registered API the changes are to, such as payments-api.",
  "--changes": "The diff engine's changelog, as `oasdiff changelog --format json` writes it: a file, or - for standard input.",
  "--engine": "The diff engine's name; oasdiff unless given.",
  "--engine-version": "The diff engine's version, such as 1.32.1.",
  "--pull-request": "The pull request's number; the GitHub Actions event's unless given.",
  "--base-ref": "The pull request's base branch; the event's unless given.",
  "--base-sha": "The commit of its base; the event's unless given.",
  "--head-ref": "The pull request's head branch; the event's unless given.",
  "--head-sha": "The commit of its head; the event's unless given.",
};

/** `tiehall contract report --help`. */
export function contractReportHelp(): string {
  const [entry] = CONTRACT_COMMANDS;
  return [
    `Usage: ${entry?.usage ?? ""} [options]`,
    "",
    entry?.summary ?? "",
    "",
    "Options:",
    "  --install <url>: the Tiehall install to report to, such as https://tiehall.example.com (required).",
    ...Object.entries(REPORT_OPTIONS).map(([option, text]) => `  ${option} <value>: ${text}`),
    "  --json: print the install's JSON answer instead of text.",
    "",
  ].join("\n");
}

/** The levels the diff engine writes in its JSON, as a report names them. */
const LEVELS: Readonly<Record<number, "ERR" | "WARN" | "INFO">> = { 3: "ERR", 2: "WARN", 1: "INFO" };

/** A change as the report carries it. */
interface ClassifiedChange {
  id: string;
  level: "ERR" | "WARN" | "INFO";
  operation: string;
}

/** The options a run names, by option, each once. */
function optionsOf(tokens: readonly string[]): Map<string, string> {
  const given = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const equals = token.indexOf("=");
    const name = token.startsWith("--") && equals !== -1 ? token.slice(0, equals) : token;
    if (!Object.hasOwn(REPORT_OPTIONS, name)) {
      throw new CliError(`tiehall contract report takes no ${name.startsWith("-") ? `option ${name}` : `argument ${name}`}. Run tiehall contract report --help for its options.`);
    }
    if (given.has(name)) throw new CliError(`tiehall contract report takes ${name} once.`);
    const value = equals !== -1 && token.startsWith("--") ? token.slice(equals + 1) : tokens[(index += 1)];
    if (value === undefined || value === "") throw new CliError(`${name} needs a value.`);
    given.set(name, value);
  }
  return given;
}

/** The changes of the diff engine's changelog, as the report carries them; a file that is not one is refused. */
function changesOf(text: string): ClassifiedChange[] {
  const refusal = new CliError("--changes names the diff engine's changelog, a JSON list as `oasdiff changelog --format json` writes it.");
  let changelog: unknown;
  try {
    changelog = JSON.parse(text);
  } catch {
    throw refusal;
  }
  if (!Array.isArray(changelog)) throw refusal;
  return changelog.map((entry: unknown) => {
    const { id, level, operation, path, section } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const named = typeof level === "number" ? LEVELS[level] : undefined;
    if (typeof id !== "string" || id === "" || named === undefined) throw refusal;
    const touches =
      typeof operation === "string" && typeof path === "string"
        ? `${operation} ${path}`
        : typeof path === "string"
          ? path
          : typeof section === "string"
            ? `the ${section} section`
            : "the document";
    return { id, level: named, operation: touches };
  });
}

/** The pull_request event GitHub Actions hands the run, or nothing when it hands none or another event. */
function pullRequestEvent(environment: CliEnvironment): { number?: unknown; base?: { ref?: unknown; sha?: unknown }; head?: { ref?: unknown; sha?: unknown } } {
  const path = environment.env["GITHUB_EVENT_PATH"];
  if (path === undefined || path === "") return {};
  try {
    const event = JSON.parse(readFileSync(path, "utf8")) as { pull_request?: unknown };
    return typeof event.pull_request === "object" && event.pull_request !== null ? (event.pull_request as never) : {};
  } catch {
    throw new CliError(`GITHUB_EVENT_PATH names ${path}, which holds no GitHub Actions event this command can read.`);
  }
}

/** A value from an option, or else from the event, or the refusal that names the option. */
function required(given: string | undefined, fromEvent: unknown, option: string): string {
  const value = given ?? (typeof fromEvent === "string" || typeof fromEvent === "number" ? String(fromEvent) : undefined);
  if (value === undefined || value === "") {
    throw new CliError(`tiehall contract report needs ${option}, which a pull_request event of GitHub Actions gives it; name it with ${option} where the run has no such event.`);
  }
  return value;
}

/** The run's GitHub Actions OIDC token, with this audience, as GitHub Actions gives it to a job that may request one. */
async function oidcToken(environment: CliEnvironment, audience: string): Promise<string> {
  const url = environment.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const token = environment.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (url === undefined || url === "" || token === undefined || token === "") {
    throw new CliError(
      "tiehall contract report authenticates with the run's GitHub Actions OIDC token, which GitHub Actions gives only to a job whose permissions include id-token: write. Run it in such a job, as the contract Action does.",
    );
  }
  const request = new URL(url);
  request.searchParams.set("audience", audience);
  const fetchOf = environment.fetch ?? ((call: Request) => fetch(call));
  let answer: Response;
  try {
    answer = await fetchOf(new Request(request, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }));
  } catch {
    throw new CliError("GitHub Actions did not give the run its OIDC token: its token service could not be reached.");
  }
  const body = (await answer.json().catch(() => undefined)) as { value?: unknown } | undefined;
  if (!answer.ok || typeof body?.value !== "string" || body.value === "") {
    throw new CliError(`GitHub Actions did not give the run its OIDC token: its token service answered with HTTP ${answer.status}.`);
  }
  return body.value;
}

/** "1 X" or "N Xs", or "no X". */
function counted(count: number, what: string): string {
  return count === 0 ? `no ${what}` : `${count} ${what}${count === 1 ? "" : "s"}`;
}

/** Runs `tiehall contract report` with the options after it; returns the exit code. */
export async function contractReport(environment: CliEnvironment, globals: { json: boolean; install?: string }, rest: readonly string[]): Promise<number> {
  const options = optionsOf(rest);
  if (globals.install === undefined) throw new CliError("tiehall contract report needs --install <url>, the URL of the Tiehall install to report to.");
  const install = installUrlOf(globals.install);
  const api = options.get("--api");
  if (api === undefined) throw new CliError("tiehall contract report needs --api <name>, the registered API the changes are to.");
  const engineVersion = options.get("--engine-version");
  if (engineVersion === undefined) throw new CliError("tiehall contract report needs --engine-version <version>, the version of the diff engine that classified the changes.");
  const source = options.get("--changes");
  if (source === undefined) throw new CliError("tiehall contract report needs --changes <file>, the diff engine's changelog, or - for standard input.");
  let text: string;
  try {
    text = source === "-" ? await (environment.stdin ?? (async () => ""))() : readFileSync(source, "utf8");
  } catch {
    throw new CliError(`--changes names ${source}, which cannot be read; it names the diff engine's changelog.`);
  }
  const changes = changesOf(text);
  const event = pullRequestEvent(environment);
  const number = required(options.get("--pull-request"), event.number, "--pull-request");
  if (!/^[1-9][0-9]{0,9}$/.test(number)) throw new CliError("--pull-request names the pull request's number, such as 310.");
  const report = {
    api,
    pullRequest: { number: Number(number) },
    base: { ref: required(options.get("--base-ref"), event.base?.ref, "--base-ref"), sha: required(options.get("--base-sha"), event.base?.sha, "--base-sha") },
    head: { ref: required(options.get("--head-ref"), event.head?.ref, "--head-ref"), sha: required(options.get("--head-sha"), event.head?.sha, "--head-sha") },
    engine: { name: options.get("--engine") ?? "oasdiff", version: engineVersion },
    changes,
  };
  // The operation's method and path, as the install's document names them.
  const operation = COMMAND_TABLE.find(({ operationId }) => operationId === "contract.report");
  if (operation === undefined) throw new Error("The CLI's command table has no contract.report.");
  const token = await oidcToken(environment, install);
  const fetchOf = environment.fetch ?? ((call: Request) => fetch(call));
  let answer: Response;
  try {
    answer = await fetchOf(
      new Request(new URL(operation.path, install), {
        method: operation.method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "tiehall-cli-version": CLI_VERSION },
        body: JSON.stringify(report),
      }),
    );
  } catch {
    throw new CliError(`Tiehall at ${install} could not be reached, so the report was not delivered.`);
  }
  const body: unknown = await answer.json().catch(() => undefined);
  if (!answer.ok) {
    if (globals.json && isProblem(body)) environment.stdout(`${JSON.stringify(body, null, 2)}\n`);
    else if (isProblem(body)) environment.stderr(problemText(body));
    else environment.stderr(`Tiehall at ${install} answered the report with HTTP ${answer.status}, and no problem the CLI can show.\n`);
    return 1;
  }
  if (globals.json) {
    environment.stdout(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }
  const taken = typeof (body as { id?: unknown } | undefined)?.id === "string" ? ` Tiehall took it as report ${(body as { id: string }).id}.` : "";
  const levels = (level: ClassifiedChange["level"]) => changes.filter((change) => change.level === level).length;
  const summary =
    changes.length === 0
      ? `Reported no classified change of ${api} in pull request #${number} to ${install}.`
      : `Reported ${counted(changes.length, "classified change")} of ${api} in pull request #${number} to ${install}: ${levels("ERR")} breaking, ${levels("WARN")} potentially breaking and ${levels("INFO")} informational.`;
  environment.stdout(`${summary}${taken}\n`);
  return 0;
}

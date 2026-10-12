import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { COMMAND_TABLE } from "@tiehall/client";
import { changesOf, contractOptionsOf, CONTRACT_COMMANDS } from "./contract.ts";
import { CliError, type CliEnvironment } from "./environment.ts";
import { chooseLogin, configDirOf } from "./logins.ts";
import { answerText, contractDiffFailureOutput, contractDiffOutput, isProblem, problemText } from "./output.ts";
import { sessionFor } from "./session.ts";
import { OASDIFF_MINIMUM } from "./version.ts";

// tiehall contract diff (contract-changes: Attaching a contract diff to a
// request by hand; agent-surfaces: CLI contract and hook commands; design.md,
// Decisions this change rests on: D14; D28 #77; design.md, Technical
// decisions: T12). It runs on the developer's own machine, in their
// repository: it refuses a diff engine on the PATH older than the oasdiff
// release Tiehall pins, reads the OpenAPI document at two refs with git, has
// oasdiff classify every change between them, `oasdiff changelog --format
// json` with external $refs off, in a folder of its own, and prints the
// classified changes: each change's engine id, its level and the operation it
// touches, as a contract report carries them. What it prints goes through the
// one renderer (agent-safety: Every string shown to agents has an origin):
// the API and the refs the developer named, the changes the document gave and
// what a failing engine wrote are external text, fenced, since a
// contributor's pull request writes the document; with --json, the contract
// section sits under `untrusted`, stripped. With --attach <key> it attaches
// them to that request as the contract section of its packet, with the
// developer's saved login, through the operation behind
// attach_contract_changes, naming the revision it expects with --if-match, as
// a packet change does; the section names the provider pull request,
// --pull-request in the repository of the git remote origin unless
// --repository names another, or, without --pull-request, no pull request
// and no provider status, since the two refs may be in no pull request yet
// (decisions-from-groups-15-28, D55 (63)). Attaching routes nothing to the API's
// consumers, and no document leaves the machine: the install gets the
// classified changes alone.

/** The options `tiehall contract diff` takes, besides the global ones, each with what it gives. */
const DIFF_OPTIONS: Readonly<Record<string, string>> = {
  "--api": "The registered API the document describes, such as payments-api (required).",
  "--spec": "The API's OpenAPI document in the repository, relative to its root, such as openapi/payments.yaml (required).",
  "--base": "The ref the changes are compared against, such as main (required).",
  "--head": "The ref that makes the changes; HEAD unless given.",
  "--attach": "The key of a request to attach the classified changes to, as the contract section of its packet, such as FE-142.",
  "--if-match": "With --attach: the revision of the request's packet you expect to be current, as tiehall get shows it.",
  "--pull-request": "The number of the provider pull request that makes the changes, which the contract section names; without it, the section names no pull request, which a contract-change request's packet does not take.",
  "--repository": "The pull request's repository, such as acme/payments; the one of the git remote origin unless given.",
};

/** `tiehall contract diff --help`. */
export function contractDiffHelp(): string {
  const entry = CONTRACT_COMMANDS.find(({ command }) => command === "contract diff");
  return [
    `Usage: ${entry?.usage ?? ""} [options]`,
    "",
    entry?.summary ?? "",
    "",
    "Options:",
    ...Object.entries(DIFF_OPTIONS).map(([option, text]) => `  ${option} <value>: ${text}`),
    "  --install <url>: with --attach, the install the request is on, when the CLI is signed in to several.",
    "  --json: print the contract section, under untrusted, or the install's JSON answer, instead of text.",
    "",
  ].join("\n");
}

/** A version's numbers, such as [1, 32, 1]; none for text that holds no version. */
function versionOf(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether a version is older than another. */
function older(version: readonly number[], than: readonly number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if ((version[index] ?? 0) !== (than[index] ?? 0)) return (version[index] ?? 0) < (than[index] ?? 0);
  }
  return false;
}

/** The environment of the programs it runs: the run's own, so git and oasdiff are found on its PATH. */
function programEnv(environment: CliEnvironment): NodeJS.ProcessEnv {
  return { ...environment.env } as NodeJS.ProcessEnv;
}

/** The version of the diff engine on the PATH, refused when there is none or it is older than the pinned one. */
function engineVersion(environment: CliEnvironment): string {
  const where = `tiehall contract diff needs oasdiff ${OASDIFF_MINIMUM} or later on your PATH`;
  const releases = "Install it from https://github.com/oasdiff/oasdiff/releases.";
  const run = spawnSync("oasdiff", ["--version"], { encoding: "utf8", env: programEnv(environment) });
  const found = run.error === undefined && run.status === 0 ? versionOf(run.stdout) : undefined;
  if (found === undefined) throw new CliError(`${where}, and finds none. ${releases}`);
  const minimum = versionOf(OASDIFF_MINIMUM) ?? [0, 0, 0];
  if (older(found, minimum)) throw new CliError(`${where}, and finds ${found.join(".")}. ${releases}`);
  return found.join(".");
}

/** Runs git in the repository; refuses with the message when it fails. */
function git(environment: CliEnvironment, args: readonly string[], refusal: string): string {
  const run = spawnSync("git", args, { cwd: environment.cwd ?? process.cwd(), encoding: "utf8", env: programEnv(environment) });
  if (run.error !== undefined || run.status !== 0) throw new CliError(refusal);
  return run.stdout;
}

/** The commit a ref names in the repository. */
function commitOf(environment: CliEnvironment, ref: string): string {
  if (ref.startsWith("-")) throw new CliError(`${ref} is not a ref.`);
  return git(environment, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], `The repository has no ref ${ref}; name a branch, a tag or a commit it holds.`).trim();
}

/** The document at a commit. */
function documentAt(environment: CliEnvironment, sha: string, ref: string, spec: string): string {
  return git(environment, ["show", `${sha}:${spec}`], `${spec} is not in the repository at ${ref}; --spec names the document's path from the repository's root.`);
}

/** The repository of the git remote origin on GitHub, such as acme/payments. */
function originRepository(environment: CliEnvironment): string {
  const refusal = "The git remote origin is not a repository on GitHub; name the pull request's repository with --repository, such as acme/payments.";
  const url = git(environment, ["remote", "get-url", "origin"], refusal).trim();
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (match === null) throw new CliError(refusal);
  return `${match[1]}/${match[2]}`;
}

/** Runs `tiehall contract diff` with the options after it; returns the exit code. */
export async function contractDiff(environment: CliEnvironment, globals: { json: boolean; install?: string }, rest: readonly string[]): Promise<number> {
  const options = contractOptionsOf(rest, DIFF_OPTIONS, "contract diff");
  const need = (option: string, what: string) => {
    const value = options.get(option);
    if (value === undefined) throw new CliError(`tiehall contract diff needs ${option} <${what}>. Run tiehall contract diff --help for its options.`);
    return value;
  };
  const api = need("--api", "name");
  const spec = need("--spec", "path");
  const baseRef = need("--base", "ref");
  const headRef = options.get("--head") ?? "HEAD";
  const attach = options.get("--attach");
  const pullRequest = options.get("--pull-request");
  if (pullRequest !== undefined && !/^[1-9][0-9]{0,9}$/.test(pullRequest)) throw new CliError("--pull-request names the pull request's number, such as 310.");

  // The engine first: an older one runs nothing.
  const version = engineVersion(environment);
  const base = { ref: baseRef, sha: commitOf(environment, baseRef) };
  const head = { ref: headRef, sha: commitOf(environment, headRef) };
  const extension = [".json", ".yaml", ".yml"].includes(extname(spec).toLowerCase()) ? extname(spec).toLowerCase() : ".yaml";
  const work = mkdtempSync(join(tmpdir(), "tiehall-contract-diff-"));
  let changelog: string | undefined;
  let stderr = "";
  try {
    writeFileSync(join(work, `base${extension}`), documentAt(environment, base.sha, baseRef, spec));
    writeFileSync(join(work, `revision${extension}`), documentAt(environment, head.sha, headRef, spec));
    const run = spawnSync("oasdiff", ["changelog", `base${extension}`, `revision${extension}`, "--format", "json", "--allow-external-refs=false"], {
      cwd: work,
      encoding: "utf8",
      env: programEnv(environment),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error === undefined && run.status === 0) changelog = run.stdout;
    else stderr = run.stderr ?? "";
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (changelog === undefined) {
    // What the engine wrote can quote the document, so it is external text.
    environment.stderr(contractDiffFailureOutput({ engine: { name: "oasdiff", version }, base, head, untrusted: { stderr } }));
    return 1;
  }
  const changes = changesOf(changelog);
  const contract = {
    api,
    base,
    head,
    engine: { name: "oasdiff", version },
    changes,
    ...(pullRequest === undefined
      ? {}
      : { provider_pr: { repository: options.get("--repository") ?? originRepository(environment), number: Number(pullRequest) }, provider_status: "open" as const }),
  };

  if (attach === undefined) {
    environment.stdout(contractDiffOutput(contract, globals.json));
    return 0;
  }

  // Attaching, with the saved login, through the operation behind attach_contract_changes.
  const operation = COMMAND_TABLE.find(({ operationId }) => operationId === "contract.attach_changes");
  if (operation === undefined) throw new Error("The CLI's command table has no contract.attach_changes.");
  const ifMatch = options.get("--if-match");
  if (ifMatch !== undefined && !/^[1-9][0-9]{0,9}$/.test(ifMatch)) throw new CliError("--if-match names the revision you expect, such as 3.");
  const session = sessionFor(environment, chooseLogin(configDirOf(environment.env), { install: globals.install, requestUrl: undefined }));
  const answer = await session.send((client) =>
    client.request(operation.method.toLowerCase() as "post", operation.path as never, {
      params: { path: { key: attach }, ...(ifMatch === undefined ? {} : { header: { "if-match": `"${ifMatch}"` } }) },
      body: { contract },
    } as never),
  );
  if (!answer.ok) {
    if (globals.json && isProblem(answer.body)) environment.stdout(`${JSON.stringify(answer.body, null, 2)}\n`);
    else if (isProblem(answer.body)) environment.stderr(problemText(answer.body));
    else environment.stderr(`The install answered with HTTP ${answer.status}, and no problem the CLI can show.\n`);
    return 1;
  }
  environment.stdout(answerText(operation.operationId, answer.body, globals.json ? undefined : { teams: await teamsOf(session) }));
  return 0;
}

/** The keys of the teams the user belongs to, as the install says, by which the request's texts are fenced. */
async function teamsOf(session: ReturnType<typeof sessionFor>): Promise<string[]> {
  const answer = await session.send((client) => client.GET("/api/v1/whoami"));
  if (!answer.ok) return [];
  return ((answer.body as { teams?: { key: string }[] }).teams ?? []).map(({ key }) => key);
}

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, normalize } from "node:path";
import { breakingArguments, changelogArguments, ChecksumError, installOasdiff, OASDIFF, UnsupportedPlatformError } from "./oasdiff.ts";
import { annotation, appendSummary, booleanInputOf, codeBlock, inputOf, InputError, setOutputs } from "./workflow.ts";

// The contract Action (contract-changes: The contract Action;
// contract-changes: Contract diffs run only where the specs already are;
// contract-changes: One report operation that never takes a whole spec;
// design.md, Design rules: Contract changes; design.md, Technical decisions:
// T12). It runs in the provider's CI, in a workflow of the repository a
// registered API is bound to, on pull_request events of the types opened,
// synchronize, reopened and ready_for_review, and skips any other event or
// type. It skips a draft pull request unless the workflow sets include-drafts,
// so marking the pull request ready for review is what reports it. For one
// registered API and its OpenAPI document in the repository, it:
// 1. installs the pinned oasdiff, whose release archive it checks against its
//    pinned SHA-256 before it extracts or runs anything from it: a binary that
//    is not the pinned one never runs, and the step fails without a report;
// 2. reads the document at the pull request's base and head commits with git,
//    from the checkout, and writes each to a folder of its own;
// 3. runs oasdiff there on the two documents: `oasdiff breaking`, the
//    breaking changes as text, for the job summary, and `oasdiff changelog
//    --format json`, every classified change with its level, for the report;
//    external $refs are off, so oasdiff reads and fetches nothing else;
// 4. reports the changelog with the pinned tiehall CLI, `npx tiehall@<pin>
//    contract report`, which sends the API, the pull request, the refs and
//    SHAs, the engine and the classified changes, never a document. It fails
//    open (contract-changes: The Action fails open): a report Tiehall does not
//    take, for whatever reason, is said in a warning and the job summary and
//    never fails the step, and an install that asks for a newer CLI gets a
//    warning that says how to upgrade;
// 5. says what it found and reported in the job summary and its outputs, and
//    fails the step for ERR-level changes only when the workflow sets
//    fail-on-breaking.
// It uploads no document anywhere: the documents stay in the runner's
// temporary folder, which it removes, and oasdiff never runs with --open.

/** The pull_request event types the Action reports on. */
export const REPORTED_TYPES: readonly string[] = ["opened", "synchronize", "reopened", "ready_for_review"];

/** The tiehall CLI the Action reports with, pinned by version. */
export const CLI_PIN: { package: string; version: string } = (
  JSON.parse(readFileSync(new URL("../pins.json", import.meta.url), "utf8")) as { cli: { package: string; version: string } }
).cli;

/** What a program printed and how it exited. */
export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** What one run of the Action is given in place of its process's, so a test can give its own. */
export interface ActionRuntime {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs a program to its end, such as git, oasdiff or npx. */
  exec(file: string, args: readonly string[], options: { cwd: string; env: Readonly<Record<string, string | undefined>> }): Promise<ExecResult>;
  /** Sends one call, such as the oasdiff archive's download; the platform's fetch in the Action. */
  fetch(request: Request): Promise<Response>;
  /** The step's standard output, where workflow commands go. */
  stdout(text: string): void;
  readonly platform: string;
  readonly arch: string;
}

/** The pull_request event as the Action reads it. */
interface PullRequestEvent {
  action: string;
  number: number;
  draft: boolean;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}

/** A failure that ends the step with an error annotation: the workflow's setup, the engine, or its documents. */
class StepError extends Error {
  override name = "StepError";
  readonly title: string;
  constructor(title: string, message: string) {
    super(message);
    this.title = title;
  }
}

/** The classified changes of oasdiff's changelog, as their levels: 3 is ERR, 2 WARN and 1 INFO. */
interface Counts {
  errors: number;
  warnings: number;
  infos: number;
}

/** The pull_request event the runner hands the step, or why there is none to report. */
function pullRequestEventOf(env: ActionRuntime["env"]): PullRequestEvent | { skip: string } {
  const name = env["GITHUB_EVENT_NAME"] ?? "";
  if (name !== "pull_request") return { skip: `The contract Action reports on pull_request events, and this run's event is ${name === "" ? "not named" : name}.` };
  const path = env["GITHUB_EVENT_PATH"] ?? "";
  let event: { action?: unknown; number?: unknown; pull_request?: Record<string, unknown> };
  try {
    event = JSON.parse(readFileSync(path, "utf8")) as typeof event;
  } catch {
    throw new StepError("No pull_request event", "The runner handed the step no pull_request event to read at GITHUB_EVENT_PATH.");
  }
  const action = typeof event.action === "string" ? event.action : "";
  if (!REPORTED_TYPES.includes(action)) {
    return { skip: `The contract Action reports on pull requests opened, synchronized, reopened or marked ready for review, and this one was ${action === "" ? "not named" : action}.` };
  }
  const pull = event.pull_request ?? {};
  const ref = (side: unknown) => {
    const { ref: name, sha } = (typeof side === "object" && side !== null ? side : {}) as { ref?: unknown; sha?: unknown };
    if (typeof name !== "string" || typeof sha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      throw new StepError("No pull_request event", "The pull_request event names no base and head commit.");
    }
    return { ref: name, sha };
  };
  const number = pull["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new StepError("No pull_request event", "The pull_request event names no pull request number.");
  }
  return { action, number, draft: pull["draft"] === true, base: ref(pull["base"]), head: ref(pull["head"]) };
}

/**
 * The install the report goes to, by its origin, as the install-url input
 * names it (contract-changes: The Action reports to the install its workflow
 * names; design.md, Self-hosting decisions: S15): an https:// URL, or
 * http://localhost, with or without a port, for a trial install on the
 * runner's own machine, as an install's TIEHALL_URL is; with no path, query,
 * fragment or credentials. The pinned CLI then asks for the run's OIDC token
 * with this URL as its audience, and sends the report here alone. A URL that
 * is not one is refused before anything is downloaded or sent, and the
 * refusal never quotes it, since it may hold credentials.
 */
export function installUrlOf(raw: string): string {
  const refusal = new InputError(
    "The input install-url names the Tiehall install to report to by its https:// URL, such as https://tiehall.example.com, with no path, or http://localhost for a trial install on the runner's machine.",
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

/** The document's path in the repository, as the spec input names it: relative, inside the checkout. */
function specPathOf(spec: string): string {
  if (spec === "") throw new InputError("The input spec names the OpenAPI document in the repository, such as openapi/payments.yaml.");
  const path = normalize(spec).replace(/\\/g, "/");
  if (isAbsolute(spec) || path === ".." || path.startsWith("../")) {
    throw new InputError(`The input spec names a file in the repository, relative to its root, not ${JSON.stringify(spec)}.`);
  }
  return path;
}

/** The environment of git and oasdiff: the runner's PATH and HOME alone, so no setting of oasdiff's own applies. */
function toolEnv(env: ActionRuntime["env"]): Record<string, string | undefined> {
  return { PATH: env["PATH"], HOME: env["HOME"], GIT_TERMINAL_PROMPT: "0" };
}

/** The document at a commit, read with git from the checkout; undefined when the commit has no such file. */
async function documentAt(runtime: ActionRuntime, workspace: string, sha: string, spec: string): Promise<string | undefined> {
  const env = toolEnv(runtime.env);
  const has = async () => (await runtime.exec("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: workspace, env })).status === 0;
  if (!(await has())) {
    // A shallow checkout lacks the commit: fetch it alone, which works where the checkout kept its credentials or the repository is public.
    await runtime.exec("git", ["fetch", "--no-tags", "--depth=1", "origin", sha], { cwd: workspace, env });
    if (!(await has())) {
      throw new StepError(
        "Commit not in the checkout",
        `The checkout does not hold the commit ${sha}. Check the repository out with fetch-depth: 0, so both the pull request's base and head commits are there.`,
      );
    }
  }
  const listed = await runtime.exec("git", ["ls-tree", "--name-only", sha, "--", spec], { cwd: workspace, env });
  if (listed.status !== 0 || listed.stdout.trim() === "") return undefined;
  const shown = await runtime.exec("git", ["show", `${sha}:${spec}`], { cwd: workspace, env });
  if (shown.status !== 0) throw new StepError("Document not read", `git could not read ${spec} at ${sha}.`);
  return shown.stdout;
}

/** The levels of the changes in oasdiff's changelog, counted; a changelog that is not a list of changes is refused. */
function countsOf(changelog: string): Counts {
  let changes: unknown;
  try {
    changes = JSON.parse(changelog);
  } catch {
    throw new StepError("oasdiff's changelog not read", "oasdiff's changelog is not JSON.");
  }
  if (!Array.isArray(changes)) throw new StepError("oasdiff's changelog not read", "oasdiff's changelog is not a list of changes.");
  const level = (value: number) => changes.filter((change) => (change as { level?: unknown }).level === value).length;
  return { errors: level(3), warnings: level(2), infos: level(1) };
}

/** "1 X" or "N Xs". */
function counted(count: number, what: string): string {
  return `${count} ${what}${count === 1 ? "" : "s"}`;
}

/** The short form of a commit. */
const short = (sha: string) => sha.slice(0, 7);

/** How a report went: Tiehall took it, as the report with this id, or it did not, and why; or it asks for a newer CLI. */
type Delivery = { delivered: true; id: string } | { delivered: false; reason: string; upgrade?: string };

/** What a problem the install answered says, in one line: its title and its detail. */
function problemLine(problem: { title?: unknown; detail?: unknown; status?: unknown }): string {
  const title = typeof problem.title === "string" ? problem.title : "";
  const detail = typeof problem.detail === "string" ? problem.detail : "";
  const status = typeof problem.status === "number" ? ` (HTTP ${problem.status})` : "";
  return `${[title, detail].filter((part) => part !== "").join(": ")}${status}`.replace(/\s+/g, " ").trim();
}

/**
 * Runs the pinned CLI's contract report and reads how it went. The Action
 * fails open (contract-changes: The Action fails open): whatever keeps
 * Tiehall from taking the report, such as an install the runner cannot
 * reach, an error answer, the 503 of an install that restarts for an upgrade,
 * or a CLI that cannot be started, is a report not delivered, never a failed
 * step. An install that asks for a newer CLI, with 400 and the problem type
 * upgrade-required, gets its own answer, which says how to upgrade.
 */
async function report(runtime: ActionRuntime, workspace: string, args: readonly string[]): Promise<Delivery> {
  let result: ExecResult;
  try {
    result = await runtime.exec("npx", args, { cwd: workspace, env: runtime.env });
  } catch (error) {
    return { delivered: false, reason: `the pinned tiehall CLI could not be started with npx (${(error as Error).message}); the runner needs Node.js with npm.` };
  }
  let answer: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    answer = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    answer = undefined;
  }
  if (result.status === 0 && typeof answer?.["id"] === "string") return { delivered: true, id: answer["id"] };
  if (answer !== undefined && typeof answer["type"] === "string") {
    const detail = problemLine(answer);
    if (answer["type"].endsWith("/upgrade-required")) return { delivered: false, reason: detail, upgrade: detail };
    return { delivered: false, reason: `Tiehall answered ${detail}.` };
  }
  const said = result.stderr.trim().split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
  return { delivered: false, reason: said === "" ? `the tiehall CLI exited with ${String(result.status)}.` : said };
}

/** Runs the Action once; returns the step's exit code, 0 when it succeeds. */
export async function runAction(runtime: ActionRuntime): Promise<number> {
  const { env } = runtime;
  try {
    return await runSteps(runtime);
  } catch (error) {
    if (error instanceof StepError || error instanceof InputError) {
      const title = error instanceof StepError ? error.title : "Input not valid";
      runtime.stdout(annotation("error", title, error.message));
      appendSummary(env, `## Tiehall contract check\n\n${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function runSteps(runtime: ActionRuntime): Promise<number> {
  const { env } = runtime;
  const event = pullRequestEventOf(env);
  if ("skip" in event) {
    runtime.stdout(annotation("notice", "Contract check skipped", event.skip));
    return 0;
  }
  const install = installUrlOf(inputOf(env, "install-url"));
  const api = inputOf(env, "api");
  if (api === "") throw new InputError("The input api names the registered API the document describes, such as payments-api.");
  const spec = specPathOf(inputOf(env, "spec"));
  const failOnBreaking = booleanInputOf(env, "fail-on-breaking", false);
  const includeDrafts = booleanInputOf(env, "include-drafts", false);
  if (event.draft && !includeDrafts) {
    runtime.stdout(annotation("notice", "Contract check skipped", `Pull request #${event.number} is a draft; the contract Action reports it once it is marked ready for review.`));
    return 0;
  }

  const workspace = env["GITHUB_WORKSPACE"] ?? process.cwd();
  const temporary = mkdtempSync(join(env["RUNNER_TEMP"] ?? tmpdir(), "tiehall-contract-"));
  try {
    // 1. The pinned engine, checked before it runs.
    let oasdiff: string;
    try {
      oasdiff = await installOasdiff({ directory: join(temporary, "oasdiff"), fetch: (request) => runtime.fetch(request), platform: runtime.platform, arch: runtime.arch });
    } catch (error) {
      if (error instanceof ChecksumError) throw new StepError("oasdiff not verified", `${error.message} The contract check did not run and reported nothing.`);
      if (error instanceof UnsupportedPlatformError) throw new StepError("oasdiff not available", error.message);
      throw new StepError("oasdiff not installed", `The pinned oasdiff ${OASDIFF.version} could not be downloaded: ${(error as Error).message}`);
    }

    // 2. The document at the base and head commits, in a folder of their own.
    const documents = join(temporary, "documents");
    mkdirSync(documents, { recursive: true });
    const extension = [".json", ".yaml", ".yml"].includes(extname(spec).toLowerCase()) ? extname(spec).toLowerCase() : ".yaml";
    const head = await documentAt(runtime, workspace, event.head.sha, spec);
    if (head === undefined) {
      throw new StepError("Document not found", `The pull request's head commit ${short(event.head.sha)} has no ${spec}; the input spec names the API's OpenAPI document in the repository.`);
    }
    const base = await documentAt(runtime, workspace, event.base.sha, spec);

    // 3. The breaking changes and the changelog, from the pinned engine alone.
    let breaking = "";
    let changelog = "[]";
    if (base !== undefined) {
      writeFileSync(join(documents, `base${extension}`), base);
      writeFileSync(join(documents, `revision${extension}`), head);
      const run = async (args: string[]) => {
        const result = await runtime.exec(oasdiff, args, { cwd: documents, env: toolEnv(env) });
        if (result.status !== 0) {
          throw new StepError("oasdiff failed", `oasdiff ${args[0] ?? ""} could not compare the two versions of ${spec}: ${result.stderr.trim() || `it exited with ${String(result.status)}`}`);
        }
        return result.stdout;
      };
      breaking = await run(breakingArguments(`base${extension}`, `revision${extension}`));
      changelog = await run(changelogArguments(`base${extension}`, `revision${extension}`));
    }
    const counts = countsOf(changelog);
    const changes = join(temporary, "changelog.json");
    writeFileSync(changes, changelog);

    // 4. The report, with the pinned CLI, which sends the classified changes and no document; the Action fails open.
    const delivery = await report(runtime, workspace, [
      "--yes",
      `${CLI_PIN.package}@${CLI_PIN.version}`,
      "contract",
      "report",
      "--install",
      install,
      "--api",
      api,
      "--changes",
      changes,
      "--engine-version",
      OASDIFF.version,
      "--json",
    ]);

    // 5. What it found and reported.
    const failing = failOnBreaking && counts.errors > 0;
    setOutputs(env, {
      "breaking-changes": String(counts.errors),
      "warnings": String(counts.warnings),
      "reported": String(delivery.delivered),
      ...(delivery.delivered ? { "report-id": delivery.id } : {}),
    });
    const found =
      counts.errors + counts.warnings + counts.infos === 0
        ? "oasdiff classified no change."
        : `oasdiff classified ${counted(counts.errors, "breaking change")} (ERR), ${counted(counts.warnings, "potentially breaking change")} (WARN) and ${counted(counts.infos, "other change")} (INFO).`;
    let reported: string[];
    if (delivery.delivered) {
      reported = [`Reported to Tiehall at ${install}, as report ${delivery.id}.`];
    } else if (delivery.upgrade !== undefined) {
      const upgrade = `Tiehall at ${install} needs a newer tiehall CLI than this release of the contract Action pins (${CLI_PIN.version}), so it did not take the report. Pin a newer release of the contract Action in this workflow: its README shows the commit SHA and release to pin. The check is not failed for it.`;
      runtime.stdout(annotation("warning", "Tiehall needs a newer contract Action", upgrade));
      reported = ["### Tiehall needs a newer contract Action", "", upgrade, ...(delivery.upgrade === "" ? [] : ["", `Tiehall said: ${delivery.upgrade}`])];
    } else {
      const why = `The report was not delivered to Tiehall at ${install}: ${delivery.reason} The check is not failed for it; the next run of the Action reports again.`;
      runtime.stdout(annotation("warning", "Report not delivered", why));
      reported = [why];
    }
    appendSummary(
      env,
      [
        `## Tiehall contract check: ${api}`,
        "",
        base === undefined
          ? `Pull request #${event.number} adds ${spec}, so there is no earlier version to compare.`
          : `Pull request #${event.number} compared ${spec} at ${event.base.ref} (${short(event.base.sha)}) with ${event.head.ref} (${short(event.head.sha)}), with oasdiff ${OASDIFF.version}. ${found}`,
        "",
        ...reported,
        ...(failing ? ["", "The step fails because of the breaking changes, as fail-on-breaking asks."] : []),
        ...(breaking === "" ? [] : ["", "<details><summary>oasdiff breaking</summary>", "", codeBlock(breaking), "</details>"]),
        "",
      ].join("\n"),
    );
    if (failing) {
      runtime.stdout(annotation("error", "Breaking changes", `${counted(counts.errors, "breaking change")} to ${api} in ${spec}; the step fails because fail-on-breaking is set.`));
      return 1;
    }
    return 0;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

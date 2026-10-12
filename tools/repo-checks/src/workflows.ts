import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { releaseAgeViolations } from "./release-age.ts";

// The rules of self-host-install: Release pipeline integrity that can be read
// from the repository: how workflows reference actions, which token
// permissions and secrets each job holds, that a job holding a write
// permission, such as the jobs that push the image, runs only first-party
// steps, how CI installs dependencies, and which packages may run install
// scripts. A first-party step is one of GitHub's own actions or the
// repository's own, or a script that installs no package and runs no package
// manager, no package's program or module, no code it downloads and no
// container, wherever in a command it names one, a shell's -c text and xargs's
// arguments included: a dependency's code would run with the job's write
// access as surely as a third-party action's. Building the repository's own
// image from its checkout is first-party, since the build runs the
// repository's instructions in containers that get none of the job's secrets,
// unless the build is given them, the host's network or more privileges. A
// job that can write runs in no container and beside no service container.
//
// Known limits of the write-job rule. It reads the workflows' shell text only:
// it does not follow PATH, a cd, or what a script or module the step runs
// does. It matches program names as plain words, so it misses one that is
// escaped or partly quoted (\pnpm, p"np"m). It finds a download run as code
// only when it is piped into a shell or an interpreter on its own line or the
// next, or run inside one, so it misses a pipe carried over a blank or comment
// line, a process substitution (curl ... > >(bash)) and a file saved and run
// later (curl -o x.sh ... && bash x.sh). It does not know node -e with a
// require of a package, buildah, gh extension install, the system's package
// managers (apt-get, brew) or other ecosystems' (poetry, composer, maven and
// more), and it counts a build of the checkout as first-party even when a
// --build-arg hands it a secret. And it refuses some harmless lines: a
// manager's name inside echoed text (echo "ready to go run it"), and every
// docker buildx bake, since it does not read bake files. These are the
// repository's own workflow files, which people review as well: the rule
// guards them against mistakes, not against someone set on getting past it.

export type Rule =
  | "action-not-pinned"
  | "workflow-permissions"
  | "job-permissions"
  | "unlisted-write-permission"
  | "unlisted-secret"
  | "unsafe-install"
  | "install-scripts"
  | "release-age"
  | "third-party-in-write-job";

export interface Violation {
  rule: Rule;
  /** A workflow file name (workflows live flat in .github/workflows), or a file at the root. */
  file: string;
  job?: string;
  detail: string;
}

/**
 * .github/workflow-policy.json: the only jobs that may hold a write permission
 * or use a secret. Keys are "<workflow file>#<job id>".
 */
export interface Policy {
  writePermissions: Record<string, string[]>;
  secrets: Record<string, string[]>;
}

export interface JobPermissions {
  /** "<workflow file>#<job id>" */
  job: string;
  /** The job's permissions block as written, or undefined when it declares none. */
  permissions: unknown;
}

type Mapping = Record<string, unknown>;

const WORKFLOWS = join(".github", "workflows");
const POLICY = join(".github", "workflow-policy.json");

/** owner/repo[/path]@<full commit SHA>. A tag, a branch or an abbreviated SHA can be moved or become ambiguous. */
const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/;
const PINNED_DOCKER_ACTION = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
/** A first-party action or workflow: GitHub's own (the actions and github organizations), or the repository's own. */
const FIRST_PARTY = /^(?:\.\/|(?:actions|github)\/)/;
/** An expression, ${{ ... }}: the only place a workflow can read the secrets context. */
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
/** A secret named inside an expression: secrets.NAME or secrets['NAME']. */
const SECRET_REFERENCE = /\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_-]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

export function loadPolicy(root: string): Policy {
  const file = join(root, POLICY);
  if (!existsSync(file)) return { writePermissions: {}, secrets: {} };
  const { writePermissions = {}, secrets = {} } = JSON.parse(readFileSync(file, "utf8")) as Partial<Policy>;
  return { writePermissions, secrets };
}

/** Checks the repository at this root; an exception to the release age is judged on this UTC day (YYYY-MM-DD), today unless given. */
export function checkWorkflows(root: string, policy: Policy = loadPolicy(root), today: string = new Date().toISOString().slice(0, 10)): Violation[] {
  const violations: Violation[] = [];
  for (const [file, workflow] of workflows(root)) {
    violations.push(...checkWorkflowPermissions(file, workflow["permissions"]));
    violations.push(...secretsIn(workflow["env"]).map((name) => ({ rule: "unlisted-secret" as const, file, detail: `workflow env uses secrets.${name}` })));
    for (const [job, definition] of jobsOf(workflow)) {
      violations.push(...checkJob(file, job, definition, policy));
    }
  }
  violations.push(...checkInstallScriptSettings(root));
  // An exclusion from the 7-day release age is a reviewed, recorded and dated exception (release-age.ts).
  violations.push(...releaseAgeViolations(root, today));
  // Stable: violations of one job stay in the order they appear in the file.
  return violations.sort((a, b) => a.file.localeCompare(b.file) || (a.job ?? "").localeCompare(b.job ?? ""));
}

/** Every job with its permissions block, for the CI log. */
export function jobPermissions(root: string): JobPermissions[] {
  const rows: JobPermissions[] = [];
  for (const [file, workflow] of workflows(root)) {
    for (const [job, definition] of jobsOf(workflow)) {
      rows.push({ job: `${file}#${job}`, permissions: definition["permissions"] });
    }
  }
  return rows;
}

export function describePermissions(permissions: unknown): string {
  if (permissions === undefined) return "(not declared)";
  if (typeof permissions === "string") return permissions;
  const entries = Object.entries(permissions as Mapping).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "(none)" : entries.map(([scope, level]) => `${scope}: ${String(level)}`).join(", ");
}

function* workflows(root: string): Generator<[string, Mapping]> {
  const folder = join(root, WORKFLOWS);
  if (!existsSync(folder)) return;
  for (const file of readdirSync(folder).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const workflow = parse(readFileSync(join(folder, file), "utf8")) as unknown;
    yield [file, isMapping(workflow) ? workflow : {}];
  }
}

function* jobsOf(workflow: Mapping): Generator<[string, Mapping]> {
  const jobs = workflow["jobs"];
  if (!isMapping(jobs)) return;
  for (const [job, definition] of Object.entries(jobs)) {
    yield [job, isMapping(definition) ? definition : {}];
  }
}

function checkWorkflowPermissions(file: string, permissions: unknown): Violation[] {
  const rule = "workflow-permissions";
  if (permissions === undefined || permissions === null) {
    return [{ rule, file, detail: "declares no top-level permissions, so its jobs would get the repository default" }];
  }
  if (!isMapping(permissions)) return [{ rule, file, detail: `grants ${String(permissions)} to every job` }];
  return writesIn(permissions).map((scope) => ({ rule, file, detail: `grants ${scope}: write to every job` }));
}

function checkJob(file: string, job: string, definition: Mapping, policy: Policy): Violation[] {
  const violations: Violation[] = [];
  const key = `${file}#${job}`;
  const add = (rule: Rule, detail: string) => violations.push({ rule, file, job, detail });

  // Every action and reusable workflow is pinned to a full commit SHA.
  const references = [definition["uses"], ...stepsOf(definition).map((step) => step["uses"])];
  for (const uses of references) {
    if (typeof uses !== "string" || uses.startsWith("./")) continue;
    const pinned = uses.startsWith("docker://") ? PINNED_DOCKER_ACTION.test(uses) : PINNED_ACTION.test(uses);
    if (!pinned) add("action-not-pinned", uses);
  }

  // Every job declares its permissions, and holds write access only where the policy lists it.
  const permissions = definition["permissions"];
  if (permissions === undefined || permissions === null) {
    add("job-permissions", "declares no permissions");
  } else if (!isMapping(permissions)) {
    add("job-permissions", `uses the "${String(permissions)}" shorthand instead of listing each permission`);
  } else {
    const allowed = policy.writePermissions[key] ?? [];
    for (const scope of writesIn(permissions)) {
      if (!allowed.includes(scope)) add("unlisted-write-permission", `${scope}: write`);
    }
  }

  // A job that can write runs only first-party steps: GitHub's own actions and the repository's own, never a
  // third-party action, Docker action or reusable workflow, which would run with its write access, nor in a container
  // or beside a service container; and its scripts install no package and run no package manager, downloaded code or
  // container, and build no image but the repository's own from its checkout, whose code would run with that access too.
  if (isMapping(permissions) && writesIn(permissions).length > 0) {
    for (const uses of references) {
      if (typeof uses === "string" && !FIRST_PARTY.test(uses)) add("third-party-in-write-job", uses);
    }
    const container = definition["container"];
    if (container !== undefined && container !== null) {
      add("third-party-in-write-job", `container ${imageOf(container)} (runs the job's steps in a container in a job that can write)`);
    }
    const services = definition["services"];
    for (const [name, service] of Object.entries(isMapping(services) ? services : {})) {
      add("third-party-in-write-job", `service ${name}, ${imageOf(service)} (runs a service container in a job that can write)`);
    }
    for (const step of stepsOf(definition)) {
      if (typeof step["run"] !== "string") continue;
      for (const pipeline of pipelinesIn(step["run"])) {
        for (const command of pipeline) {
          const problem = thirdPartyCode(command);
          if (problem !== undefined) add("third-party-in-write-job", `${command} (${problem})`);
        }
        if (runsDownloadedCode(pipeline)) add("third-party-in-write-job", `${pipeline.join(" | ")} (runs code it downloads in a job that can write)`);
      }
    }
  }

  // Secrets (other than the job's own GITHUB_TOKEN) only where the policy lists them.
  const allowedSecrets = policy.secrets[key] ?? [];
  if (definition["secrets"] === "inherit" && !allowedSecrets.includes("inherit")) add("unlisted-secret", "secrets: inherit");
  for (const name of secretsIn(definition)) {
    if (!allowedSecrets.includes(name)) add("unlisted-secret", `secrets.${name}`);
  }

  // Installs use the frozen lockfile, npm runs no install scripts, and nothing runs a package from outside the lockfile.
  for (const step of stepsOf(definition)) {
    if (typeof step["run"] !== "string") continue;
    for (const command of commandsIn(step["run"])) {
      const problem = installProblem(command);
      if (problem !== undefined) add("unsafe-install", `${command} (${problem})`);
    }
  }
  return violations;
}

function stepsOf(definition: Mapping): Mapping[] {
  const steps = definition["steps"];
  return Array.isArray(steps) ? steps.filter(isMapping) : [];
}

function writesIn(permissions: Mapping): string[] {
  return Object.entries(permissions)
    .filter(([, level]) => level === "write")
    .map(([scope]) => scope)
    .sort();
}

/** The names of the secrets referenced anywhere inside a value, in order, without duplicates. */
function secretsIn(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      for (const [, expression = ""] of node.matchAll(EXPRESSION)) {
        for (const match of expression.matchAll(SECRET_REFERENCE)) {
          const name = match[1] ?? match[2];
          if (name !== undefined && name.toUpperCase() !== "GITHUB_TOKEN") names.add(name);
        }
      }
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (isMapping(node)) {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return [...names];
}

/** The image a job's container or service container runs: the value itself, or its image. */
function imageOf(container: unknown): string {
  return String(isMapping(container) ? container["image"] : container);
}

/**
 * A script without its comments: each from a # that starts a word outside quoted text to the end of its line. A #
 * after an escaped character is part of that character's word.
 */
function withoutComments(script: string): string {
  let result = "";
  let quote = "";
  // Whether the next character starts a word.
  let startsAWord = true;
  for (let index = 0; index < script.length; index++) {
    const char = script.charAt(index);
    if (char === "\\" && quote !== "'") {
      result += script.slice(index, index + 2);
      index++;
      // An escaped character is part of a word; an escaped line break only joins two lines and leaves the word as is.
      if (quote === "" && script.charAt(index) !== "\n") startsAWord = false;
    } else if (quote !== "") {
      if (char === quote) quote = "";
      result += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      result += char;
      startsAWord = false;
    } else if (char === "#" && startsAWord) {
      const end = script.indexOf("\n", index);
      if (end < 0) break;
      index = end - 1;
    } else {
      result += char;
      startsAWord = /[\s;&|()<>]/.test(char);
    }
  }
  return result;
}

/**
 * The pipelines of a shell script, each as its simple commands, without comments, with continuations and lines
 * carried on by an operator joined, and with whitespace collapsed.
 */
function pipelinesIn(script: string): string[][] {
  return withoutComments(script)
    .replace(/\\\r?\n/g, " ")
    .replace(/(\|\||&&|\|)[ \t]*\r?\n/g, "$1 ")
    .split(/\r?\n/)
    .flatMap((line) => line.split(/\|\||&&|;/))
    .map((pipeline) => pipeline.split("|").map((command) => command.trim().replace(/\s+/g, " ")).filter((command) => command.length > 0))
    .filter((pipeline) => pipeline.length > 0);
}

/** The simple commands of a shell script. */
function commandsIn(script: string): string[] {
  return pipelinesIn(script).flat();
}

/** Options of npm and pnpm that come before the subcommand and take a value. */
const OPTIONS_WITH_VALUES = new Set(["--filter", "-F", "--dir", "-C", "--workspace", "-w", "--prefix"]);

/** A command's program and its arguments, without the environment assignments and wrappers in front of it. */
function programAndArguments(command: string): string[] {
  const words = command.split(" ").filter((word) => word.length > 0);
  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "") || ["sudo", "time", "exec", "env", "command"].includes(words[0] ?? ""))) {
    words.shift();
  }
  return words;
}

/**
 * Package managers and runners: whatever they install or run is a package's code, not the repository's. Deno and Bun
 * fetch and run the packages a script names without an install.
 */
const PACKAGE_RUNNERS = new Set([
  ...["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg", "bun", "bunx", "deno", "corepack"],
  ...["pip", "pip3", "pipx", "uv", "uvx", "cargo", "gem", "bundle", "bundler"],
]);
/** Go's subcommands that fetch, build and run a module's code. */
const GO_RUNS = new Set(["run", "install", "get", "generate", "test", "tool"]);
/** Programs that download, and programs that run the script they are given: shells, interpreters, eval, source and . */
const DOWNLOADERS = new Set(["curl", "wget"]);
const RUNS_A_SCRIPT = new Set([
  ...["bash", "sh", "dash", "zsh", "ksh", "fish", "python", "python3", "perl", "ruby", "node", "nodejs", "php", "pwsh"],
  ...["eval", "source", "."],
]);

/**
 * Programs that run containers, their options that come before a subcommand and take a value, and their subcommands
 * that start a container or build an image.
 */
const CONTAINER_RUNNERS = new Set(["docker", "podman", "nerdctl"]);
const CONTAINER_OPTIONS_WITH_VALUES = new Set([
  ...["-H", "--host", "-c", "--context", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
  ...["--url", "--connection", "--identity", "--namespace", "-n", "--address", "-a"],
]);
const STARTS_A_CONTAINER = new Set(["run", "create", "compose", "start", "exec"]);
const BUILDS_AN_IMAGE = new Set(["build", "bake"]);
/** Groups of subcommands, whose next word is the subcommand: docker container run, docker image build, docker buildx build. */
const SUBCOMMAND_GROUPS = new Set(["container", "image", "builder", "buildx"]);
/** buildx run as a program of its own. */
const BUILDX = new Set(["buildx", "docker-buildx"]);
/** Options of docker build and buildx build that take a value in the next word. */
const BUILD_OPTIONS_WITH_VALUES = new Set([
  ...["-t", "--tag", "--platform", "--build-arg", "--label", "--target", "-o", "--output", "--cache-from", "--cache-to", "--iidfile"],
  ...["--metadata-file", "--progress", "--builder", "--annotation", "--attest", "--provenance", "--sbom", "--add-host", "--shm-size"],
  ...["--ulimit", "--cgroup-parent", "--isolation", "-m", "--memory", "--memory-swap", "--cpu-shares", "--cpu-period", "--cpu-quota"],
  ...["--cpuset-cpus", "--cpuset-mems", "--call", "--no-cache-filter"],
]);
/** Options that give a build the job's secrets, its SSH agent, another source, the host's network or more privileges. */
const OPENS_THE_BUILD = new Set(["--secret", "--ssh", "--build-context", "--allow", "--network", "--security-opt"]);
/** A build's context that is the checkout's root or a folder in it, and a Dockerfile in the checkout. */
const CHECKOUT_CONTEXT = /^\.(?:\/(?!(?:.*\/)?\.\.(?:\/|$))[\w.\/-]*)?$/;
const CHECKOUT_FILE = /^(?![-/])(?!(?:.*\/)?\.\.(?:\/|$))[\w.\/-]+$/;
/** Options through which node loads a module before the script: one named by a package, not a path, is a package's. */
const NODE_LOADERS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);
/** A module specifier that names a file or a built-in module, not a package. */
const NOT_A_PACKAGE = /^(?:\.|\/|node:|file:|data:)/;

/**
 * The words of a command, taken apart at quotes, substitutions, groupings, operators and equals signs, so that a
 * program named in a shell's -c text, a command substitution, another program's arguments (such as xargs's) or an
 * environment variable (such as NODE_OPTIONS) is a word of its own.
 */
function wordsOf(command: string): string[] {
  return command.split(/[\s"'`$(){};|&<>=]+/).filter((word) => word.length > 0);
}

/** A word's last path segment: the program a path such as /usr/bin/npm names. */
function baseName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** The subcommand of the container program at the index of the words, past its options and a group's name. */
function containerSubcommand(words: string[], index: number): string | undefined {
  let at = index + 1;
  while (words[at]?.startsWith("-")) at += CONTAINER_OPTIONS_WITH_VALUES.has(words[at] ?? "") ? 2 : 1;
  return SUBCOMMAND_GROUPS.has(words[at] ?? "") ? words[at + 1] : words[at];
}

/**
 * Whether a command builds an image from the repository's own checkout and nothing else: docker build, or buildx
 * build, run as the command itself with no option before the subcommand, whose one context is the checkout's root
 * or a folder in it, whose Dockerfile, if it names one, is a file in the checkout, and which gives the build none of
 * the job's secrets, its SSH agent, another source, the host's network or more privileges.
 */
function buildsTheCheckout(command: string): boolean {
  const [path = "", ...rest] = programAndArguments(command);
  const program = baseName(path);
  let words = rest;
  if (CONTAINER_RUNNERS.has(program) && SUBCOMMAND_GROUPS.has(words[0] ?? "")) words = words.slice(1);
  if (!(CONTAINER_RUNNERS.has(program) || BUILDX.has(program)) || words[0] !== "build") return false;
  const contexts: string[] = [];
  for (let index = 1; index < words.length; index++) {
    const word = words[index] ?? "";
    if (!word.startsWith("-") || word === "-") {
      contexts.push(word);
      continue;
    }
    const [option = "", ...value] = word.split("=");
    if (OPENS_THE_BUILD.has(option)) return false;
    if (option === "-f" || option === "--file") {
      const file = value.length > 0 ? value.join("=") : (words[++index] ?? "");
      if (!CHECKOUT_FILE.test(file)) return false;
    } else if (value.length === 0 && BUILD_OPTIONS_WITH_VALUES.has(option)) {
      index++;
    }
  }
  return contexts.length === 1 && CHECKOUT_CONTEXT.test(contexts[0] ?? "");
}

/**
 * Whether a pipeline runs code it downloads: a command that downloads inside a shell, an interpreter, eval or source,
 * as in bash -c "$(curl ...)" or source <(curl ...), or pipes the download into one, as in curl ... | bash.
 */
function runsDownloadedCode(pipeline: string[]): boolean {
  const downloads = pipeline.findIndex((command) => wordsOf(command).some((word) => DOWNLOADERS.has(baseName(word))));
  if (downloads < 0) return false;
  const [program = ""] = programAndArguments(pipeline[downloads] ?? "");
  if (RUNS_A_SCRIPT.has(baseName(program))) return true;
  return pipeline.slice(downloads + 1).some((command) => wordsOf(command).some((word) => RUNS_A_SCRIPT.has(baseName(word))));
}

/**
 * Why a command would run code that is not first-party, in a job that can write: a package manager, which installs
 * or runs packages, Go's commands that fetch and run modules, a package's own program from node_modules, a module
 * node loads by a package's name, a container, or an image built from outside the repository's checkout or with the
 * job's secrets, host or privileges. Each word of the command counts wherever it stands, so a package manager run
 * through a shell's -c text, xargs or a command substitution counts as surely as one run directly. npm publishing a
 * package without running its scripts runs only npm itself.
 */
function thirdPartyCode(command: string): string | undefined {
  const [program, ...rest] = programAndArguments(command);
  const publishes = program === "npm" && subcommandOf(rest) === "publish" && rest.includes("--ignore-scripts");
  const words = wordsOf(publishes ? rest.join(" ") : command);
  const packages = "runs a package manager, and with it packages' code, in a job that can write";
  if (words.some((word) => PACKAGE_RUNNERS.has(baseName(word)))) return packages;
  if (words.some((word) => word.includes("node_modules"))) return "runs a package's code from node_modules in a job that can write";
  const node = words.findIndex((word) => ["node", "nodejs", "NODE_OPTIONS"].includes(baseName(word)));
  for (const [index, word] of words.entries()) {
    const next = words[index + 1];
    if (node >= 0 && index > node && NODE_LOADERS.has(word) && next !== undefined && !NOT_A_PACKAGE.test(next)) {
      return "loads a package's module into node in a job that can write";
    }
    if (baseName(word) === "go" && GO_RUNS.has(next ?? "")) return packages;
    if (["docker-compose", "podman-compose"].includes(baseName(word))) return "runs a container in a job that can write";
    const builder = BUILDX.has(baseName(word)) && !CONTAINER_RUNNERS.has(baseName(words[index - 1] ?? ""));
    const subcommand = CONTAINER_RUNNERS.has(baseName(word)) ? containerSubcommand(words, index) : builder ? next : undefined;
    if (STARTS_A_CONTAINER.has(subcommand ?? "") && !builder) return "runs a container in a job that can write";
    if (BUILDS_AN_IMAGE.has(subcommand ?? "") && !buildsTheCheckout(command)) {
      return "builds an image from outside the repository's checkout, or with the job's secrets, host or privileges, in a job that can write";
    }
  }
  return undefined;
}

function installProblem(command: string): string | undefined {
  const [program, ...rest] = programAndArguments(command);
  if (program === undefined) return undefined;
  if (["npx", "pnpx", "bunx"].includes(program)) return "runs a package from outside the lockfile";

  const subcommand = subcommandOf(rest);
  const has = (flag: string) => rest.includes(flag);
  if (program === "npm") {
    if (subcommand === "exec" || subcommand === "x") return "runs a package from outside the lockfile";
    if (["install", "i", "in", "ins", "inst", "insta", "instal", "isntall", "add", "ci", "clean-install", "update", "up"].includes(subcommand ?? "")) {
      return has("--ignore-scripts") ? undefined : "npm installs must pass --ignore-scripts";
    }
  }
  if (program === "pnpm") {
    if (subcommand === "dlx") return "runs a package from outside the lockfile";
    if (subcommand === "install" || subcommand === "i") {
      return has("--frozen-lockfile") ? undefined : "pnpm installs must pass --frozen-lockfile";
    }
    if (["add", "update", "up", "upgrade"].includes(subcommand ?? "")) return "changes dependencies outside the lockfile";
  }
  if (program === "yarn" && subcommand === "dlx") return "runs a package from outside the lockfile";
  return undefined;
}

function subcommandOf(words: string[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? "";
    if (OPTIONS_WITH_VALUES.has(word)) {
      index++;
    } else if (!word.startsWith("-")) {
      return word;
    }
  }
  return undefined;
}

/** pnpm must keep refusing install scripts that nobody has put on the allowlist. */
function checkInstallScriptSettings(root: string): Violation[] {
  const violations: Violation[] = [];
  const settingsFiles: [string, Mapping][] = [];
  const workspace = join(root, "pnpm-workspace.yaml");
  if (existsSync(workspace)) {
    const settings = parse(readFileSync(workspace, "utf8")) as unknown;
    if (isMapping(settings)) settingsFiles.push(["pnpm-workspace.yaml", settings]);
  }
  const manifest = join(root, "package.json");
  if (existsSync(manifest)) {
    const pnpm = (JSON.parse(readFileSync(manifest, "utf8")) as Mapping)["pnpm"];
    if (isMapping(pnpm)) settingsFiles.push(["package.json", pnpm]);
  }
  for (const [file, settings] of settingsFiles) {
    if (settings["dangerouslyAllowAllBuilds"] === true) {
      violations.push({ rule: "install-scripts", file, detail: "dangerouslyAllowAllBuilds must not be true" });
    }
    if (settings["strictDepBuilds"] === false) {
      violations.push({ rule: "install-scripts", file, detail: "strictDepBuilds must not be false" });
    }
  }
  const npmrc = join(root, ".npmrc");
  if (existsSync(npmrc)) {
    for (const line of readFileSync(npmrc, "utf8").split(/\r?\n/)) {
      const [name, value] = line.split("=").map((part) => part.trim());
      if (name === "dangerously-allow-all-builds" && value === "true") {
        violations.push({ rule: "install-scripts", file: ".npmrc", detail: "dangerously-allow-all-builds must not be true" });
      }
      if (name === "strict-dep-builds" && value === "false") {
        violations.push({ rule: "install-scripts", file: ".npmrc", detail: "strict-dep-builds must not be false" });
      }
    }
  }
  return violations;
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

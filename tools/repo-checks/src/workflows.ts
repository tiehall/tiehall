import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// The rules of operations: Build pipeline integrity that can be read from the
// repository: how workflows reference actions, which token permissions and
// secrets each job holds, how CI installs dependencies, and which packages may
// run install scripts.

export type Rule =
  | "action-not-pinned"
  | "workflow-permissions"
  | "job-permissions"
  | "unlisted-write-permission"
  | "unlisted-secret"
  | "unsafe-install"
  | "install-scripts";

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

export function checkWorkflows(root: string, policy: Policy = loadPolicy(root)): Violation[] {
  const violations: Violation[] = [];
  for (const [file, workflow] of workflows(root)) {
    violations.push(...checkWorkflowPermissions(file, workflow["permissions"]));
    violations.push(...secretsIn(workflow["env"]).map((name) => ({ rule: "unlisted-secret" as const, file, detail: `workflow env uses secrets.${name}` })));
    for (const [job, definition] of jobsOf(workflow)) {
      violations.push(...checkJob(file, job, definition, policy));
    }
  }
  violations.push(...checkInstallScriptSettings(root));
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

/** The simple commands of a shell script, with continuations joined and whitespace collapsed. */
function commandsIn(script: string): string[] {
  return script
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .flatMap((line) => line.split(/\|\||&&|;|\|/))
    .map((command) => command.trim().replace(/\s+/g, " "))
    .filter((command) => command.length > 0);
}

/** Options of npm and pnpm that come before the subcommand and take a value. */
const OPTIONS_WITH_VALUES = new Set(["--filter", "-F", "--dir", "-C", "--workspace", "-w", "--prefix"]);

function installProblem(command: string): string | undefined {
  const words = command.split(" ");
  // Skip environment assignments and wrappers in front of the program.
  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "") || ["sudo", "time", "exec"].includes(words[0] ?? ""))) {
    words.shift();
  }
  const [program, ...rest] = words;
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

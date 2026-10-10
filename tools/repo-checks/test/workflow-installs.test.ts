import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Locally every workspace package is installed, so a script that loads a package a workflow job's filtered
// `pnpm install` leaves out passes here and fails only on the runner. This test reads each workflow job in order: an
// install step selects the workspace packages its filters name (`name...` with their workspace dependencies), and
// every later `node <file>` or `pnpm <script>` that runs `node <file>` may load only Node's own modules, the files of
// the repository, and packages a selected workspace package declares: Node finds a package another package depends on
// in that package's node_modules, which pnpm fills only for the packages an install selects. A job with no install
// runs scripts that load Node's own modules and the repository's files only.

const root = fileURLToPath(new URL("../../../", import.meta.url));

interface WorkspacePackage {
  name: string;
  dir: string;
  workspaceDependencies: string[];
  exports: Record<string, string> | string | undefined;
}

function readWorkspace(repo: string): WorkspacePackage[] {
  const config = parse(readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8")) as { packages: string[] };
  const read = (dir: string): WorkspacePackage => {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      exports?: Record<string, string> | string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
    return {
      name: manifest.name,
      dir,
      workspaceDependencies: Object.entries(dependencies)
        .filter(([, range]) => range.startsWith("workspace:"))
        .map(([name]) => name),
      exports: manifest.exports,
    };
  };
  const packages = [read(repo.replace(/\/$/, ""))];
  for (const pattern of config.packages) {
    if (pattern.startsWith("!")) continue;
    const folder = /^([\w-]+)\/\*$/.exec(pattern)?.[1];
    if (folder === undefined) throw new Error(`pnpm-workspace.yaml: the test reads only "<folder>/*" patterns, not ${pattern}`);
    for (const entry of readdirSync(join(repo, folder), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(repo, folder, entry.name, "package.json"))) {
        packages.push(read(join(repo, folder, entry.name)));
      }
    }
  }
  return packages;
}

/** The workspace packages an install with these `--filter` values selects; null for an install without filters. */
function selectedPackages(filters: string[], packages: WorkspacePackage[]): Set<string> | null {
  if (filters.length === 0) return null;
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const selected = new Set<string>();
  const add = (name: string, withDependencies: boolean): void => {
    const pkg = byName.get(name);
    if (pkg === undefined) throw new Error(`An install filter names ${name}, which is no workspace package`);
    if (selected.has(name) && !withDependencies) return;
    selected.add(name);
    if (withDependencies) for (const dependency of pkg.workspaceDependencies) if (!selected.has(dependency)) add(dependency, true);
  };
  for (const filter of filters) {
    if (filter.endsWith("...")) add(filter.slice(0, -3), true);
    else add(filter, false);
  }
  return selected;
}

const STATIC_IMPORT = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:[^;"'`]*?\sfrom[ \t]*)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /(?<!typeof\s*)\bimport\(\s*["']([^"']+)["']\s*[,)]/g;

/** The modules a file loads when Node runs it: type-only imports are erased. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) if (match[1] === undefined) specifiers.push(match[2] ?? "");
  for (const match of text.matchAll(DYNAMIC_IMPORT)) specifiers.push(match[1] ?? "");
  return specifiers;
}

interface Load {
  /** The file that loads the package. */
  file: string;
  /** The package it loads. */
  pkg: string;
  /** The workspace package whose node_modules must hold it. */
  owner: WorkspacePackage;
}

/** Every package that `entry` and the repository files it loads load, with the workspace package each needs installed. */
function packageLoads(entry: string, packages: WorkspacePackage[]): Load[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const ownerOf = (file: string): WorkspacePackage =>
    packages
      .filter((pkg) => file.startsWith(pkg.dir + sep))
      .sort((a, b) => b.dir.length - a.dir.length)[0] as WorkspacePackage;
  const loads: Load[] = [];
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file) || !/\.(?:[cm]?[jt]s|tsx)$/.test(file)) return;
    seen.add(file);
    const owner = ownerOf(file);
    for (const specifier of importsOf(file)) {
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        const target = join(dirname(file), specifier);
        if (!existsSync(target)) throw new Error(`${relative(root, file)} imports ${specifier}, which does not exist`);
        visit(target);
        continue;
      }
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? "");
      const workspace = byName.get(name);
      // A package that imports itself by name needs no install.
      if (workspace !== owner) loads.push({ file, pkg: name, owner });
      if (workspace !== undefined) {
        const subpath = `.${specifier.slice(name.length)}`;
        const target = typeof workspace.exports === "string" ? (subpath === "." ? workspace.exports : undefined) : workspace.exports?.[subpath];
        if (target === undefined) throw new Error(`${relative(root, file)} imports ${specifier}, which ${name} does not export`);
        visit(join(workspace.dir, target));
      }
    }
  };
  visit(entry);
  return loads;
}

interface Workflow {
  jobs: Record<string, { steps?: { run?: string }[] }>;
}

/** The problems of every job in the workflow files: a package a script loads that the job's install leaves out. */
function installProblems(repo: string, workflowFiles: string[]): string[] {
  const packages = readWorkspace(repo);
  const scripts = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const problems: string[] = [];
  for (const workflowFile of workflowFiles) {
    const workflow = parse(readFileSync(join(repo, workflowFile), "utf8")) as Workflow;
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      // undefined: nothing installed yet; null: every package installed.
      let selected: Set<string> | null | undefined;
      for (const { run } of job.steps ?? []) {
        if (run === undefined) continue;
        for (const command of run.split(/\n|&&|;/)) {
          const install = /\bpnpm install\b(.*)$/.exec(command);
          if (install !== undefined && install !== null) {
            const filters = [...(install[1] ?? "").matchAll(/--filter[ =]("[^"]+"|'[^']+'|\S+)/g)].map((match) => (match[1] ?? "").replace(/^["']|["']$/g, ""));
            selected = selectedPackages(filters, packages);
            continue;
          }
          const script = /(?:^|\s)pnpm\s+(?:run\s+)?([a-z][\w:-]*)/.exec(command)?.[1];
          const scriptCommand = script === undefined ? undefined : scripts[script];
          const entry = /(?:^|\s)node\s+((?:apps|packages|actions|tools)\/\S+\.[cm]?[jt]s)\b/.exec(scriptCommand ?? command)?.[1];
          if (entry === undefined || selected === null) continue;
          for (const load of packageLoads(join(repo, entry), packages)) {
            if (selected?.has(load.owner.name) === true) continue;
            problems.push(
              `${workflowFile}, job ${jobName}: ${entry} loads ${load.pkg} from ${relative(repo, load.file)}, ` +
                (selected === undefined ? "but the job installs nothing before it" : `but the job's install leaves ${load.owner.name} out`),
            );
          }
        }
      }
    }
  }
  return [...new Set(problems)];
}

const workflowFiles = readdirSync(join(root, ".github/workflows"))
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => `.github/workflows/${file}`);

describe("the packages each workflow job installs", () => {
  it("cover every package the scripts it runs load", () => {
    expect(installProblems(root, workflowFiles)).toEqual([]);
  });

  it("report a package an install leaves out, and a job that installs nothing before a script that needs packages", () => {
    const fixture = "tools/repo-checks/test/fixtures/workflow-installs/checks.yml";
    expect(installProblems(root, [fixture])).toEqual([
      `${fixture}, job packet-left-out: tools/repo-checks/src/check-packet-forward.ts loads ajv from packages/packet/src/validator.ts, ` +
        "but the job's install leaves @tiehall/packet out",
      `${fixture}, job nothing-installed: tools/repo-checks/src/check-graduation.ts loads @tiehall/catalog from tools/repo-checks/src/graduation.ts, ` +
        "but the job installs nothing before it",
    ]);
  });
});

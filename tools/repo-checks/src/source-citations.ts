import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Source citations in the repository's code, configuration and docs (task 3.4;
// design.md, Decisions this change rests on: D38). A comment that says where a
// rule comes from cites a requirement as `<capability>: <Requirement name>`,
// and design.md by section and number, such as `design.md, Technical
// decisions: T1`, or by a decision number such as D3. Each citation must name
// something the public specs and design.md hold, so that no comment points at
// planning material that stays out of the repository.

/** The capabilities of the earlier hosted plan, which the repository no longer holds. */
export const FORMER_CAPABILITIES = ["audit-log", "billing-readiness", "operations", "orgs-and-teams", "passkeys"] as const;

export interface Sources {
  /** The requirement names of every current capability. */
  requirements: ReadonlyMap<string, readonly string[]>;
  /** The decisions design.md lists, such as D3, T1 and S16. */
  decisions: ReadonlySet<string>;
}

export interface CitationProblem {
  file: string;
  line: number;
  citation: string;
  problem: string;
}

/** The folders of the changes under openspec/changes/, archived ones included. */
function changeFolders(root: string): string[] {
  const changes = join(root, "openspec", "changes");
  if (!existsSync(changes)) return [];
  return readdirSync(changes, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      entry.name === "archive"
        ? readdirSync(join(changes, "archive"), { withFileTypes: true })
            .filter((archived) => archived.isDirectory())
            .map((archived) => join(changes, "archive", archived.name))
        : [join(changes, entry.name)],
    );
}

/** The capability folders under a specs folder, each with the requirement names of its spec.md. */
function specsIn(folder: string): [string, string[]][] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, "spec.md")))
    .map((entry) => [
      entry.name,
      readFileSync(join(folder, entry.name, "spec.md"), "utf8")
        .split("\n")
        .filter((line) => line.startsWith("### Requirement: "))
        .map((line) => line.slice("### Requirement: ".length).trim()),
    ]);
}

/** Reads the current capabilities and their requirements, and the decisions design.md lists. */
export function readSources(root: string): Sources {
  const requirements = new Map<string, string[]>();
  const active = changeFolders(root).filter((folder) => !folder.includes(`${join("changes", "archive")}`));
  for (const specs of [join(root, "openspec", "specs"), ...active.map((folder) => join(folder, "specs"))]) {
    for (const [capability, names] of specsIn(specs)) requirements.set(capability, [...(requirements.get(capability) ?? []), ...names]);
  }
  const decisions = new Set<string>();
  for (const folder of changeFolders(root)) {
    const design = join(folder, "design.md");
    if (!existsSync(design)) continue;
    const text = readFileSync(design, "utf8");
    // A decision is listed where it is defined: a bold list item such as "**D3. No model.**", a heading that
    // carries its number such as "#### Detail rules (D28)", or a heading such as "#### T1. One app".
    for (const [, number] of text.matchAll(/\*\*D(\d+)[.,]/g)) decisions.add(`D${number}`);
    for (const [, number] of text.matchAll(/^#{2,6} .*\(D(\d+)\)\s*$/gm)) decisions.add(`D${number}`);
    for (const [, kind, number] of text.matchAll(/^#{2,6} ([TS])(\d+)\. /gm)) decisions.add(`${kind}${number}`);
  }
  return { requirements, decisions };
}

/** The repository's tracked files outside openspec/ and .claude/, which cite the specs rather than hold them. */
export function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(
      (file) =>
        file !== "" &&
        !file.startsWith("openspec/") &&
        !file.startsWith(".claude/") &&
        file !== "pnpm-lock.yaml" &&
        // The check's own test holds wrong citations on purpose, as fixtures.
        file !== "tools/repo-checks/test/source-citations.test.ts",
    );
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The start of the requirement name a citation gives, up to where the citation or its line ends. */
function requirementFragment(rest: string): string {
  return rest
    .replace(/\s*(\*\/|-->).*$/, "")
    .replace(/["'\\]+$/, "")
    .replace(/[.:]\s.*$/, "")
    .replace(/[.:]$/, "")
    .trim();
}

/** The problems with the citations in one file's text. */
export function citationProblems(file: string, text: string, sources: Sources): CitationProblem[] {
  const problems: CitationProblem[] = [];
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  const add = (index: number, citation: string, problem: string) =>
    problems.push({ file, line: lineOf(index), citation: citation.trim(), problem });

  const capabilities = [...sources.requirements.keys(), ...FORMER_CAPABILITIES].sort((a, b) => b.length - a.length);
  const citation = new RegExp(`(?<![A-Za-z0-9_./-])(${capabilities.map(escape).join("|")})(: ([^;),\\n]*)| draft\\b)`, "g");
  for (const match of text.matchAll(citation)) {
    const [whole, capability = "", , rest] = match;
    const requirements = sources.requirements.get(capability);
    if (requirements === undefined) {
      add(match.index, whole, `${capability} is a capability of the earlier hosted plan; cite the current requirement that holds the rule`);
      continue;
    }
    if (rest === undefined) continue;
    const fragment = requirementFragment(rest);
    if (!requirements.some((name) => name.startsWith(fragment) || fragment.startsWith(name))) {
      add(match.index, whole, `${capability} has no requirement named "${fragment}"`);
    }
  }

  for (const match of text.matchAll(/design\.md decision \d+/g)) {
    add(match.index, match[0], 'design.md numbers its decisions D, T and S; cite it by section and number, such as "design.md, Technical decisions: T1"');
  }
  for (const match of text.matchAll(/(?<![A-Za-z0-9_])D(\d+)(?![0-9A-Za-z_]|\.[A-Za-z])/g)) {
    if (!sources.decisions.has(match[0])) add(match.index, match[0], `design.md lists no decision ${match[0]}`);
  }
  for (const match of text.matchAll(/(Technical|Self-hosting) decisions: ([TS]\d+)/g)) {
    const decision = match[2] ?? "";
    const kind = match[1] === "Technical" ? "T" : "S";
    if (!decision.startsWith(kind) || !sources.decisions.has(decision)) {
      add(match.index, match[0], `design.md has no ${match[1]?.toLowerCase()} decision ${decision}`);
    }
  }
  return problems;
}

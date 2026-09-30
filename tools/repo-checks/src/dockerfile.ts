// The Dockerfile's part of self-host-install: Release pipeline integrity (D53): the operating system's security
// patches are applied when the image is built. The last stage of the Dockerfile, which becomes the image, must hold
// one RUN that updates the package lists and runs `apt-get upgrade` without asking anything and without recommended
// packages, joins its commands with `&&` and updates with `--error-on=any` so that any failure fails the build,
// including an archive apt cannot fetch or verify, which apt-get update otherwise only warns about, and removes the
// package lists and apt's caches before it ends, so that no layer holds a package index; and that RUN must come
// before the step that removes the package managers and before the image switches to its non-root user.

export type OsUpdateRule =
  | "missing"
  | "interactive"
  | "recommends"
  | "not-chained"
  | "index-left"
  | "after-package-managers-removed"
  | "after-user";

export interface OsUpdateProblem {
  rule: OsUpdateRule;
  /** The line of the Dockerfile where the instruction starts, from 1. */
  line: number;
  detail: string;
}

export interface Instruction {
  /** The instruction's keyword in upper case, such as RUN. */
  keyword: string;
  /** The rest of the instruction, its continued lines joined with a space. */
  args: string;
  /** The line where the instruction starts, from 1. */
  line: number;
}

/** The instructions of a Dockerfile, with continued lines joined and comment and blank lines left out, as Docker reads them. */
export function instructions(dockerfile: string): Instruction[] {
  const lines = dockerfile.split("\n");
  const result: Instruction[] = [];
  let current: { parts: string[]; line: number } | undefined;
  lines.forEach((raw, index) => {
    const text = raw.replace(/\r$/, "");
    // A comment line or a blank line is left out, inside a continued instruction too: Docker skips an empty
    // continuation line, with a warning, and goes on reading the instruction.
    if (/^\s*#/.test(text) || text.trim() === "") return;
    const continued = /\\\s*$/.test(text);
    const part = continued ? text.replace(/\\\s*$/, "") : text;
    if (current === undefined) current = { parts: [], line: index + 1 };
    current.parts.push(part.trim());
    if (!continued) {
      const joined = current.parts.filter((piece) => piece !== "").join(" ");
      const [keyword = "", ...rest] = joined.split(/\s+/);
      result.push({ keyword: keyword.toUpperCase(), args: rest.join(" "), line: current.line });
      current = undefined;
    }
  });
  return result;
}

/** The instructions of the Dockerfile's last stage, the one that becomes the image, from its FROM on. */
export function lastStage(dockerfile: string): Instruction[] {
  const all = instructions(dockerfile);
  const from = all.map((instruction) => instruction.keyword).lastIndexOf("FROM");
  return from === -1 ? [] : all.slice(from);
}

/**
 * The shell text of a RUN with its quotes taken off; a quoted string that holds a shell separator becomes an empty
 * one, so that a separator inside quotes is not read as one.
 */
function unquoted(shell: string): string {
  return shell.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_, single?: string, double?: string) => {
    const inner = single ?? double ?? "";
    return /[;&|]/.test(inner) ? "''" : inner;
  });
}

/** The words of one command, without the variable assignments that may precede it. */
function words(command: string): string[] {
  const all = command.trim().split(/\s+/).filter((word) => word !== "");
  const first = all.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return first === -1 ? [] : all.slice(first);
}

/** The options of apt-get that take a value as the next word. */
const APT_OPTIONS_WITH_VALUE = new Set([
  "-o",
  "-c",
  "-t",
  "--option",
  "--config-file",
  "--target-release",
  "--default-release",
  "--error-on",
]);

/** An apt-get command: its subcommand and its options; undefined for any other command. */
function aptGet(command: string): { subcommand: string; options: string[] } | undefined {
  const [program, ...rest] = words(command);
  if (program !== "apt-get") return undefined;
  const options: string[] = [];
  let subcommand = "";
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index] ?? "";
    if (APT_OPTIONS_WITH_VALUE.has(word)) {
      options.push(`${word} ${rest[index + 1] ?? ""}`);
      index++;
    } else if (word.startsWith("-")) {
      options.push(word);
    } else if (subcommand === "") {
      subcommand = word;
    }
  }
  return { subcommand, options };
}

const isApt = (subcommand: string) => (command: string) => aptGet(command)?.subcommand === subcommand;

/** Whether a command is `rm` of one of the paths `path` matches, recursively when `recursive` is set. */
function removes(command: string, path: RegExp, recursive = false): boolean {
  const [program, ...rest] = words(command);
  if (program !== "rm") return false;
  const isRecursive = rest.some((word) => /^-[A-Za-z]*[rR]/.test(word) || word === "--recursive");
  return (isRecursive || !recursive) && rest.some((word) => path.test(word));
}

const LISTS = /^\/var\/lib\/apt\/lists(?:\/\*?)?$/;
const CACHES = /^\/var\/cache\/apt(?:\/.*)?$/;
const removesLists = (command: string) => removes(command, LISTS, true);
const cleansCaches = (command: string) => isApt("clean")(command) || removes(command, CACHES);
/** The RUN that removes the package managers the base image ships is the one that removes npm. */
const removesPackageManagers = (command: string) => removes(command, /^\/usr\/local\/bin\/npm$/);

const NONINTERACTIVE = "DEBIAN_FRONTEND=noninteractive";

/** Whether a command exports DEBIAN_FRONTEND=noninteractive for the commands after it. */
function exportsNoninteractive(command: string): boolean {
  const [program, ...rest] = command.trim().split(/\s+/);
  return program === "export" && rest.includes(NONINTERACTIVE);
}

/** Whether a command sets DEBIAN_FRONTEND=noninteractive for itself, before its program. */
function setsNoninteractive(command: string): boolean {
  const all = command.trim().split(/\s+/);
  const program = all.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return all.slice(0, program === -1 ? all.length : program).includes(NONINTERACTIVE);
}

/** The shell text of a RUN, unquoted, with the redirections that hold `&`, such as `2>&1`, taken out. */
function shellText(run: Instruction): string {
  return unquoted(run.args).replace(/\d*>&\d*-?|&>>?/g, " ");
}

/** The commands of a RUN, in order, split at every shell separator; `separators` finds the ones that are not `&&`. */
function commands(run: Instruction): string[] {
  return shellText(run)
    .split(/&&|\|\||;|\||&/)
    .map((command) => command.trim())
    .filter((command) => command !== "");
}

/** The shell separators of a RUN other than `&&`: `;`, `||`, a pipe or a background `&`. */
function separators(run: Instruction): string[] {
  const text = shellText(run).replace(/&&/g, " ");
  return [...text.matchAll(/\|\||;|\||&/g)].map(([separator]) => separator);
}

/** Whether an option of apt-get answers yes to every question. */
const answersYes = (option: string) => /^-[A-Za-z]*y[A-Za-z]*$/.test(option) || option === "--yes" || option === "--assume-yes";
/** Whether an option of apt-get leaves out recommended packages. */
const leavesOutRecommends = (option: string) =>
  option === "--no-install-recommends" || /^(?:-o|--option) APT::Install-Recommends=(?:false|0)$/.test(option);

/**
 * Whether an option of apt-get update makes it fail when an archive cannot be fetched or verified; by default it
 * only warns and exits 0, and the upgrade then finds nothing to upgrade.
 */
const failsOnAnyError = (option: string) =>
  /^--error-on(?:=| )any$/.test(option) || /^(?:-o|--option) APT::Update::Error-Mode=any$/.test(option);

/** The problems with the operating-system updates in a Dockerfile's last stage; empty when it follows the rule. */
export function osUpdateProblems(dockerfile: string): OsUpdateProblem[] {
  const stage = lastStage(dockerfile);
  const runs = stage.filter((instruction) => instruction.keyword === "RUN");
  const problems: OsUpdateProblem[] = [];
  const add = (rule: OsUpdateRule, line: number, detail: string) => problems.push({ rule, line, detail });

  // The step: a RUN that updates the package lists and then upgrades.
  const step = runs.find((run) => {
    const list = commands(run);
    const update = list.findIndex(isApt("update"));
    const upgrade = list.findIndex(isApt("upgrade"));
    return update !== -1 && upgrade > update;
  });

  if (step === undefined) {
    add("missing", stage[0]?.line ?? 1, "the runtime stage has no RUN that updates the package lists and then runs apt-get upgrade");
  } else {
    const list = commands(step);
    const upgradeIndex = list.findIndex(isApt("upgrade"));
    const { options } = aptGet(list[upgradeIndex] ?? "") ?? { options: [] };

    const lacking: string[] = [];
    const noninteractive = list.slice(0, upgradeIndex).some(exportsNoninteractive) || setsNoninteractive(list[upgradeIndex] ?? "");
    if (!noninteractive) lacking.push(NONINTERACTIVE);
    if (!options.some(answersYes)) lacking.push("--yes");
    if (lacking.length > 0) add("interactive", step.line, `apt-get upgrade can stop to ask: the step lacks ${lacking.join(" and ")}`);

    if (!options.some(leavesOutRecommends)) {
      add("recommends", step.line, "apt-get upgrade can install recommended packages: the step lacks --no-install-recommends");
    }

    const failures: string[] = [];
    const others = [...new Set(separators(step))].map((separator) => `"${separator}"`);
    if (others.length > 0) failures.push(`the step joins commands with ${others.join(", ")}, not only "&&"`);
    const warnsOnly = list.filter(isApt("update")).some((command) => !(aptGet(command)?.options ?? []).some(failsOnAnyError));
    if (warnsOnly) failures.push("its apt-get update lacks --error-on=any, so an archive it cannot fetch or verify is only a warning");
    if (failures.length > 0) add("not-chained", step.line, `a failed command must fail the build: ${failures.join(", and ")}`);
  }

  // Every RUN of the stage that fetches package lists removes them, and apt's caches, after its last update.
  for (const run of runs) {
    const list = commands(run);
    const lastUpdate = list.map(isApt("update")).lastIndexOf(true);
    if (lastUpdate === -1) continue;
    const after = list.slice(lastUpdate + 1);
    const lacking: string[] = [];
    if (!after.some(removesLists)) lacking.push("remove /var/lib/apt/lists");
    if (run === step && !after.some(cleansCaches)) lacking.push("clean apt's caches");
    if (lacking.length > 0) {
      add("index-left", run.line, `the package index stays in the image: this RUN does not ${lacking.join(" or ")} after its last apt-get update`);
    }
  }

  if (step !== undefined) {
    const before = stage.slice(0, stage.indexOf(step));
    const removal = before.find((instruction) => instruction.keyword === "RUN" && commands(instruction).some(removesPackageManagers));
    if (removal !== undefined) {
      add("after-package-managers-removed", step.line, `the step comes after the package managers are removed, on line ${removal.line}`);
    }
    const user = before.find((instruction) => instruction.keyword === "USER");
    if (user !== undefined) add("after-user", step.line, `the step comes after the switch to the non-root user, on line ${user.line}`);
  }
  return problems;
}

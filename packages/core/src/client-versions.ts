import { Refusal } from "./error-model.ts";

// The CLI sends its version and the server keeps a minimum (public-api: The
// CLI sends its version and the server keeps a minimum; agent-surfaces: The
// Claude Code plugin; design.md, Decisions this change rests on: D28 #1, #63;
// design.md, Design rules: Public API). Every call of the tiehall CLI names
// its version, a semantic version such as 0.1.0, in the Tiehall-CLI-Version
// header, and the install keeps the oldest version it supports: a call from
// an older CLI is refused with 400 and the problem type upgrade-required,
// whose detail says how to upgrade, and runs nothing. The Claude Code
// plugin's hooks run the CLI, so the minimum holds the plugin too. A call
// that names no version is not the CLI's, such as a script's, and one whose
// version cannot be read fails its input; its value is never quoted.

/** The header every call of the CLI names its version in, as HTTP headers are compared: in lower case. */
export const CLI_VERSION_HEADER = "tiehall-cli-version";

/** The oldest CLI this install supports; raising it refuses every older CLI's calls. */
export const MINIMUM_CLI_VERSION = "0.1.0";

/**
 * The oldest CLI that contract.report takes a report from, its own floor
 * (public-api: `contract.report` has its own version floor; design.md, Design
 * rules: Public API). Companies' CI runs the CLI version the contract Action
 * pins, so the floor is never above MINIMUM_CLI_VERSION, and it is raised only
 * with at least 180 days' notice in the API changelog: a pinned CLI that the
 * general minimum has left behind keeps reporting until then.
 */
export const MINIMUM_CONTRACT_REPORT_CLI_VERSION = "0.1.0";

/**
 * The oldest Claude Code plugin Tiehall supports (agent-surfaces: The Claude
 * Code plugin). The plugin's hooks run the CLI, so its minimum holds through
 * the CLI's: a plugin release that needs a newer CLI raises MINIMUM_CLI_VERSION
 * with it. The plugin check in CI fails on a plugin below it.
 */
export const MINIMUM_PLUGIN_VERSION = "0.1.0";

/** The oldest version of the Tiehall skill Tiehall supports; whoami warns an agent whose skill is older. */
export const MINIMUM_SKILL_VERSION = "0.1.0";

/** A semantic version: its major, minor and patch numbers, and its pre-release, if any, such as 0.1.0 or 1.2.0-rc.1. */
export const SEMANTIC_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z\.-]{1,64}))?(?:\+[0-9A-Za-z\.-]{1,64})?$/;
const VERSION = SEMANTIC_VERSION;

function parts(version: string): { numbers: number[]; preRelease: string | undefined } | undefined {
  const match = VERSION.exec(version);
  if (match === null) return undefined;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], preRelease: match[4] };
}

/** Whether a text is a semantic version, such as 0.1.0 or 1.2.0-rc.1. */
export function isVersion(version: string): boolean {
  return parts(version) !== undefined;
}

/** Below zero when a is older than b, zero when they are the same release, above zero when a is newer. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  if (x === undefined || y === undefined) throw new TypeError("Only semantic versions compare.");
  for (let index = 0; index < 3; index += 1) {
    const difference = (x.numbers[index] ?? 0) - (y.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  // A pre-release comes before its release; two pre-releases compare identifier by identifier.
  if (x.preRelease === y.preRelease) return 0;
  if (x.preRelease === undefined) return 1;
  if (y.preRelease === undefined) return -1;
  return comparePreReleases(x.preRelease.split("."), y.preRelease.split("."));
}

const NUMERIC = /^\d+$/;

/**
 * Two pre-releases in the order of Semantic Versioning 2.0.0, item 11: their
 * dot-separated identifiers from the left, numbers by their value, below any
 * identifier with a letter or hyphen, which compare in ASCII order; when every
 * identifier of one is the same as the other's, the one with fewer comes first.
 */
function comparePreReleases(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const [x, y] = [a[index] ?? "", b[index] ?? ""];
    if (x === y) continue;
    const [xNumber, yNumber] = [NUMERIC.test(x), NUMERIC.test(y)];
    if (xNumber && yNumber) {
      // Numbers of any length compare by value: without leading zeros, the longer is the larger.
      const [p, q] = [x.replace(/^0+(?=\d)/, ""), y.replace(/^0+(?=\d)/, "")];
      if (p.length !== q.length) return p.length - q.length;
      if (p !== q) return p < q ? -1 : 1;
      continue;
    }
    if (xNumber) return -1;
    if (yNumber) return 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** The refusal of a call that names this CLI version, or none; a call that names no version is not the CLI's. */
export function cliVersionRefusal(version: string | null, minimum: string = MINIMUM_CLI_VERSION): Refusal | undefined {
  return versionRefusal(version, minimum, (named) =>
    `This tiehall CLI is version ${named}, and this install needs version ${minimum} or later: upgrade it with npm install --global tiehall@latest, and run the command again.`,
  );
}

/**
 * The refusal of a contract report from a CLI of this version, or none, under
 * contract.report's own floor: its detail says to raise the version the
 * contract Action pins, which is where companies' CI takes the CLI from.
 */
export function contractReportCliRefusal(version: string | null, floor: string = MINIMUM_CONTRACT_REPORT_CLI_VERSION): Refusal | undefined {
  return versionRefusal(version, floor, (named) =>
    `This tiehall CLI is version ${named}, and this install needs version ${floor} or later to take contract reports: raise the tiehall version the contract Action pins in your workflow, or update the Action, and run the workflow again.`,
  );
}

/** A version below the minimum, refused with upgrade-required in these words; one that cannot be read fails the input, unquoted. */
function versionRefusal(version: string | null, minimum: string, detail: (version: string) => string): Refusal | undefined {
  if (version === null) return undefined;
  if (!isVersion(version.trim())) {
    return new Refusal("invalid-input", "The Tiehall-CLI-Version header names the CLI's version, a semantic version such as 0.1.0.");
  }
  if (compareVersions(version.trim(), minimum) >= 0) return undefined;
  return new Refusal("upgrade-required", detail(version.trim()));
}

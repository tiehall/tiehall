// Reads the JSON log of a Renovate lookup dry run and sorts every update it
// found into proposed and held back, for self-host-install: Release pipeline
// integrity: no update is proposed before it is 7 days old.

export const MINIMUM_RELEASE_AGE_DAYS = 7;

export interface DryRunUpdate {
  manager: string;
  packageFile: string;
  depName: string;
  updateType: string;
  /** For example "24.21.0-trixie-slim@sha256:d7b4e5c4ad20 -> 24.21.0-trixie-slim@sha256:8ec5d7557396". */
  change: string;
  /** Days between the release and the end of the run, to one decimal; undefined when Renovate gave no release time. */
  ageDays: number | undefined;
  /** Waits for a tick on the Dependency Dashboard before Renovate opens its pull request. */
  needsApproval: boolean;
}

export interface DryRunSummary {
  /** Updates Renovate would open a pull request for, or list for approval. */
  proposed: DryRunUpdate[];
  /** Updates Renovate holds back until they pass the minimum release age. */
  held: DryRunUpdate[];
  /** Proposed updates younger than the minimum release age, or of unknown age, that need no maintainer's tick. */
  tooYoung: DryRunUpdate[];
  /**
   * Updates the lookup found but Renovate made no branch for, because renovate.json turns them off, such as a new
   * digest for the same image tag. Known only from a log that lists the branches Renovate returns.
   */
  dropped: DryRunUpdate[];
  /** Dependencies the run could not look up, once each, for example action pins without a GitHub token. */
  notLookedUp: { depName: string; reason: string }[];
  /**
   * Updates Renovate dropped because renovate.json turns them off, such as a
   * major it never proposes. The log counts them but does not say which they
   * are, so they also appear under proposed or held.
   */
  disabled: number;
}

interface LogUpdate {
  updateType?: string;
  newValue?: string;
  newDigest?: string;
  releaseTimestamp?: string;
  pendingChecks?: boolean;
  dependencyDashboardApproval?: boolean;
  branchName?: string;
}

interface LogDependency {
  depName?: string;
  currentValue?: string;
  currentDigest?: string;
  skipReason?: string;
  updates?: LogUpdate[];
}

interface LogPackageFile {
  packageFile: string;
  deps: LogDependency[];
}

/** Skip reasons that mean "nothing to look up" rather than "could not look it up". */
const NOTHING_TO_LOOK_UP = new Set(["contains-variable", "unspecified-version", "ignored", "internal-package"]);

const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizeDryRun(log: string, minimumAgeDays = MINIMUM_RELEASE_AGE_DAYS): DryRunSummary {
  const lines = log.split("\n").flatMap((text): Record<string, unknown>[] => {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
  const result = lines.find((line) => line["msg"] === "packageFiles with updates");
  if (result === undefined) {
    throw new Error("The log has no 'packageFiles with updates' line: Renovate did not finish its lookup.");
  }
  // Ages are measured at the end of the run, so a saved log reads the same later.
  const times = lines.map((line) => line["time"]).filter((time): time is string => typeof time === "string");
  const now = Date.parse(times.at(-1) ?? new Date().toISOString());

  const dropped = lines
    .map((line) => /^Filtered out (\d+) disabled update/.exec(String(line["msg"])))
    .find((match) => match !== null);
  // The branches Renovate would open: after it drops the updates renovate.json turns off, it returns its branches and
  // logs each one that is not wholly pending. A log without that list, such as an older one, counts every update.
  const branchesListed = lines.some((line) => /^Returning \d+ branch\(es\)$/.test(String(line["msg"])));
  const openBranches = new Set(
    lines
      .filter((line) => line["msg"] === "Branch is not pending, removing pending upgrades" && typeof line["branch"] === "string")
      .map((line) => line["branch"] as string),
  );
  const summary: DryRunSummary = {
    proposed: [],
    held: [],
    tooYoung: [],
    dropped: [],
    notLookedUp: [],
    disabled: dropped?.[1] === undefined ? 0 : Number(dropped[1]),
  };
  const packageFiles = result["config"] as Record<string, LogPackageFile[]>;
  for (const [manager, files] of Object.entries(packageFiles)) {
    for (const { packageFile, deps } of files) {
      for (const dep of deps) {
        const depName = dep.depName ?? "(unnamed)";
        if (dep.skipReason !== undefined && !NOTHING_TO_LOOK_UP.has(dep.skipReason)) {
          const seen = summary.notLookedUp.some((entry) => entry.depName === depName && entry.reason === dep.skipReason);
          if (!seen) summary.notLookedUp.push({ depName, reason: dep.skipReason });
        }
        for (const update of dep.updates ?? []) {
          const released = update.releaseTimestamp === undefined ? Number.NaN : Date.parse(update.releaseTimestamp);
          const entry: DryRunUpdate = {
            manager,
            packageFile,
            depName,
            updateType: update.updateType ?? "unknown",
            change: `${version(dep.currentValue, dep.currentDigest)} -> ${version(update.newValue, update.newDigest)}`,
            ageDays: Number.isNaN(released) ? undefined : Math.round(((now - released) / DAY_MS) * 10) / 10,
            needsApproval: update.dependencyDashboardApproval === true,
          };
          if (update.pendingChecks === true) {
            summary.held.push(entry);
            continue;
          }
          if (branchesListed && update.branchName !== undefined && !openBranches.has(update.branchName)) {
            summary.dropped.push(entry);
            continue;
          }
          summary.proposed.push(entry);
          // An update that waits for a maintainer's tick on the Dependency Dashboard opens no pull request by itself,
          // such as a new digest for the same image tag, which carries no release time for the release age to hold.
          if (entry.needsApproval) continue;
          if (Number.isNaN(released) || now - released < minimumAgeDays * DAY_MS) summary.tooYoung.push(entry);
        }
      }
    }
  }
  return summary;
}

function version(value: string | undefined, digest: string | undefined): string {
  return `${value ?? ""}${digest === undefined ? "" : `@${digest.slice(0, 19)}`}`;
}

export function describeUpdate(update: DryRunUpdate): string {
  const age = update.ageDays === undefined ? "no release time" : `${update.ageDays} days old`;
  const approval = update.needsApproval ? ", waits for approval on the Dependency Dashboard" : "";
  return `${update.depName} ${update.updateType} ${update.change} in ${update.packageFile} (${age}${approval})`;
}

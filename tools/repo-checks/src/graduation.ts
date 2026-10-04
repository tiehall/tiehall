import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangelog, type Changelog, type ChangelogEntry, type ChangelogRelease } from "@tiehall/catalog/changelog";

// The graduation check (public-api: Each operation graduates on its own;
// design.md, Design rules: Public API, Graduation, as S13 adapts it). An
// operation carries x-stability-level stable only once it has passed the
// graduation test: no breaking change to it was needed for four weeks, and the
// maintainers have decided to graduate it and recorded that decision in the
// changelog. There is no usage count in the test, because installs send no
// usage data. contract.report is stable from its first release and exempt,
// because pinned Actions in companies' repositories call it; the CI OIDC path
// is how a CI run calls it, with a GitHub Actions OIDC token, and is no
// operation of its own, so exempting contract.report exempts it.
//
// The check reads the committed files a release ships: every OpenAPI document
// (openapi/v<N>.json), the MCP tool snapshot (mcp/tools.json), which records
// each tool's operation and its level, for an operation offered only on MCP,
// and openapi/changelog.json. A stable operation passes when the changelog
// holds an entry of kind graduation that names it, the maintainers' decision,
// dated the day they decided, and that decision passes the test:
// - it is dated no later than today;
// - every breaking change to the operation released before the graduation's
//   release came out at least four weeks (28 days) before the decision: a
//   change of level 3 that a release record lists for the operation, or an
//   entry of kind breaking that names it, counted from its release's day;
// - no breaking change to it comes with the graduation: none in the release
//   that carries the graduation, and, while the graduation is not released,
//   no unreleased entry of kind breaking that names it;
// - a release offered the operation at least four weeks before the decision,
//   since an operation that did not exist then has not had four weeks without
//   a breaking change. The release records list the changes of
//   openapi/v1.json, so this holds an operation of that document to the
//   release whose record lists it as added; for an operation the records do
//   not cover, such as one offered only on MCP, the check reads the
//   maintainers' entries alone.
// Breaking changes released after the graduation are the notice rules' to
// judge, since the operation is stable by then.

/** The operations stable from their first release, exempt from the graduation test. */
export const STABLE_FROM_THE_START = ["contract.report"] as const;

/** The four weeks with no breaking change that the graduation test needs, in days. */
export const QUIET_DAYS = 28;

/** The document whose changes the changelog's release records list (tools/repo-checks/src/api-changelog.ts). */
const RECORDED_DOCUMENT = "openapi/v1.json";
const TOOL_SNAPSHOT = "mcp/tools.json";
const CHANGELOG = "openapi/changelog.json";
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const DAY = 86_400_000;

/** What the check reads: the committed files of a tree, and today. */
export interface GraduationInput {
  /** Each OpenAPI document, by its path in the tree, such as openapi/v1.json, as JSON text. */
  documents: Readonly<Record<string, string>>;
  /** mcp/tools.json as JSON text; undefined when the tree has none. */
  tools?: string;
  /** openapi/changelog.json as JSON text. */
  changelog: string;
  /** Today, as a calendar day in UTC, such as 2026-12-01. */
  today: string;
}

/** Reads the committed documents, the tool snapshot and the changelog of the tree at root. */
export function readGraduationTree(root: string): Omit<GraduationInput, "today"> {
  const folder = join(root, "openapi");
  const names = existsSync(folder) ? readdirSync(folder).filter((name) => /^v\d+\.json$/.test(name)) : [];
  names.sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
  const documents = Object.fromEntries(names.map((name) => [`openapi/${name}`, readFileSync(join(folder, name), "utf8")]));
  const tools = join(root, TOOL_SNAPSHOT);
  return {
    documents,
    ...(existsSync(tools) ? { tools: readFileSync(tools, "utf8") } : {}),
    changelog: existsSync(join(root, CHANGELOG)) ? readFileSync(join(root, CHANGELOG), "utf8") : "",
  };
}

/** Where a stable operation is marked stable, in the words of a problem. */
interface Place {
  file: string;
  what: string;
}

/** The problems of the tree, one sentence each, sorted by operation; none when every stable operation passed the test. */
export function graduationProblems(input: GraduationInput): string[] {
  const problems: string[] = [];
  const stable = new Map<string, Place[]>();
  const mark = (id: string, place: Place) => stable.set(id, [...(stable.get(id) ?? []), place]);
  let recorded = new Set<string>();
  for (const [file, text] of Object.entries(input.documents)) {
    const operations = documentOperations(text);
    if (file === RECORDED_DOCUMENT) recorded = new Set(operations.map(({ id }) => id));
    for (const { id, method, path, level } of operations) if (level === "stable") mark(id, { file, what: `${method.toUpperCase()} ${path}` });
  }
  if (input.tools !== undefined) {
    for (const tool of snapshotTools(input.tools)) {
      if (tool.stability !== "stable") continue;
      if (tool.operationId === undefined) {
        problems.push(`${TOOL_SNAPSHOT}: the tool ${tool.name} is stable but names no operation, so its graduation cannot be checked; run \`pnpm mcp:generate\`.`);
      } else mark(tool.operationId, { file: TOOL_SNAPSHOT, what: `the tool ${tool.name}` });
    }
  }
  let changelog: Changelog;
  try {
    changelog = parseChangelog(input.changelog);
  } catch (error) {
    return [...problems, `${CHANGELOG} does not parse, so no graduation can be checked:\n${(error as Error).message}`];
  }
  const exempt = new Set<string>(STABLE_FROM_THE_START);
  for (const id of [...stable.keys()].sort()) {
    if (exempt.has(id)) continue;
    const where = `${id} is stable in ${(stable.get(id) ?? []).map(({ file, what }) => `${file} (${what})`).join(" and ")}`;
    const graduations = graduationsOf(changelog, id);
    if (graduations.length === 0) {
      problems.push(
        `${where}, but ${CHANGELOG} records no decision of the maintainers to graduate it. ` +
          "An operation becomes stable only once no breaking change to it was needed for four weeks and the maintainers record their decision in an entry of kind graduation that names it.",
      );
      continue;
    }
    const verdicts = graduations.map((graduation) => ({ graduation, reasons: graduationReasons(changelog, id, graduation, recorded.has(id), input.today) }));
    if (verdicts.some(({ reasons }) => reasons.length === 0)) continue;
    const latest = verdicts.reduce((a, b) => (b.graduation.entry.date >= a.graduation.entry.date ? b : a));
    const carried = latest.graduation.release === undefined ? "not released yet" : `released in ${latest.graduation.release.version}`;
    problems.push(`${where}, but its graduation of ${latest.graduation.entry.date}, ${carried}, does not pass the test: ${latest.reasons.join("; ")}.`);
  }
  return problems;
}

/** A graduation entry, with the release that carries it; none while it is unreleased. */
interface Graduation {
  entry: ChangelogEntry;
  /** Where its release is in changelog.releases, which lists the newest first; -1 while it is unreleased, newer than every release. */
  index: number;
  release?: ChangelogRelease;
}

function graduationsOf(changelog: Changelog, id: string): Graduation[] {
  const names = (entry: ChangelogEntry) => entry.kind === "graduation" && (entry.operationIds ?? []).includes(id);
  const released = changelog.releases.flatMap((release, index) => release.entries.filter(names).map((entry) => ({ entry, index, release })));
  const unreleased = changelog.unreleased.filter(names).map((entry) => ({ entry, index: -1 }));
  return [...released, ...unreleased];
}

/** Why a graduation does not pass the test; none when it does. */
function graduationReasons(changelog: Changelog, id: string, graduation: Graduation, recorded: boolean, today: string): string[] {
  const reasons: string[] = [];
  const decided = graduation.entry.date;
  if (decided > today) reasons.push(`it is dated after today, ${today}`);
  // Releases are newest first: those after the graduation's index are older than its release; an unreleased graduation (-1) is newer than every release.
  const before = changelog.releases.filter((_, index) => (graduation.index === -1 ? true : index > graduation.index));
  const breaks = (release: Pick<ChangelogRelease, "entries" | "changes">) =>
    release.changes.some((change) => change.level === 3 && change.operationId === id) ||
    release.entries.some((entry) => entry.kind === "breaking" && (entry.operationIds ?? []).includes(id));
  // The newest breaking change released before the graduation's release.
  const lastBreak = before.find(breaks);
  if (lastBreak !== undefined) {
    const days = daysBetween(lastBreak.date, decided);
    if (days < QUIET_DAYS) {
      reasons.push(
        `a breaking change to it was released in ${lastBreak.version} on ${lastBreak.date}, ${days} days before the decision, ` +
          `and the test needs four weeks (${QUIET_DAYS} days) with no breaking change`,
      );
    }
  }
  if (graduation.release !== undefined && breaks(graduation.release)) {
    reasons.push(`a breaking change to it is released together with the graduation, in ${graduation.release.version}`);
  }
  if (graduation.release === undefined && breaks({ entries: changelog.unreleased, changes: [] })) {
    reasons.push("a breaking change to it is not released yet, so it would be released together with the graduation");
  }
  if (recorded) {
    const offered = before.find((release) => release.changes.some((change) => change.id === "endpoint-added" && change.operationId === id));
    if (offered === undefined) {
      reasons.push(
        changelog.releases.some((release) => release.changes.some((change) => change.id === "endpoint-added" && change.operationId === id))
          ? `no release before the graduation offered it, so it has not had four weeks (${QUIET_DAYS} days) with no breaking change`
          : `no release has offered it yet, so it has not had four weeks (${QUIET_DAYS} days) with no breaking change`,
      );
    } else {
      const days = daysBetween(offered.date, decided);
      if (days < QUIET_DAYS) {
        reasons.push(`the release that offered it, ${offered.version} on ${offered.date}, came ${days} days before the decision, and the test needs four weeks (${QUIET_DAYS} days)`);
      }
    }
  }
  return reasons;
}

/** Whole days from one calendar day to a later one. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/** Every operation of an OpenAPI document: its id, method, path and stability level. */
function documentOperations(text: string): { id: string; method: string; path: string; level: unknown }[] {
  const document = JSON.parse(text) as { paths?: Record<string, Record<string, { operationId?: string; "x-stability-level"?: unknown }>> };
  return Object.entries(document.paths ?? {}).flatMap(([path, operations]) =>
    METHODS.flatMap((method) => {
      const operation = operations[method];
      return operation === undefined ? [] : [{ id: operation.operationId ?? `${method.toUpperCase()} ${path}`, method, path, level: operation["x-stability-level"] }];
    }),
  );
}

/** The tools of the snapshot, with the operation each names and its level. */
function snapshotTools(text: string): { name: string; operationId?: string; stability?: unknown }[] {
  const tools = (JSON.parse(text) as { tools?: { name?: string; operationId?: unknown; stability?: unknown }[] }).tools ?? [];
  return tools.map(({ name, operationId, stability }) => ({
    name: name ?? "without a name",
    ...(typeof operationId === "string" ? { operationId } : {}),
    stability,
  }));
}

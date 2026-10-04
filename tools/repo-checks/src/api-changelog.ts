import { parseChangelog, releaseItems, type ApiChange, type ChangelogItem, type ChangelogRelease } from "@tiehall/catalog/changelog";
import { runOnDocuments } from "./oasdiff.ts";
import { packetNoticeProblems } from "./packet-compat.ts";

// The API changelog of each release (public-api: The changelog page and the
// release notes; design.md, Technical decisions: T12). When a release is
// made, the pinned oasdiff's changelog of openapi/v1.json, from the previous
// release's document to the release's own, is recorded in
// openapi/changelog.json, newest first, with the maintainers' unreleased
// entries, which the release now carries. The image built for the release
// carries the file, so its /docs/api/changelog lists every release up to it,
// and the release notes carry the same items, both from releaseItems().
// Tiehall emails nobody about API changes: the page and the notes are the
// notice.

/** The document the first release is compared with: no operation at all, so each one it has is listed as added. */
export const EMPTY_DOCUMENT = `${JSON.stringify({ openapi: "3.1.0", info: { title: "Tiehall API", version: "0.0.0" }, paths: {} }, null, 2)}\n`;

/** oasdiff's changelog from one document to another, both as JSON text: every change, errors, warnings and information. */
export async function apiChanges(base: string, revision: string): Promise<ApiChange[]> {
  const run = await runOnDocuments(["changelog", "--format=json"], base, revision);
  let found: { id: string; level: 1 | 2 | 3; text: string; operation?: string; path?: string; operationId?: string }[];
  try {
    found = JSON.parse(run.stdout) as typeof found;
  } catch {
    throw new Error(`oasdiff could not list the changes (exit ${run.status}): ${run.stderr.trim()}`);
  }
  return found.map(({ id, level, operation, path, operationId, text }) => ({
    id,
    level,
    ...(operation === undefined ? {} : { method: operation }),
    ...(path === undefined ? {} : { path }),
    ...(operationId === undefined ? {} : { operationId }),
    text,
  }));
}

export interface ReleaseToRecord {
  /** openapi/changelog.json before the release. */
  changelog: string;
  /** Tiehall's release, such as 1.4.0. */
  version: string;
  /** The calendar day of the release. */
  date: string;
  /** openapi/v1.json of the previous release; none for the first release. */
  previousDocument?: string;
  /** openapi/v1.json of this release. */
  document: string;
}

/** openapi/changelog.json with the release recorded, and the release's record. */
export async function recordRelease(options: ReleaseToRecord): Promise<{ changelog: string; release: ChangelogRelease }> {
  const raw = JSON.parse(options.changelog) as Record<string, unknown>;
  const changelog = parseChangelog(options.changelog);
  if (changelog.releases.some(({ version }) => version === options.version)) throw new Error(`Release ${options.version} is already recorded.`);
  // No release contains a breaking packet change until 14 days after its notice (handoff-packet: Breaking packet changes before publication).
  const early = packetNoticeProblems(changelog, options.date);
  if (early.length > 0) throw new Error(early.join("\n"));
  const apiVersion = (JSON.parse(options.document) as { info?: { version?: string } }).info?.version ?? "";
  const release: ChangelogRelease = {
    version: options.version,
    date: options.date,
    apiVersion,
    entries: changelog.unreleased,
    changes: await apiChanges(options.previousDocument ?? EMPTY_DOCUMENT, options.document),
  };
  const recorded = {
    ...("$comment" in raw ? { $comment: raw["$comment"] } : {}),
    unreleased: [],
    releases: [release, ...changelog.releases].map(orderRelease),
  };
  const text = `${JSON.stringify(recorded, null, 2)}\n`;
  // The recorded file must parse as the page reads it: this refuses a bad version, day or API version.
  parseChangelog(text);
  return { changelog: text, release };
}

/** A release's fields, and its entries' and changes' fields, in the order the file keeps them. */
function orderRelease({ version, date, apiVersion, entries, changes }: ChangelogRelease): ChangelogRelease {
  return {
    version,
    date,
    apiVersion,
    entries: entries.map(({ date: day, kind, text, operationIds, schemas }) => ({
      date: day,
      kind,
      text,
      ...(operationIds === undefined ? {} : { operationIds }),
      ...(schemas === undefined ? {} : { schemas }),
    })),
    changes: changes.map(({ id, level, method, path, operationId, text }) => ({
      id,
      level,
      ...(method === undefined ? {} : { method }),
      ...(path === undefined ? {} : { path }),
      ...(operationId === undefined ? {} : { operationId }),
      text,
    })),
  };
}

const LABELS: Readonly<Record<ChangelogItem["kind"], string>> = {
  breaking: "Breaking",
  note: "Note",
  graduation: "Graduated",
  error: "Breaking",
  warning: "Warning",
  info: "",
};

/** The API section of a release's notes, in Markdown: the same items as the changelog page. */
export function releaseNotes(release: ChangelogRelease): string {
  const items = releaseItems(release);
  const lines = [
    "## API changes",
    "",
    `The REST API is at version ${release.apiVersion} in this release. Every install lists these changes on /docs/api/changelog.`,
    "",
    ...(items.length === 0 ? ["No change to the API."] : items.map(noteLine)),
    "",
  ];
  return lines.join("\n");
}

function noteLine(item: ChangelogItem): string {
  const about = [
    ...(item.method !== undefined && item.path !== undefined ? [`\`${item.method} ${item.path}\``] : []),
    ...(item.operationIds !== undefined && item.operationIds.length > 0 ? [`(${item.operationIds.join(", ")})`] : []),
  ];
  const label = LABELS[item.kind];
  const lead = [label, ...about].filter((part) => part !== "").join(" ");
  return `- ${lead === "" ? "" : `${lead}: `}${item.text}`;
}

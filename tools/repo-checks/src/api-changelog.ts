import { finalVersionOf, parseChangelog, releaseItems, type ApiChange, type ChangelogEntry, type ChangelogItem, type ChangelogRelease } from "@tiehall/catalog/changelog";
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
// notice. A release candidate gets no record of its own (design.md, Technical
// decisions: T13, R-e): its final version's record collects every change and
// every entry, the hand-written ones included, and the candidate's notes carry
// that record once it is made, or before it the entries waiting for it.

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
  const final = finalVersionOf(options.version);
  if (final !== undefined) {
    throw new Error(
      `${options.version} is a release candidate, which gets no record of its own in openapi/changelog.json: record its final version, ${final}, ` +
        "which collects every API change and every entry, the hand-written ones included.",
    );
  }
  const raw = JSON.parse(options.changelog) as Record<string, unknown>;
  const changelog = parseChangelog(options.changelog);
  if (changelog.releases.some(({ version }) => version === options.version)) throw new Error(`Release ${options.version} is already recorded.`);
  // No release contains a breaking packet change until 14 days after its notice (handoff-packet: Breaking packet changes before publication).
  const early = packetNoticeProblems(changelog.unreleased, options.date);
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

/** What a release candidate's notes list of the API while its final version is not recorded yet: the entries waiting for it. */
export interface WaitingApiChanges {
  /** The final version whose record will hold the candidate's changes and these entries, such as 1.4.0. */
  final: string;
  /** The OpenAPI document's info.version in the release candidate, such as 0.4.0. */
  apiVersion: string;
  /** The maintainers' entries no release carries yet, under unreleased. */
  entries: ChangelogEntry[];
}

/**
 * The API section of a release's notes, in Markdown: the same items as the changelog page. The version is the
 * release's own; a release candidate's notes carry its final version's record, or the entries waiting for it.
 */
export function releaseNotes(api: ChangelogRelease | WaitingApiChanges, version = "version" in api ? api.version : api.final): string {
  if ("final" in api) {
    const items = releaseItems({ entries: api.entries, changes: [] });
    return [
      "## API changes",
      "",
      `The REST API is at version ${api.apiVersion} in this release candidate. A release candidate records no API changes of its own: ` +
        `they are recorded under ${api.final}, with the entries below, and listed in its notes and on /docs/api/changelog of an install that runs it. ` +
        "An install that runs this release candidate lists the entries on /docs/api/changelog as not released yet.",
      "",
      ...(items.length === 0 ? [`No entry waits for ${api.final}.`] : items.map(noteLine)),
      "",
    ].join("\n");
  }
  const items = releaseItems(api);
  const lead =
    version === api.version
      ? `The REST API is at version ${api.apiVersion} in this release. Every install lists these changes on /docs/api/changelog.`
      : `This release candidate carries the API changes recorded for ${api.version}, and the REST API is at version ${api.apiVersion} in it. ` +
        "Every install that runs it lists these changes on /docs/api/changelog.";
  return ["## API changes", "", lead, "", ...(items.length === 0 ? ["No change to the API."] : items.map(noteLine)), ""].join("\n");
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

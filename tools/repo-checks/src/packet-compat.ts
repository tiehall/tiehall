import { addedEntries, API_BREAKING_LABEL, parseChangelog, type Changelog, type ChangelogEntry } from "@tiehall/catalog/changelog";
import { packetValidator } from "@tiehall/packet";

// Breaking packet changes before publication (handoff-packet: Breaking packet
// changes before publication; design.md, Design rules: Handoff packet;
// design.md, Readings to confirm with the founder: R22). Before the packet
// schema is published, a breaking change to it is announced in the changelog
// at least 14 days before it takes effect, which is when a release first
// contains it. CI checks every pull request:
// - every version of every valid conformance fixture, as far back as the
//   repository's history goes, that validates against the packet schema at
//   the merge base must still validate against the pull request's schema; a
//   version that no longer validated at the merge base was broken by an
//   earlier announced change and is left out;
// - a valid fixture of the merge base may change, as JSON, or be removed only
//   as part of a breaking change; new valid fixtures, and invalid ones, may
//   come and go freely;
// - a pull request that breaks either rule passes only with the api-breaking
//   label and a changelog entry it adds, of kind breaking, about the packet
//   (schemas: ["packet"]), dated no earlier than the day the check runs, since
//   the notice counts from that date.
// When a release is recorded, packetNoticeProblems() refuses it while an
// unreleased breaking packet change is less than 14 days old. A changelog that
// does not parse fails the check, label or not.

/** How long a breaking packet change is announced before a release may contain it. */
export const PACKET_NOTICE_DAYS = 14;

/** One version of a valid fixture, as a commit of the repository held it. */
export interface FixtureVersion {
  /** Its path under the fixtures folder, such as valid/request-packet.json. */
  name: string;
  text: string;
  /** The commit that holds this version, when it comes from the history. */
  commit?: string;
}

export interface PacketPullRequest {
  /** Every version of every valid fixture up to the merge base. */
  fixturesEver: readonly FixtureVersion[];
  /** The valid fixtures at the merge base, by name. */
  validBase: Readonly<Record<string, string>>;
  /** The valid fixtures in the pull request, by name. */
  validRevision: Readonly<Record<string, string>>;
  /** The packet schema at the merge base; none before it existed. */
  schemaBase?: string;
  /** The packet schema in the pull request. */
  schemaRevision: string;
  labels: readonly string[];
  /** openapi/changelog.json at the merge base; none when it did not exist there. */
  changelogBase?: string;
  /** openapi/changelog.json in the pull request. */
  changelogRevision: string;
  /** The calendar day the check runs, in UTC. */
  today: string;
}

export interface PacketCompatResult {
  passed: boolean;
  /** Whether the pull request carries the api-breaking label. */
  labelled: boolean;
  /** What breaks: each fixture that stops validating, and each valid fixture that changes or is removed. */
  breaks: string[];
  /** Why the check fails besides what breaks: the label's conditions not met, or a changelog that does not parse. */
  problems: string[];
}

/** The fixture-compatibility check of a pull request. */
export function checkPacketPullRequest(pullRequest: PacketPullRequest): PacketCompatResult {
  const labelled = pullRequest.labels.includes(API_BREAKING_LABEL);
  const problems: string[] = [];
  let base: Changelog | undefined;
  let revision: Changelog | undefined;
  try {
    base = pullRequest.changelogBase === undefined ? undefined : parseChangelog(pullRequest.changelogBase);
  } catch {
    // An unparsable changelog at the merge base counts as none: every entry of the pull request's is new.
    base = undefined;
  }
  try {
    revision = parseChangelog(pullRequest.changelogRevision);
  } catch (error) {
    problems.push(`openapi/changelog.json does not parse:\n${(error as Error).message}`);
  }

  const breaks = [...fixturesThatStopValidating(pullRequest), ...changedValidFixtures(pullRequest)];
  if (breaks.length > 0) {
    if (!labelled) {
      problems.push(
        `The pull request breaks packet fixtures and carries no ${API_BREAKING_LABEL} label. Before the packet schema is published, a ` +
          `breaking packet change needs the ${API_BREAKING_LABEL} label and a changelog entry of kind breaking about the packet, ` +
          `and no release contains it until ${PACKET_NOTICE_DAYS} days after the entry's date.`,
      );
    } else if (revision !== undefined) {
      const notices = addedEntries(base, revision).filter(isPacketBreak);
      if (notices.length === 0) {
        problems.push(
          `The pull request carries the ${API_BREAKING_LABEL} label but adds no changelog entry of kind breaking about the packet to ` +
            'openapi/changelog.json; add one under unreleased, with "schemas": ["packet"], dated today, that says what breaks.',
        );
      }
      for (const { date } of notices) {
        if (date < pullRequest.today) {
          problems.push(
            `The changelog entry for the breaking packet change is dated ${date}, before ${pullRequest.today}, the day of this check; ` +
              "the notice counts from its date, so date it today or later.",
          );
        }
      }
    }
  }
  return { passed: problems.length === 0, labelled, breaks, problems };
}

/** Each version of a valid fixture that validated against the merge base's schema and fails against the pull request's. */
function fixturesThatStopValidating(pullRequest: PacketPullRequest): string[] {
  if (pullRequest.schemaBase === undefined) return [];
  const before = packetValidator(JSON.parse(pullRequest.schemaBase) as Record<string, unknown>);
  const after = packetValidator(JSON.parse(pullRequest.schemaRevision) as Record<string, unknown>);
  const versions: FixtureVersion[] = [...pullRequest.fixturesEver, ...Object.entries(pullRequest.validBase).map(([name, text]) => ({ name, text }))];
  const seen = new Set<string>();
  const breaks: string[] = [];
  for (const { name, text, commit } of versions) {
    const packet = parsed(text);
    const key = `${name}\n${JSON.stringify(packet)}`;
    if (packet === undefined || seen.has(key)) continue;
    seen.add(key);
    if (before(packet) && !after(packet)) {
      breaks.push(`${name}${commit === undefined ? "" : ` as of ${commit.slice(0, 12)}`} validated against the packet schema at the merge base and fails against the pull request's.`);
    }
  }
  return breaks;
}

/** Each valid fixture of the merge base that the pull request changes, as JSON, or removes. */
function changedValidFixtures({ validBase, validRevision }: PacketPullRequest): string[] {
  const breaks: string[] = [];
  for (const [name, text] of Object.entries(validBase)) {
    const now = validRevision[name];
    if (now === undefined) breaks.push(`${name} is removed.`);
    else if (canonical(parsed(now)) !== canonical(parsed(text))) breaks.push(`${name} changes.`);
  }
  return breaks;
}

/** The unreleased breaking packet changes a release on this day would contain before their notice has run. */
export function packetNoticeProblems(changelog: Changelog, releaseDate: string): string[] {
  return changelog.unreleased.filter(isPacketBreak).flatMap(({ date }) => {
    const allowed = addDays(date, PACKET_NOTICE_DAYS);
    return releaseDate < allowed ? [`The breaking packet change announced on ${date} may be released from ${allowed} on, not on ${releaseDate}.`] : [];
  });
}

function isPacketBreak(entry: ChangelogEntry): boolean {
  return entry.kind === "breaking" && (entry.schemas ?? []).includes("packet");
}

/** A JSON value as text with every object's keys sorted, so a fixture whose keys only move has not changed. */
function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(sorted(value)) ?? "";
}

/** A JSON text, parsed; undefined when it is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The calendar day a number of days after another, both as YYYY-MM-DD. */
function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

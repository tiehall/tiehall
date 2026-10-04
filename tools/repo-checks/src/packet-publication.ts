import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKET_MEDIA_TYPE } from "@tiehall/catalog";
import { section } from "./markdown.ts";
import { readReleaseTree, releasedVersions, RELEASES_FOLDER } from "./packet-releases.ts";

// The packet schema's publication, as the repository records it
// (handoff-packet: The beta label; handoff-packet: The packet media type;
// handoff-packet: When the schema is published; handoff-packet: Publication
// includes all four parts; handoff-packet: The npm package). Three things
// turn over together when the maintainers publish the schema: the
// publication switch, packages/packet/publication.json, which makes packets
// carry schema_version "1.0" (packages/catalog/src/packet.ts); the
// release-URL tree, packages/packet/releases/, which gains v1.0
// (packet-releases.ts); and the packet's spec, the schema directory's
// README, which labels the schema beta until then and from then on names the
// packet's media type, the only place it is named, while the API serves
// packets as application/json. publicationProblems holds the three
// together. The CI job that publishes @tiehall/packet stays off until the
// tree holds a release, and the package takes the latest release's version,
// v1.<minor> as 1.<minor>.0.

/** The publication switch, relative to the repository's root. */
export const PUBLICATION_SWITCH = "packages/packet/publication.json";

/** The packet's spec: the schema directory's README. */
export const PACKET_SPEC = "packages/packet/README.md";

export type Publication = { published: false } | { published: true; version: string };

/** The packet's publication, from the release-URL tree of the repository at this root. */
export function packetPublication(root: string): Publication {
  const latest = releasedVersions(readReleaseTree(join(root, RELEASES_FOLDER))).at(-1);
  return latest === undefined ? { published: false } : { published: true, version: `${latest}.0` };
}

/** Whether the publication switch of the repository at this root is on. */
export function publicationSwitch(root: string): boolean {
  const file = join(root, PUBLICATION_SWITCH);
  if (!existsSync(file)) return false;
  return (JSON.parse(readFileSync(file, "utf8")) as { published?: unknown }).published === true;
}

/** Every rule the packet's spec breaks for the schema's stage, as a sentence. */
export function packetSpecProblems(spec: string, published: boolean): string[] {
  const problems: string[] = [];
  const title = /^# (.*)$/m.exec(spec)?.[1] ?? "";
  const beta = /\bbeta\b/i.test(title);
  if (!published) {
    if (!beta) problems.push(`${PACKET_SPEC}: does not label the schema beta in its title, which it is until publication.`);
    return problems;
  }
  if (beta) problems.push(`${PACKET_SPEC}: still labels the schema beta in its title.`);
  const mediaType = section(spec, "Media type") ?? "";
  if (!mediaType.includes(PACKET_MEDIA_TYPE) || !mediaType.includes("application/json")) {
    problems.push(
      `${PACKET_SPEC}: has no section Media type that names ${PACKET_MEDIA_TYPE} as the packet's media type and says the API serves packets as application/json.`,
    );
  }
  return problems;
}

/** Every way the switch, the release-URL tree and the spec of the repository at this root do not turn over together. */
export function publicationProblems(root: string): string[] {
  const published = publicationSwitch(root);
  const released = releasedVersions(readReleaseTree(join(root, RELEASES_FOLDER)));
  const problems: string[] = [];
  if (published && released.length === 0) {
    problems.push(`${PUBLICATION_SWITCH}: says the schema is published, but ${RELEASES_FOLDER} holds no release; the publication adds v1.0 with it.`);
  }
  if (!published && released.length > 0) {
    problems.push(`${PUBLICATION_SWITCH}: says the schema is not published, but ${RELEASES_FOLDER} holds v${released[0] ?? ""}; the publication turns the switch on with it.`);
  }
  problems.push(...packetSpecProblems(readFileSync(join(root, PACKET_SPEC), "utf8"), published));
  return problems;
}

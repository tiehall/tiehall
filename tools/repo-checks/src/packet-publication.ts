import { join } from "node:path";
import { readReleaseTree, releasedVersions, RELEASES_FOLDER } from "./packet-releases.ts";

// Whether the packet schema is published, as the CI job that publishes
// @tiehall/packet reads it (handoff-packet: The npm package; handoff-packet:
// When the schema is published; handoff-packet: Fixed release URLs). The
// schema is published once the release-URL tree holds a release; until then
// the job stays off. The package then takes the latest release's version,
// v1.<minor> as 1.<minor>.0.

export type Publication = { published: false } | { published: true; version: string };

/** The packet's publication, from the release-URL tree of the repository at this root. */
export function packetPublication(root: string): Publication {
  const latest = releasedVersions(readReleaseTree(join(root, RELEASES_FOLDER))).at(-1);
  return latest === undefined ? { published: false } : { published: true, version: `${latest}.0` };
}

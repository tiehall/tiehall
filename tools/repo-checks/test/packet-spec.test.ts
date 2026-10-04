import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PACKET_SPEC, packetSpecProblems, publicationProblems, PUBLICATION_SWITCH } from "../src/packet-publication.ts";
import { RELEASES_FOLDER } from "../src/packet-releases.ts";

// The published spec and the publication switch (handoff-packet: The packet
// media type; handoff-packet: The beta label; handoff-packet: Publication
// includes all four parts). The schema directory's README is the packet's
// spec. Before publication it labels the schema beta; from publication on it
// names the packet's media type, application/vnd.tiehall.packet+json;
// version=1, the only place the media type is named, and says the API serves
// packets as application/json. The publication switch, the release-URL tree
// and the spec turn over together: the switch is on exactly when the tree
// holds a release, and the spec matches the switch.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const README = readFileSync(join(root, PACKET_SPEC), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "tiehall-packet-spec-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A published spec, as the publication writes it, with its media type section given or left out. */
function publishedSpec(mediaType = true): string {
  return [
    "# The handoff packet, `tiehall.packet/v1`",
    "",
    "A Tiehall request carries a handoff packet.",
    "",
    ...(mediaType
      ? ["## Media type", "", "The packet's media type is `application/vnd.tiehall.packet+json; version=1`. Tiehall's API serves packets as `application/json`.", ""]
      : []),
    "## Versioning",
    "",
    "v1 only gains optional fields.",
    "",
  ].join("\n");
}

describe("the packet's spec", () => {
  it("labels the schema beta before publication, as the README does now", () => {
    expect(packetSpecProblems(README, false)).toEqual([]);
    expect(packetSpecProblems(publishedSpec(), false)).toEqual(["packages/packet/README.md: does not label the schema beta in its title, which it is until publication."]);
  });

  it("names the media type from publication on, and says the API serves packets as application/json", () => {
    expect(packetSpecProblems(publishedSpec(), true)).toEqual([]);
    expect(packetSpecProblems(publishedSpec(false), true)).toEqual([
      "packages/packet/README.md: has no section Media type that names application/vnd.tiehall.packet+json; version=1 as the packet's media type and says the API serves packets as application/json.",
    ]);
  });

  it("fails a publication that left the beta spec as it was", () => {
    expect(packetSpecProblems(README, true)).toEqual([
      "packages/packet/README.md: still labels the schema beta in its title.",
      "packages/packet/README.md: has no section Media type that names application/vnd.tiehall.packet+json; version=1 as the packet's media type and says the API serves packets as application/json.",
    ]);
  });
});

describe("the publication", () => {
  let made = 0;
  /** A repository root of the test's own with the switch, the spec and the release-URL tree as given. */
  function repository(published: boolean, spec: string, releases: readonly string[]): string {
    made += 1;
    const folder = join(scratch, `repo-${made}`);
    mkdirSync(join(folder, "packages/packet"), { recursive: true });
    writeFileSync(join(folder, PUBLICATION_SWITCH), `${JSON.stringify({ published }, null, 2)}\n`);
    writeFileSync(join(folder, PACKET_SPEC), spec);
    if (releases.length > 0) mkdirSync(join(folder, RELEASES_FOLDER), { recursive: true });
    for (const name of releases) writeFileSync(join(folder, RELEASES_FOLDER, name), "{}\n");
    return folder;
  }

  it("passes the repository: the switch is off, no release is published and the spec is beta", () => {
    expect(publicationProblems(root)).toEqual([]);
  });

  it("passes a publication that turns the switch on with the first release and the published spec", () => {
    expect(publicationProblems(repository(true, publishedSpec(), ["v1.0.json", "v1.json"]))).toEqual([]);
  });

  it("fails a switch that does not match the release-URL tree", () => {
    expect(publicationProblems(repository(true, publishedSpec(), []))).toEqual([
      "packages/packet/publication.json: says the schema is published, but packages/packet/releases holds no release; the publication adds v1.0 with it.",
    ]);
    expect(publicationProblems(repository(false, README, ["v1.0.json", "v1.json"]))).toEqual([
      "packages/packet/publication.json: says the schema is not published, but packages/packet/releases holds v1.0; the publication turns the switch on with it.",
    ]);
  });
});

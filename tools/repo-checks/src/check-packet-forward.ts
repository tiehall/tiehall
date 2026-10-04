import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkPacketForward, type PacketRelease } from "./packet-forward.ts";
import { fixtureVersionsEver, validFixturesInTree } from "./packet-history.ts";
import { readReleaseTree, releasedVersions, RELEASES_FOLDER } from "./packet-releases.ts";

// CI's forward-compatibility check of the packet (handoff-packet: v1 only
// gains optional fields after publication): once v1.0 is published, the
// committed schema, which the next v1.x release would publish, only adds
// optional fields to every published release, every version of every valid
// fixture that validated against a release still validates, and every valid
// fixture validates against every release. The published releases are the
// files v1.<minor>.json of the release-URL tree, packages/packet/releases/;
// before the first one, the check passes and says so.
// Usage: node tools/repo-checks/src/check-packet-forward.ts

const root = fileURLToPath(new URL("../../../", import.meta.url));
/** The committed schema, which the next release would publish. */
const CANDIDATE = `${root}packages/packet/schema/v1-beta.json`;

const tree = readReleaseTree(join(root, RELEASES_FOLDER));
const releases: PacketRelease[] = releasedVersions(tree).map((version) => ({ version, text: tree.get(`v${version}.json`) ?? "" }));

if (releases.length === 0) {
  console.log(
    "No release of the packet schema is published yet, so no v1.x release constrains it: from v1.0 on, a release only adds optional fields. " +
      "Until then, a breaking packet change needs its notice (pnpm check:packet-compat).",
  );
} else {
  const candidateFixtures = validFixturesInTree(root);
  const result = checkPacketForward({
    releases,
    candidate: readFileSync(CANDIDATE, "utf8"),
    candidateFixtures,
    fixturesEver: fixtureVersionsEver(root, "HEAD"),
  });
  const names = releases.map(({ version }) => `v${version}`).join(", ");
  if (result.passed) {
    console.log(
      `The packet schema only adds optional fields to ${names}: every fixture that validated against a release still validates, ` +
        `and the ${Object.keys(candidateFixtures).length} valid fixtures validate against every release.`,
    );
  } else {
    console.error(`The packet schema breaks a published release (${names}):`);
    for (const problem of result.problems) console.error(`- ${problem}`);
    console.error(
      "\nFrom publication on, a v1.x release only adds optional fields: it adds no required field, removes no field and changes no " +
        "constraint of a field a release defines, so that a packet built against it validates against every older release " +
        "(handoff-packet: v1 only gains optional fields after publication). A change that needs more is a v2.",
    );
    process.exitCode = 1;
  }
}

import { cachedOasdiff, OASDIFF } from "./oasdiff.ts";
import { OASDIFF_CACHE, recordOasdiffFixtures } from "./oasdiff-fixtures.ts";

// Records the pinned oasdiff's outputs for the fixture pairs again, with the
// checksum-verified binary: `pnpm oasdiff:fixtures` from the repository's
// root, after changing a pair or the pin. The binary is downloaded once, its
// archive checked against pins.json, and kept in this package's
// node_modules/.cache.

const binary = await cachedOasdiff(OASDIFF_CACHE);
const pairs = recordOasdiffFixtures(binary);
console.log(`Recorded oasdiff ${OASDIFF.version}'s outputs for ${pairs.length} fixture pairs: ${pairs.join(", ")}.`);

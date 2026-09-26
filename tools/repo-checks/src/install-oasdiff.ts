import { oasdiff, OASDIFF_VERSION } from "./oasdiff.ts";

// Downloads and verifies the pinned oasdiff before a CI job runs it:
// `node tools/repo-checks/src/install-oasdiff.ts`.
console.log(`oasdiff ${OASDIFF_VERSION}, verified: ${await oasdiff()}`);

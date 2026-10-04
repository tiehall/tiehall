import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { packageContentProblems, packedFiles, packTarball, tarballConformance } from "./package-check.ts";

// Checks a built @tiehall/packet before it is published (handoff-packet: The
// npm package): its pack dry run holds the types, the validator, the fixture
// runner, the schema and the fixtures, and no renderer or source; and its
// tarball, installed as a consumer installs it, has a validator that accepts
// every valid fixture and rejects every invalid one, and types a consumer's
// TypeScript compiles against. The CI job that publishes runs it first.
// Usage: node packages/packet/src/check-package.ts <built package folder>

const folder = process.argv[2];
if (folder === undefined) {
  console.error("Usage: node packages/packet/src/check-package.ts <built package folder>");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "tiehall-packet-check-"));
try {
  const files = packedFiles(folder);
  const problems = packageContentProblems(folder, files);
  const result = tarballConformance(packTarball(folder, scratch), join(scratch, "consumer"));
  problems.push(...result.problems);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else {
    console.log(
      `@tiehall/packet packs ${files.length} files, with no renderer and no source, and its validator accepts the ${result.valid} valid ` +
        `fixtures and rejects the ${result.invalid} invalid ones.`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

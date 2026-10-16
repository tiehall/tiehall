// Checks an encode of the README's film before it is uploaded as the
// README's attachment (task 30.11; design.md, Decisions this change rests on:
// D38 (2); GP-4 and GP-19 of docs/maintainers/going-public.md). The
// repository holds the film's poster alone, so the encode stays outside it:
// the check refuses one inside the repository. It passes an encode GitHub's
// free plan takes and plays while it downloads: H.264 at 1280 by 720 and AAC,
// about 53 seconds, under 10 MB, its index before its media data, and none of
// its source's metadata. It uses only Node built-ins.
// Usage: node tools/repo-checks/src/check-film.ts <encode.mp4>
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { encodeProblems } from "./film.ts";

const USAGE = "Usage: node tools/repo-checks/src/check-film.ts <encode.mp4>";
const root = fileURLToPath(new URL("../../../", import.meta.url));

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length !== 1 || (args[0] ?? "").startsWith("-")) {
  console.error(USAGE);
  process.exit(2);
}

const encode = resolve(args[0] ?? "");
const fromRoot = relative(root, encode);
if (!(fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))) {
  console.error(
    `${encode} lies inside the repository, which holds the film's poster alone: keep the encode outside the repository, ` +
      "and upload it as the README's attachment at the switch to public (GP-19 of docs/maintainers/going-public.md).",
  );
  process.exit(2);
}
if (!existsSync(encode)) {
  console.error(`${encode} does not exist. ${USAGE}`);
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(encode));
const problems = encodeProblems(bytes);
if (problems.length > 0) {
  console.error(`${basename(encode)} is not the encode the README can play:`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    `${basename(encode)} is an encode the README can play: H.264 at 1280 by 720 and AAC, about 53 seconds, ` +
      `${(bytes.byteLength / 1_000_000).toFixed(1)} MB, its index before its media data, and no metadata of its source.`,
  );
}

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { FixtureVersion } from "./packet-compat.ts";

// The packet's valid conformance fixtures, as the repository's history and
// working tree hold them (handoff-packet: Breaking packet changes before
// publication; handoff-packet: v1 only gains optional fields after
// publication): every version of every valid fixture up to a commit, read
// from the commit that made it, and the valid fixtures of one commit or of
// the working tree, each by its name under the fixtures folder, such as
// valid/request-packet.json. The fixture-compatibility checks read them.

/** The valid fixtures' folder, relative to the repository's root. */
export const VALID_FIXTURES = "packages/packet/fixtures/valid/";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

/** A file as a commit holds it; undefined when it does not. */
export function fileAt(root: string, ref: string, file: string): string | undefined {
  try {
    return git(root, "show", `${ref}:${file}`);
  } catch {
    return undefined;
  }
}

/** Every version of every valid fixture up to this commit, each read from the commit that made it. */
export function fixtureVersionsEver(root: string, ref: string): FixtureVersion[] {
  const versions: FixtureVersion[] = [];
  for (const commit of lines(git(root, "log", "--format=%H", ref, "--", VALID_FIXTURES))) {
    for (const file of lines(git(root, "diff-tree", "-r", "--root", "--no-commit-id", "--name-only", commit, "--", VALID_FIXTURES))) {
      const text = file.endsWith(".json") ? fileAt(root, commit, file) : undefined;
      if (text !== undefined) versions.push({ name: `valid/${file.slice(VALID_FIXTURES.length)}`, text, commit });
    }
  }
  return versions;
}

/** The valid fixtures a commit holds, by name. */
export function validFixturesAt(root: string, ref: string): Record<string, string> {
  return Object.fromEntries(
    lines(git(root, "ls-tree", "-r", "--name-only", ref, "--", VALID_FIXTURES))
      .filter((file) => file.endsWith(".json"))
      .map((file) => [`valid/${file.slice(VALID_FIXTURES.length)}`, fileAt(root, ref, file) ?? ""]),
  );
}

/** The valid fixtures of the working tree, by name. */
export function validFixturesInTree(root: string): Record<string, string> {
  const folder = `${root}${root.endsWith("/") ? "" : "/"}${VALID_FIXTURES}`;
  if (!existsSync(folder)) return {};
  return Object.fromEntries(
    readdirSync(folder)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [`valid/${name}`, readFileSync(`${folder}${name}`, "utf8")]),
  );
}

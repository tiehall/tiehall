import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { section } from "../src/markdown.ts";
import { lineAt, trackedTextFiles, type TextFile } from "../src/tracked-files.ts";

// Nothing personal in the public repository (task 30.8; design.md, Decisions
// this change rests on: D38). The maintainer answered on 2026-10-16 that
// nothing personal may remain in it. This check reads every tracked or new
// text file for what names a real person in a form it can know without naming
// them: a home folder's path, written with slashes or, as an agent's scratch
// folder writes it, with dashes, other than the made-up people's of specs and
// tests; an email address that is no placeholder's, GitHub's own or the
// public author's no-reply one; and the maintainer's GitHub user name outside
// that no-reply address, where it is their public identity on purpose. What
// only a list can name, such as the maintainer's own addresses, machines and
// other projects, GP-2 of docs/maintainers/going-public.md finds with a
// personal.txt kept outside the repository. The client-matrix log, the record
// of runs on the maintainer's own accounts, names their machine and install
// only as "the maintainer's machine" and "a test install", as its rules say.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** The made-up people whose home folders specs and tests use as examples. */
const MADE_UP = new Set(["sam", "kq7user"]);

/** A home folder's path, with the user name as its group: /Users/<name> or /home/<name>, or -Users-<name>- as an agent's scratch folder writes it. */
const HOME_FOLDERS = [/(?:^|[^\w.-])\/(?:Users|home)\/([\w.-]+)/g, /-(?:Users|home)-([\w.]+)/g];

/** An email address, not the user information of a URL or of git's own address form, whose last label is a word. */
const EMAIL = /(?<![\w.%+\-/:])([\w.%+-]+)@((?:[\w-]+\.)+[A-Za-z]{2,})(?![\w-])/g;

/** Domains kept for examples (RFC 2606 and 6761), and their subdomains. */
const PLACEHOLDER_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i;

/** GitHub's own addresses: its no-reply sender and the user of an SSH remote. */
const GITHUB_OWN = new Set(["noreply@github.com", "git@github.com"]);

/** The public history's author, as the checklist for making the repository public names them (GP-7). */
const PUBLIC_AUTHOR = /<((\d+)\+([\w-]+)@users\.noreply\.github\.com)>/.exec(read("docs/maintainers/going-public.md"));

/** Each home folder's path in the files whose user is not a made-up person's, as path:line: name. */
function realHomeFolders(files: TextFile[]): string[] {
  return files.flatMap(({ path, text }) =>
    HOME_FOLDERS.flatMap((pattern) =>
      [...text.matchAll(pattern)].flatMap((match) => (MADE_UP.has(match[1] ?? "") ? [] : [`${path}:${lineAt(text, match.index)}: ${match[1]}`])),
    ),
  );
}

/** Each email address in the files that is no placeholder's, GitHub's own or the public author's, as path:line: address. */
function realAddresses(files: TextFile[], publicAddress: string): string[] {
  return files.flatMap(({ path, text }) =>
    [...text.matchAll(EMAIL)].flatMap((match) => {
      const [address = "", , domain = ""] = match;
      if (PLACEHOLDER_DOMAIN.test(domain) || GITHUB_OWN.has(address.toLowerCase()) || address === publicAddress) return [];
      return [`${path}:${lineAt(text, match.index)}: ${address}`];
    }),
  );
}

/** Each place the files name the user name outside the public author's address, as path:line. */
function userNameOutside(files: TextFile[], user: string, publicAddress: string): string[] {
  const name = new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return files.flatMap(({ path, text }) => {
    const outside = text.split(publicAddress).join("");
    return [...outside.matchAll(name)].map((match) => `${path}:${lineAt(outside, match.index)}`);
  });
}

describe("personal data in the repository", () => {
  const files = trackedTextFiles(root).filter(({ path }) => path !== "tools/repo-checks/test/personal-data.test.ts");

  it("finds a real person's home folder, written with slashes or dashes, and an address that is no placeholder's", () => {
    const fixture: TextFile[] = [
      {
        path: "docs/notes.md",
        text: [
          "Kept in /Users/pat/notes and in /home/kim/app;",
          "written to /private/tmp/claude-501/-Users-pat-Projects-app/out.txt.",
          "Fine: /home/sam/web, -Users-kq7user-Projects-app, https://example.com/news/home/2026, ./home/readme.",
          "Mail pat@pat.dev or kim@school.edu.",
          "Fine: alice@acme.example, bob@example.com, x@example.invalid, noreply@github.com, https://user@api.github.com, tiehall@1.3.0.",
        ].join("\n"),
      },
    ];
    expect(realHomeFolders(fixture)).toEqual(["docs/notes.md:1: pat", "docs/notes.md:1: kim", "docs/notes.md:2: pat"]);
    expect(realAddresses(fixture, "1+someone@users.noreply.github.com")).toEqual(["docs/notes.md:4: pat@pat.dev", "docs/notes.md:4: kim@school.edu"]);
    expect(userNameOutside(fixture, "kim", "1+someone@users.noreply.github.com")).toEqual(["docs/notes.md:1", "docs/notes.md:4"]);
  });

  it("names no home folder but the made-up people's", () => {
    expect(realHomeFolders(files)).toEqual([]);
  });

  it("names no email address but placeholders', GitHub's own and the public author's no-reply one", () => {
    expect(PUBLIC_AUTHOR, "GP-7 names the public author").not.toBeNull();
    expect(realAddresses(files, PUBLIC_AUTHOR?.[1] ?? "")).toEqual([]);
  });

  it("names the maintainer's GitHub user name only in the public author's no-reply address", () => {
    const [, address = "", , user = ""] = PUBLIC_AUTHOR ?? [];
    expect(user).not.toBe("");
    expect(userNameOutside(files, user, address)).toEqual([]);
  });

  it("names, in the client-matrix log, the maintainer's machine and installs only as such, as the log's rules say", () => {
    const log = read("docs/client-matrix/log.md");
    expect(section(log, "How an entry is written")).toContain('say "the maintainer\'s machine" and "a test install"');
    const fields = (name: string) => log.split("\n").filter((line) => line.startsWith(`- **${name}:**`));
    expect(fields("OS").length).toBeGreaterThan(0);
    // The OS field names the system, and the machine only as the maintainer's.
    expect(fields("OS").filter((line) => !line.includes("the maintainer's machine"))).toEqual([]);
    expect(fields("Install").filter((line) => !/\bas in the entry above\b|\ba test install\b/.test(line))).toEqual([]);
    // No device's model, account plan or local install of the maintainer's.
    expect(log).not.toMatch(/\b(?:Mac|MacBook|iMac)\b/);
    expect(log).not.toMatch(/maintainer's (?:\w+ )?(?:plan|account|local)\b/);
  });
});

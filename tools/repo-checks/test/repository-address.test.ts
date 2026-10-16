import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lineAt, trackedTextFiles } from "../src/tracked-files.ts";

// The repository's address (task 30.7; design.md, Decisions this change rests
// on: D38). The repository lives at github.com/tiehall/tiehall, as the
// maintainer answered on 2026-10-16. Every file that names it there, as a
// GitHub address, as the contract Action's `uses:` line or as the plugin
// marketplace's `claude plugin marketplace add` command, names
// tiehall/tiehall, unless it names a placeholder owner such as acme, as the
// examples of a fork or a company's own copy do. Image names such as
// ghcr.io/acme/tiehall are the release's placeholders and stay.

const root = fileURLToPath(new URL("../../../", import.meta.url));
/** This test, whose fixture names a stray owner on purpose. */
const SELF = "tools/repo-checks/test/repository-address.test.ts";

/** The repository, as owner/name. */
const HOME = "tiehall/tiehall";

/** Owners that stand for someone's own copy in examples, never the project's. */
const PLACEHOLDER_OWNERS = new Set(["acme", "acme-oss", "example", "example-user", "<owner>"]);

/** Where a file names a repository by owner/name: the owner and the name are the pattern's two groups. */
const NAMED = [
  // A web or git address on GitHub, its name ending where no word character or hyphen follows, so an App's page is no repository.
  /github\.com[/:]([\w.-]+|<owner>)\/([\w.]*?)(?:\.git)?(?![\w-])/gi,
  // The contract Action, as a workflow's step names it.
  /uses:\s+([\w.-]+|<owner>)\/([\w.-]+)\/actions\/contract@/gi,
  // The plugin's marketplace, as Claude Code adds it from GitHub, at a tag after #.
  /marketplace add ([\w.-]+|<owner>)\/([\w.-]+)(?:#\S*)?/gi,
];

/** Each place a file names the project's repository with another owner or name than its home's, as path:line: owner/name. */
function strayAddresses(files: { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) =>
    NAMED.flatMap((pattern) =>
      [...text.matchAll(pattern)].flatMap((match) => {
        const [, owner = "", name = ""] = match;
        if (name.toLowerCase() !== "tiehall") return [];
        if (`${owner}/${name}` === HOME || PLACEHOLDER_OWNERS.has(owner.toLowerCase())) return [];
        return [`${path}:${lineAt(text, match.index)}: ${owner}/${name}`];
      }),
    ),
  );
}

const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the repository's address", () => {
  it("finds an address that names another owner, and leaves placeholders and an App's page alone", () => {
    const fixture = [
      "Source: https://github.com/someone/Tiehall and git+https://github.com/someone/tiehall.git",
      "      - uses: someone/Tiehall/actions/contract@0123456789abcdef0123456789abcdef01234567 # v0.1.0",
      "claude plugin marketplace add someone/Tiehall#v1.3.0",
      "Fine: https://github.com/tiehall/tiehall/tree/main, https://github.com/acme/tiehall, uses: <owner>/tiehall/actions/contract@<sha>,",
      "https://github.com/apps/tiehall-example-localhost, ghcr.io/acme/tiehall and claude plugin marketplace add acme/tiehall#v1.3.0",
    ].join("\n");
    expect(strayAddresses([{ path: "docs/example.md", text: fixture }])).toEqual([
      "docs/example.md:1: someone/Tiehall",
      "docs/example.md:1: someone/tiehall",
      "docs/example.md:2: someone/Tiehall",
      "docs/example.md:3: someone/Tiehall",
    ]);
  });

  it("is tiehall/tiehall in every tracked file that names it", () => {
    expect(strayAddresses(trackedTextFiles(root).filter(({ path }) => path !== SELF))).toEqual([]);
  });

  it("is the source link, the reporting form, the packet package's repository and the marketplace's owner", () => {
    expect(read("packages/commands/src/running-version.ts")).toContain('DEFAULT_SOURCE_REPOSITORY = "https://github.com/tiehall/tiehall";');
    expect(read("SECURITY.md")).toContain("(https://github.com/tiehall/tiehall/security/advisories/new)");
    expect(read("packages/packet/src/build-package.ts")).toContain('url: "git+https://github.com/tiehall/tiehall.git"');
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json")) as { owner: { url?: string } };
    expect(marketplace.owner.url).toBe("https://github.com/tiehall/tiehall");
    expect(read("docs/claude-code-plugin.md")).toContain("claude plugin marketplace add tiehall/tiehall");
    expect(read("actions/contract/README.md")).toMatch(/uses: tiehall\/tiehall\/actions\/contract@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    expect(read("docs/contract-changes.md")).toContain("`uses: tiehall/tiehall/actions/contract@<commit SHA> # v0.1.0`");
  });
});

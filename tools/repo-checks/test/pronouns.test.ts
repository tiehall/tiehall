import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isChecked, pronounProblems } from "../src/pronouns.ts";
import { repositoryFiles } from "../src/source-citations.ts";

// The repository refers to people as they and them (CONTRIBUTING.md): the
// check fails on a gendered pronoun in a TypeScript or Markdown file outside
// openspec/ and the tests' fixtures.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = "tools/repo-checks/test/pronouns.test.ts";

describe("the pronoun check", () => {
  it("names each gendered pronoun as a whole word, in any case, and nothing else", () => {
    const text = [
      "Dana is removed, which ends her session.",
      "He confirms it; then she, Himself and HERSELF.",
      "His and hers, him.",
      "The other theme, there, this, shell, shim, hero, them, the help.",
    ].join("\n");
    expect(pronounProblems("sample.ts", text)).toEqual([
      { file: "sample.ts", line: 1, word: "her" },
      { file: "sample.ts", line: 2, word: "He" },
      { file: "sample.ts", line: 2, word: "she" },
      { file: "sample.ts", line: 2, word: "Himself" },
      { file: "sample.ts", line: 2, word: "HERSELF" },
      { file: "sample.ts", line: 3, word: "His" },
      { file: "sample.ts", line: 3, word: "hers" },
      { file: "sample.ts", line: 3, word: "him" },
    ]);
  });

  it("reads TypeScript and Markdown outside openspec/ and the fixtures", () => {
    expect(["a/b.ts", "apps/web/app/page.tsx", "docs/install.md", "openspec/changes/x/design.md", "tools/repo-checks/test/fixtures/a/README.md", "a/b.json"].filter(isChecked)).toEqual([
      "a/b.ts",
      "apps/web/app/page.tsx",
      "docs/install.md",
    ]);
  });
});

describe("the repository's TypeScript and Markdown", () => {
  it("refer to people as they and them", () => {
    const problems = repositoryFiles(root)
      .filter((file) => isChecked(file) && file !== SELF)
      .flatMap((file) => {
        let text: string;
        try {
          text = readFileSync(join(root, file), "utf8");
        } catch {
          return [];
        }
        return pronounProblems(file, text).map(({ line, word }) => `${file}:${line}: ${word}`);
      });
    expect(problems).toEqual([]);
  });
});

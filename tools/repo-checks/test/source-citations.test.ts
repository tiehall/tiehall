import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { citationProblems, readCitedText, readSources, repositoryFiles } from "../src/source-citations.ts";

// Source citations (task 3.4; design.md, Decisions this change rests on: D38).
// Every citation of a requirement or a design decision in the repository's
// code, configuration and docs names one that the public specs and design.md
// hold, so no comment points at planning material kept out of the repository.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sources = readSources(root);

function problemsIn(text: string) {
  return citationProblems("sample.ts", text, sources).map(({ citation, problem }) => ({ citation, problem }));
}

describe("the citation check", () => {
  it("reads the current capabilities and the decisions design.md lists", () => {
    expect(sources.requirements.get("self-host-install")).toContain("Release pipeline integrity");
    expect(sources.requirements.has("operations")).toBe(false);
    for (const decision of ["D3", "D28", "D38", "T1", "T17", "S1", "S16"]) expect(sources.decisions.has(decision), decision).toBe(true);
    expect(sources.decisions.has("D1")).toBe(false);
  });

  it("accepts citations of current requirements, also where the name runs on to the next line", () => {
    expect(
      problemsIn(
        [
          "// The CI check (self-host-install: Release pipeline integrity). It runs gitleaks.",
          "// (self-host-install: Only the migrate step holds the",
          "// database owner's credentials; activity-log: The activity log is append-only)",
          '  "description": "Updates under self-host-install: Release pipeline integrity: nothing younger than 7 days."',
          "// self-host-install: Logs carry ids, never message text or credentials.",
          "// (design.md, Technical decisions: T1; design.md, Self-hosting decisions: S14; D3)",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("refuses capabilities of the earlier hosted plan, requirements that do not exist, and unlisted decisions", () => {
    expect(
      problemsIn(
        [
          "// CI check for operations: Build pipeline integrity.",
          "// The public health check (operations draft §4, TLS).",
          "// Logs (self-host-install: setup code).",
          "// One entrypoint (design.md decision 1).",
          "// The image name follows the organization (D32).",
          "// (design.md, Technical decisions: T99)",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({ citation: "operations: Build pipeline integrity." }),
      expect.objectContaining({ citation: "operations draft" }),
      { citation: "self-host-install: setup code", problem: 'self-host-install has no requirement named "setup code"' },
      expect.objectContaining({ citation: "design.md decision 1" }),
      { citation: "D32", problem: "design.md lists no decision D32" },
      { citation: "Technical decisions: T99", problem: "design.md has no technical decision T99" },
    ]);
  });
});

describe("the files the check reads", () => {
  // A file a commit is about to add is checked before the commit, so a wrong
  // citation in it fails locally rather than on main after the push.
  it("are the committed files and the new ones git does not ignore, openspec/ left out", () => {
    const scratch = mkdtempSync(join(tmpdir(), "tiehall-citations-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: scratch });
      git("init", "--quiet", "--initial-branch=main");
      writeFileSync(join(scratch, ".gitignore"), "ignored/\n");
      writeFileSync(join(scratch, "committed.ts"), "// committed\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "Start");
      writeFileSync(join(scratch, "staged.ts"), "// staged\n");
      git("add", "staged.ts");
      writeFileSync(join(scratch, "new.ts"), "// new, not yet added\n");
      mkdirSync(join(scratch, "ignored"));
      writeFileSync(join(scratch, "ignored", "notes.md"), "ignored\n");
      mkdirSync(join(scratch, "openspec"));
      writeFileSync(join(scratch, "openspec", "draft.md"), "a change being written\n");
      expect(repositoryFiles(scratch).sort()).toEqual([".gitignore", "committed.ts", "new.ts", "staged.ts"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // The install's fonts and icons are files of the repository (web-ui: The install serves its own assets; design.md,
  // Design: The install's assets; D57 (14)), and the bytes of a font or an image can spell a decision number. Every
  // WOFF2, PNG and ICO file holds a NUL byte, which no text file of the repository does.
  it("leave out a file that holds a NUL byte, such as a font or an image, and one that cannot be read", () => {
    const scratch = mkdtempSync(join(tmpdir(), "tiehall-citations-"));
    try {
      writeFileSync(join(scratch, "font.woff2"), Buffer.from("wOF2\u0000 the bytes spell D99"));
      writeFileSync(join(scratch, "notes.ts"), "// D99\n");
      expect(readCitedText(scratch, "font.woff2")).toBeUndefined();
      expect(readCitedText(scratch, "notes.ts")).toBe("// D99\n");
      expect(readCitedText(scratch, "missing.ts")).toBeUndefined();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the repository's citations", () => {
  it("name only current requirements and the decisions design.md lists", () => {
    const problems = repositoryFiles(root).flatMap((file) => {
      const text = readCitedText(root, file);
      if (text === undefined) return [];
      return citationProblems(file, text, sources).map(({ line, citation, problem }) => `${file}:${line}: ${citation} (${problem})`);
    });
    expect(problems).toEqual([]);
  });
});

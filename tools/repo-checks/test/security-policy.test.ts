import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { headings, linkProblems, links, section } from "../src/markdown.ts";

// The security policy (task 28.4; design.md, Decisions this change rests on:
// D38). SECURITY.md says how to report a vulnerability privately, through
// GitHub's private vulnerability reporting on the public repository, never in
// a public issue, and which releases get fixes. The check finds both
// sections and what each must say, finds every link resolving, the
// repository it names being the one the web UI's source link names, and the
// README and the contributors' guide linking the policy.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const policy = existsSync(join(root, "SECURITY.md")) ? readFileSync(join(root, "SECURITY.md"), "utf8") : "";

/** A section of the policy as one line of text, or the empty text when it has none. */
const part = (heading: string) => (section(policy, heading) ?? "").replace(/\s+/g, " ");

/** The public repository, as the running version's source link names it by default (packages/commands/src/running-version.ts). */
const repository = /DEFAULT_SOURCE_REPOSITORY = "([^"]+)"/.exec(readFileSync(join(root, "packages/commands/src/running-version.ts"), "utf8"))?.[1] ?? "";

describe("SECURITY.md", () => {
  it("has a section on reporting a vulnerability and one on which releases get fixes", () => {
    const level2 = headings(policy)
      .filter(({ level }) => level === 2)
      .map(({ text }) => text);
    expect(level2).toEqual(expect.arrayContaining(["Reporting a vulnerability", "Which releases get fixes"]));
  });

  it("asks for a private report through GitHub's private vulnerability reporting, never a public issue", () => {
    const text = part("Reporting a vulnerability");
    for (const phrase of ["privately", "private vulnerability reporting", "Report a vulnerability", "public issue"]) expect(text, phrase).toContain(phrase);
    expect(repository).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    expect(links(section(policy, "Reporting a vulnerability") ?? "").map(({ target }) => target)).toContain(`${repository}/security/advisories/new`);
  });

  it("names no email address, so a report goes only through the repository's private advisories", () => {
    expect(links(policy).filter(({ target }) => target.startsWith("mailto:"))).toEqual([]);
    expect(policy).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  });

  it("says which releases get fixes, how a fix reaches an install and each client piece, and what a fix may break", () => {
    const text = part("Which releases get fixes");
    for (const phrase of ["latest release", "patch release", "skipped", "Debian", "`tiehall` CLI", "contract Action", "commit SHA", "Claude Code plugin", "`api-breaking`", "changelog"]) {
      expect(text, phrase).toContain(phrase);
    }
    expect(links(section(policy, "Which releases get fixes") ?? "").map(({ target }) => target)).toContain("docs/install.md#upgrade");
  });

  it("has links that all resolve, and the README and the contributors' guide link it", () => {
    expect(linkProblems(root, "SECURITY.md")).toEqual([]);
    for (const file of ["README.md", "CONTRIBUTING.md"]) {
      expect(links(readFileSync(join(root, file), "utf8")).map(({ target }) => target), file).toContain("SECURITY.md");
    }
  });
});

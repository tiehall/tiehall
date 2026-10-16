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

  // The terms the policy was written with (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55
  // (84)): one private channel, fixes in the latest release, credit unless the reporter declines it, and no promise of a
  // response time, which a small team could not keep.
  it("keeps its terms: one private channel, the latest release fixed, credit unless declined, and no response time", () => {
    const reporting = part("Reporting a vulnerability");
    expect(reporting).toContain("through GitHub's private vulnerability reporting");
    expect(reporting).toContain("Do not report a vulnerability in a public issue, a pull request, a discussion or anywhere else in public.");
    // The reporting form is the one way it names to report.
    expect(links(section(policy, "Reporting a vulnerability") ?? "").map(({ target }) => target)).toEqual([`${repository}/security/advisories/new`]);

    const releases = part("Which releases get fixes");
    expect(releases).toContain("Tiehall's first release, 1.0.0, came out on 2026-10-16");
    expect(releases).toContain("A security fix comes in a new patch release of the latest release. Earlier releases are not patched");

    expect(part("What happens after a report")).toContain("credits you unless you ask not to be named");

    expect(policy).not.toMatch(/\b\d+\s*(?:business\s+)?(?:hours?|days?|weeks?|months?)\b/i);
    expect(policy).not.toMatch(/response times?|\bSLA\b|\bwithin\b/i);
  });

  it("has links that all resolve, and the README and the contributors' guide link it", () => {
    expect(linkProblems(root, "SECURITY.md")).toEqual([]);
    for (const file of ["README.md", "CONTRIBUTING.md"]) {
      expect(links(readFileSync(join(root, file), "utf8")).map(({ target }) => target), file).toContain("SECURITY.md");
    }
  });
});

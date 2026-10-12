import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fencedBlocks } from "../src/docs-commands.ts";
import { loadLicenseMap } from "../src/licenses.ts";
import { headings, linkProblems, links, section } from "../src/markdown.ts";

// The contributors' guide (task 28.3; public-api: The license map; public-api:
// The `api-breaking` label for urgent security fixes). CONTRIBUTING.md has a
// section for each topic: building and testing, tests first, the OpenSpec
// workflow, the license of each directory, the notice rules with the
// api-breaking label, no model SDKs, and running the client matrix. The check
// finds each section and what it must say, finds every link resolving, and
// finds that every pnpm script the guide names is one the repository has.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const guide = existsSync(join(root, "CONTRIBUTING.md")) ? readFileSync(join(root, "CONTRIBUTING.md"), "utf8") : "";

/** A section of the guide as one line of text, or the empty text when it has none. */
const part = (heading: string) => (section(guide, heading) ?? "").replace(/\s+/g, " ");

const TOPICS = [
  "Building and testing",
  "Tests first",
  "The OpenSpec workflow",
  "The license of each directory",
  "The notice rules and the `api-breaking` label",
  "No model SDKs",
  "Running the client matrix",
];

describe("CONTRIBUTING.md", () => {
  it("has a section for each topic", () => {
    const level2 = headings(guide)
      .filter(({ level }) => level === 2)
      .map(({ text }) => text);
    expect(TOPICS.filter((topic) => !level2.includes(topic))).toEqual([]);
  });

  it("has links that all resolve, and the README links it", () => {
    expect(linkProblems(root, "CONTRIBUTING.md")).toEqual([]);
    expect(links(readFileSync(join(root, "README.md"), "utf8")).map(({ target }) => target)).toContain("CONTRIBUTING.md");
  });

  it("names only pnpm scripts the repository has, in its code spans and its commands", () => {
    const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const spans = [...guide.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
    const commands = [...spans, ...fencedBlocks(guide).map(({ text }) => text)].join("\n");
    const named = [...commands.matchAll(/\bpnpm (?!install\b|-r\b|--filter\b|exec\b|vitest\b)([a-z][a-z0-9:-]*)/g)].map((match) => match[1] ?? "");
    expect(named.length).toBeGreaterThan(5);
    expect([...new Set(named)].filter((name) => !Object.hasOwn(scripts, name))).toEqual([]);
  });

  it("says how to build and test, with what each kind of test needs", () => {
    const text = part("Building and testing");
    for (const phrase of [".node-version", "pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm test", "Docker", "Postgres 17", "pnpm test:image", "pnpm test:install", "TIEHALL_TEST_CHROME", "pnpm openapi:generate", "pnpm mcp:generate", "pnpm packet:generate", "7 days"]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  // self-host-install: Release pipeline integrity; decisions-from-groups-15-28, D55 (86).
  it("says how a security fix takes a version younger than the 7-day release age: its exclusion, its record and its label", () => {
    const text = part("Building and testing");
    for (const phrase of [
      "fixable HIGH or CRITICAL finding",
      "exactly the version the advisory names as fixed",
      "never automatically",
      "`<package>@<version>` to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`",
      "tools/repo-checks/release-age-exceptions.json",
      "the day the version turns 7 days old",
      "`release-age-exception` label",
      "pnpm check:workflows",
      "The release notes list the exceptions",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("says that tests come first, and how a test written ahead of its task is committed", () => {
    const text = part("Tests first");
    for (const phrase of ["failing test", "`it.fails`", "`it.todo`", "timeout"]) expect(text, phrase).toContain(phrase);
  });

  it("says how a change goes through OpenSpec", () => {
    const text = part("The OpenSpec workflow");
    for (const phrase of ["openspec/changes/", "openspec/specs/", "openspec/config.yaml", "Source:", "openspec validate --all --strict", "tasks.md", "proposal.md", "design.md"]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("names the license of each directory as the license map gives it, and the import rule", () => {
    const text = part("The license of each directory");
    const map = loadLicenseMap();
    for (const folder of Object.keys(map.clientPieces)) expect(text, folder).toContain(`\`${folder}/\``);
    for (const phrase of ["AGPL-3.0", "Apache-2.0", "tools/repo-checks/license-map.json", "pnpm check:licenses", "pnpm lint:deps", "`packages/catalog/`", "maintainers"]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("states the notice rules, the api-breaking label and what it needs", () => {
    const text = part("The notice rules and the `api-breaking` label");
    for (const phrase of [
      "`alpha`",
      "`beta`",
      "`stable`",
      "14 days",
      "180 days",
      "`x-sunset`",
      "`api-breaking`",
      "urgent security fix",
      "openapi/changelog.json",
      "`info.version`",
      "mcp/tools.json",
      "packet",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("says that no package may depend on a model SDK, with the lists and checks that hold it", () => {
    const text = part("No model SDKs");
    for (const file of ["tools/repo-checks/model-sdk-denylist.json", "tools/repo-checks/telemetry-sdk-denylist.json"]) {
      expect(text, file).toContain(file);
      expect(existsSync(join(root, file)), file).toBe(true);
    }
    for (const phrase of ["pnpm check:model-sdks", "pnpm-lock.yaml", "image"]) expect(text, phrase).toContain(phrase);
  });

  it("says how the maintainers run the client matrix: every client, protocol version and sign-in path, and fetching off", () => {
    const text = part("Running the client matrix");
    for (const phrase of [
      "Claude Code",
      "Cursor",
      "Codex",
      "Copilot",
      "2026-07-28",
      "2025-11-25",
      "metadata document",
      "Dynamic Client Registration",
      "TIEHALL_CLIENT_METADATA_FETCH=off",
      "mcp/tools.json",
      "URL-mode elicitation",
      "`asyncRewake`",
      "personal access token",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });
});

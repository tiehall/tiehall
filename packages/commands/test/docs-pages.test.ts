import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_REPOSITORY, DOCS_PAGES, docsLinks, docsUrl } from "../src/index.ts";

// The docs pages the admin UI links (task 28.6; agent-surfaces: Four agent
// surfaces; contract-changes: The contract Action; design.md, Where the specs
// leave room: the admin UI's layout). The admin page links each page of the
// user and admin docs at the running version's docs: the public repository's
// docs/ at the release's tag, or at a development build's commit. A modified
// server's TIEHALL_SOURCE_URL names where its source is, which need not lay
// its docs out the same way, so the docs links keep to the public repository
// the image was built from, at the version the server is built on.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("the docs pages the admin UI links", () => {
  it("are Markdown pages of the repository's docs, each with a title, none twice", () => {
    expect(DOCS_PAGES.length).toBeGreaterThan(0);
    for (const { path, title } of DOCS_PAGES) {
      expect(path).toMatch(/^docs\/[a-z-]+\.md$/);
      expect(existsSync(`${repoRoot}${path}`), path).toBe(true);
      expect(readFileSync(`${repoRoot}${path}`, "utf8").split("\n")[0], path).toMatch(/^# \S/);
      expect(title.length).toBeGreaterThan(0);
    }
    expect(new Set(DOCS_PAGES.map(({ path }) => path)).size).toBe(DOCS_PAGES.length);
  });

  it("are linked at the release's tag in the public repository the image was built from", () => {
    const links = docsLinks({ TIEHALL_VERSION: "1.3.0", TIEHALL_COMMIT_SHA: COMMIT, TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall" });
    expect(links).toEqual(DOCS_PAGES.map(({ path, title }) => ({ title, url: `https://github.com/acme-oss/tiehall/blob/v1.3.0/${path}` })));
  });

  it("are linked at a development build's commit, or at main when the build names none", () => {
    expect(docsLinks({ TIEHALL_VERSION: "0.0.0-dev", TIEHALL_COMMIT_SHA: COMMIT, TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall" })[0]?.url).toBe(
      `https://github.com/acme-oss/tiehall/blob/${COMMIT}/${DOCS_PAGES[0]?.path}`,
    );
    expect(docsLinks({})[0]?.url).toBe(`${DEFAULT_SOURCE_REPOSITORY}/blob/main/${DOCS_PAGES[0]?.path}`);
  });

  it("keep to the public repository when a modified server sets TIEHALL_SOURCE_URL", () => {
    const links = docsLinks({ TIEHALL_VERSION: "1.3.0", TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall", TIEHALL_SOURCE_URL: "https://git.acme.example/tiehall-fork" });
    expect(links[0]?.url).toBe(`https://github.com/acme-oss/tiehall/blob/v1.3.0/${DOCS_PAGES[0]?.path}`);
  });
});

// Every page's footer links the docs too, for every person who uses the install, not only admins: the docs folder
// of the public repository, at the running version's docs, as the admin page's links are.
describe("the docs the footer links", () => {
  it("are the docs folder at the running version's docs in the public repository, whatever TIEHALL_SOURCE_URL says", () => {
    expect(docsUrl({ TIEHALL_VERSION: "1.3.0", TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall" })).toBe("https://github.com/acme-oss/tiehall/tree/v1.3.0/docs");
    expect(docsUrl({ TIEHALL_VERSION: "0.0.0-dev", TIEHALL_COMMIT_SHA: COMMIT, TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall" })).toBe(
      `https://github.com/acme-oss/tiehall/tree/${COMMIT}/docs`,
    );
    expect(docsUrl({})).toBe(`${DEFAULT_SOURCE_REPOSITORY}/tree/main/docs`);
    expect(docsUrl({ TIEHALL_VERSION: "1.3.0", TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall", TIEHALL_SOURCE_URL: "https://git.acme.example/tiehall-fork" })).toBe(
      "https://github.com/acme-oss/tiehall/tree/v1.3.0/docs",
    );
  });
});

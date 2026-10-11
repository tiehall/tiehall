import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The browser suites of web-ui-design hold on slow CI runners (design.md,
// Design: Testing; D57): each of their hooks, which start and stop a test
// install, the web app and Chrome, has a timeout of 300 seconds, and each of
// their tests one of at least 120 seconds, as the change's rules for every
// task ask. A suite is read here as a file, never imported, so none of its
// hooks runs.

/** The browser suites of the web UI's design and the live hall. */
const SUITES = [
  "admin-pages-design-browser.test.ts",
  "focused-pages-design-browser.test.ts",
  "hall-browser.test.ts",
  "hall-page-browser.test.ts",
  "member-pages-design-browser.test.ts",
  "next-shell-browser.test.ts",
  "page-policies-browser.test.ts",
  "request-pages-design-browser.test.ts",
  "shell-browser.test.ts",
];

/** A timeout as the suites write it, such as 300_000, in milliseconds. */
const ms = (written: string) => Number(written.replace(/_/g, ""));

describe.each(SUITES)("%s", (suite) => {
  const source = readFileSync(fileURLToPath(new URL(`./${suite}`, import.meta.url)), "utf8");

  it("gives each of its hooks a timeout of 300 seconds", () => {
    const hooks = source.match(/^(?:beforeAll|afterAll|beforeEach|afterEach)\(/gm) ?? [];
    const timeouts = [...source.matchAll(/^\}, ([\d_]+)\);$/gm)].map(([, written = ""]) => ms(written));
    expect(timeouts).toHaveLength(hooks.length);
    expect(timeouts.filter((timeout) => timeout !== 300_000)).toEqual([]);
  });

  it("gives each of its tests a timeout of at least 120 seconds", () => {
    const tests = source.match(/^\s*it(?:\.each)?\(/gm) ?? [];
    const timeouts = [...source.matchAll(/\{ timeout: ([\d_]+) \},\s*async\b/g)].map(([, written = ""]) => ms(written));
    expect(timeouts).toHaveLength(tests.length);
    expect(timeouts.filter((timeout) => timeout < 120_000)).toEqual([]);
  });
});

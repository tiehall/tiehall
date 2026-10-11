import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { headings, linkProblems, section } from "../src/markdown.ts";

// The web UI's docs (web-ui: The live hall; web-ui: The live hall's reads and
// its long-poll; web-ui: Text in the system's fonts; web-ui: The content
// security policy of each kind of page; design.md, Design: Testing; D57 (4) to
// (9), (11), (12); D61). docs/web-ui.md has a section for the pages and their
// navigation, themes and motion, phone width, the live hall, the type and the
// policy of each kind of page, each saying what a person needs to know; the
// admin page links it among the docs (DOCS_PAGES) and the README lists it; the
// install docs say how long a reverse proxy must let a response take and that
// the setup screen loads its assets before setup; the security docs name the
// pages that run no script and what the live hall shows; and CONTRIBUTING.md
// names the commands that write the icons and the assets' digests, and where
// CI keeps the screenshots.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const PAGE = "docs/web-ui.md";
const read = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "");
const page = read(PAGE);

/** A section of a page as one line of text, or the empty text when it has none. */
const flat = (markdown: string, heading: string) => (section(markdown, heading) ?? "").replace(/\s+/g, " ");

/** Each section of docs/web-ui.md, and what it must say, each phrase as it says it once its white space is made single spaces. */
const SECTIONS: Readonly<Record<string, readonly string[]>> = {
  "Pages and navigation": ["Skip to content", "Live hall", "Inbox", "Requests", "Members", "Admin", "N waiting", "New request", "gold", "Email settings", "Connected agents and tokens", "without JavaScript"],
  "Themes and motion": ["light or dark preference", "no theme setting", "dark whatever the preference", "within 5 seconds", "reduced motion", "Pause motion"],
  "Phone width": ["320 CSS pixels", "200 percent", "24 by 24", "768", "lists instead of its map"],
  "The live hall": [
    "`/hall`",
    "last 10 minutes",
    "Security events, to anyone, admins included",
    "a message's text, the packet's text",
    "unverified",
    "`team=<KEY>`",
    "`agents=1`",
    "`/hall/state`",
    "`/hall/wait`",
    "within 2 seconds",
    "25 seconds",
    "Reconnecting",
    "no event stream and no WebSocket",
    "does not keep its session alive",
    "7 days",
  ],
  Type: ["system's own fonts", "No page loads a font", "no font files", "Turkish"],
  "What each kind of page may load and run": ["no script at all", "`/assets/hall.js`", "Trusted Types", "the framework's scripts", "`/docs/api`", "No page allows a font", "no `style` element and no `style` attribute"],
};

describe("the web UI's docs", () => {
  it("have a section for each topic, which says what a person needs to know", () => {
    const level2 = headings(page)
      .filter(({ level }) => level === 2)
      .map(({ text }) => text);
    expect(Object.keys(SECTIONS).filter((heading) => !level2.includes(heading))).toEqual([]);
    for (const [heading, phrases] of Object.entries(SECTIONS)) {
      const text = flat(page, heading);
      expect(phrases.filter((phrase) => !text.includes(phrase)), heading).toEqual([]);
    }
  });

  it("are a page the admin UI links and the README lists, whose links all resolve", () => {
    expect(read("packages/commands/src/docs-pages.ts")).toContain(`path: "${PAGE}"`);
    expect(flat(read("README.md"), "Documentation")).toContain(`](${PAGE})`);
    expect(page.split("\n")[0]).toMatch(/^# \S/);
    expect(linkProblems(root, PAGE)).toEqual([]);
  });

  it("say in the install docs that a proxy must let a response take 70 seconds, and that the setup screen loads its assets before setup", () => {
    const install = read("docs/install.md").replace(/\s+/g, " ");
    expect(flat(read("docs/install.md"), "Start the install")).toMatch(/at least 70 seconds.*60 seconds.*25/);
    expect(install).toContain("the stylesheet and the icons the setup screen loads");
  });

  it("name in the security docs the pages that run no script, and what the live hall shows and never shows", () => {
    const text = flat(read("docs/security-and-trust.md"), "The web UI's pages");
    for (const phrase of ["run no script", "review page", "consent screen", "device approval page", "setup screen", "sign-in page", "refusal page", "live hall", "security event", "titles", "logins"]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("name in CONTRIBUTING.md the commands that write the icons and the assets' digests, and where CI keeps the screenshots", () => {
    const text = read("CONTRIBUTING.md").replace(/\s+/g, " ");
    for (const phrase of ["`pnpm icons:generate`", "`pnpm assets:digests`", "`test-results/screens/`", "`screens-1`"]) expect(text, phrase).toContain(phrase);
  });
});

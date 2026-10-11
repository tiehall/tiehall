import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { shellHtml } from "@tiehall/commands/html";
import type { ShellMember } from "@tiehall/commands/shell";
import { AppShell, FocusedShell } from "../lib/shell.tsx";

// The shell of the pages Next.js renders (web-ui: The page shell and its
// navigation; design.md, Design: The page shell and navigation; D57 (4)). One
// model, shell.ts, has two renderers: the string shell of the pages the web
// role renders (html.ts), and <AppShell> and <FocusedShell> of the pages
// Next.js renders. For the same member and path they draw the same markup, so
// a request's page and a team's page look as every other page does.

/**
 * Markup with the differences that do not change it taken out: white space
 * between tags, attribute order, character references, and how an empty SVG
 * element or a void element is closed, which React writes as <path></path>.
 */
function normalized(html: string): string {
  const decoded = (text: string) =>
    text
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&quot;|&#34;/g, '"')
      .replace(/&lt;|&#60;/g, "<")
      .replace(/&gt;|&#62;/g, ">")
      .replace(/&amp;|&#38;/g, "&");
  return html
    .replace(/<\/(path|circle)>/g, "")
    .replace(/>\s+</g, "><")
    .replace(/^\s+|\s+$/g, "")
    .replace(/<([a-z][a-z0-9-]*)((?:\s+[a-zA-Z:-]+(?:="[^"]*")?)*)\s*\/?>/g, (_tag, name: string, attributes: string) => {
      const sorted = [...attributes.matchAll(/\s+([a-zA-Z:-]+)(?:="([^"]*)")?/g)].map(([, attribute = "", value]) => (value === undefined ? attribute : `${attribute}="${decoded(value)}"`)).sort();
      return `<${name}${sorted.map((attribute) => ` ${attribute}`).join("")}>`;
    })
    .replace(/>([^<]+)</g, (_text, text: string) => `>${decoded(text)}<`);
}

const MAIN = "<h1>Bob's page</h1><p>Text &amp; more.</p>";

describe("the shell of the pages Next.js renders", () => {
  it.each([
    ["a member", { login: "bob", bot: false, admin: false, waiting: 0 }, "/FE-142"],
    ["an admin with proposals waiting", { login: "ada-l", bot: false, admin: true, waiting: 3 }, "/FE"],
    ["a bot user", { login: "ci-bot", bot: true, admin: false, waiting: 1 }, "/requests"],
  ] as [string, ShellMember, string][])("draws the app shell for %s as the web role's pages draw it", (_who, member, path) => {
    const react = renderToStaticMarkup(
      <AppShell member={member} path={path} csrf="a-csrf-token&x">
        <h1>{"Bob's page"}</h1>
        <p>Text &amp; more.</p>
      </AppShell>,
    );
    expect(normalized(react)).toBe(normalized(shellHtml({ form: "app", member, path, csrf: "a-csrf-token&x" }, MAIN)));
    expect(react).not.toMatch(/<style\b|\sstyle=/i);
    // New request in the style of a page's main action, gold with navy ink, in the top bar and in the folded menu
    // (web-ui: The page shell and its navigation; D61 (2)).
    expect(react.match(/<a [^>]*href="\/requests\/new"[^>]*>New request<\/a>/g)).toEqual(['<a class="button" href="/requests/new">New request</a>', '<a class="button" href="/requests/new">New request</a>']);
  });

  it("draws the focused shell as the web role's pages draw it", () => {
    const react = renderToStaticMarkup(
      <FocusedShell>
        <h1>{"Bob's page"}</h1>
        <p>Text &amp; more.</p>
      </FocusedShell>,
    );
    expect(normalized(react)).toBe(normalized(shellHtml({ form: "focused" }, MAIN)));
    expect(react).not.toMatch(/<nav\b|<details\b/);
  });

  it("gives a page's main content the class it names", () => {
    const react = renderToStaticMarkup(
      <AppShell member={{ login: "bob", bot: false, admin: false, waiting: 0 }} path="/FE-142" csrf="x" className="request-page">
        <h1>FE-142</h1>
      </AppShell>,
    );
    expect(react).toContain('<main id="content" class="request-page">');
  });
});

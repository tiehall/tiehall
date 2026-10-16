import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { contrast, parseCss, selectorsOf, type CssRule } from "../../../packages/commands/test/support/css.ts";
import { headings } from "../src/markdown.ts";
import { taskStates } from "../src/plan.ts";
import { isPublic, loadPublicPaths } from "../src/public-paths.ts";
import { checkWorkflows, loadPolicy } from "../src/workflows.ts";

// The landing page at tiehall.com (task 30.15; design.md, Decisions this
// change rests on: D38), the folder site/: a simple introduction that sends
// people to the public repository, which GitHub Pages publishes at the switch
// to public (GP-22 and GP-23 of docs/maintainers/going-public.md) through
// .github/workflows/pages.yml. It is plain HTML and CSS: no script of any
// kind, nothing loaded from another host, no font file and no tracker, so it
// works without JavaScript and tells its visitors' browsers to run none; the
// one exception is the film, which a frame of the page plays in YouTube's
// privacy-enhanced player only once the visitor starts it (the change
// play-film-from-youtube). The
// check reads the folder as GitHub Pages serves it: every file it holds is one
// the allowlist of public paths holds; every link and image of each page
// resolves, to a file of the folder or to one of the few addresses it may
// name, the public repository, its files and the README's headings, and the
// film's player and page on YouTube; the CNAME names the
// domain; the meta tags give search engines and link previews the name, the
// sentence and the social preview; the brand's images are the brand's own,
// byte for byte; the content says what the README says; the pages are
// accessible, with landmarks, alt text and a focus ring; and every color is
// a token of the web UI's Navy & Gold palette whose text and background
// contrast at least 4.5:1, computed as the web UI's own contrast test does.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const SITE = "site";
const read = (path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "");

/** The brand's tagline, as the setup screen, the film and the social preview give it (packages/commands/src/brand.ts). */
const TAGLINE = /^export const TAGLINE = "([^"]+)";$/m.exec(read("packages/commands/src/brand.ts"))?.[1] ?? "";

/** The public repository, where every link of the page that leaves it points. */
const REPOSITORY = "https://github.com/tiehall/tiehall";
/** Where the page is served, as its meta tags name it. */
const ORIGIN = "https://tiehall.com";
/** The film on YouTube, on the channel of the maintainers' public brand, MamiBot (the change play-film-from-youtube). */
const FILM_ID = "5Fk84aDl-r0";
/** The host of YouTube's privacy-enhanced player, the only host a frame of the page may load. */
const FILM_HOST = "https://www.youtube-nocookie.com";
/** The film in that player, playing at once, which the film's own page links. */
const FILM_PLAYER = `${FILM_HOST}/embed/${FILM_ID}?autoplay=1&rel=0`;
/** The film's page on YouTube, the page's plain link to it. */
const FILM_WATCH = `https://youtu.be/${FILM_ID}`;

/** Every file under a folder of the repository, by its path from the root with forward slashes, sorted. */
function filesUnder(folder: string): string[] {
  const absolute = join(root, folder);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((path) => statSync(join(absolute, path)).isFile())
    .map((path) => posix.join(folder, path.split("\\").join("/")))
    .sort();
}

interface Tag {
  name: string;
  attributes: Record<string, string>;
}

/** The page without its comments, which are no part of what it shows. */
const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");

/** The start tags of a page, in order, each with its attributes; an attribute without a value has the empty one. */
function tags(html: string): Tag[] {
  return [...withoutComments(html).matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].map(([, name = "", rest = ""]) => ({
    name: name.toLowerCase(),
    attributes: Object.fromEntries(
      [...rest.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)].map(([, attribute = "", double, single, bare]) => [
        attribute.toLowerCase(),
        decodeEntities(double ?? single ?? bare ?? ""),
      ]),
    ),
  }));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&rsquo;/g, "’")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** The text a page shows, inside this element if one is named by its id, with white space made single spaces. */
function textOf(html: string, id?: string): string {
  let part = withoutComments(html);
  if (id !== undefined) {
    const start = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>`).exec(part);
    if (start === null) return "";
    const name = start[1] ?? "";
    const rest = part.slice(start.index);
    // The element ends at the closing tag that balances it; the elements a check names by id do not nest in their own kind.
    const end = rest.indexOf(`</${name}>`);
    part = end < 0 ? rest : rest.slice(0, end);
  }
  return decodeEntities(part.replace(/<head\b[\s\S]*?<\/head>/, "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** A text with set type's apostrophe made a typewriter's, so that the README's words and the page's compare. */
const plain = (text: string) => text.replace(/’/g, "'").replace(/\s+/g, " ").trim();

/** The content of a page's meta tag, by its name or property. */
function meta(html: string, key: string): string | undefined {
  return tags(html).find(({ name, attributes }) => name === "meta" && (attributes["name"] === key || attributes["property"] === key))?.attributes["content"];
}

/** Every address a page names: each link, image, stylesheet and icon, and the addresses its meta tags give. */
function references(html: string): { tag: string; attribute: string; value: string }[] {
  const found: { tag: string; attribute: string; value: string }[] = [];
  for (const { name, attributes } of tags(html)) {
    for (const attribute of ["href", "src", "srcset", "poster", "action", "data", "formaction", "background"]) {
      const value = attributes[attribute];
      if (value !== undefined) found.push({ tag: name, attribute, value });
    }
    const content = attributes["content"];
    if (name === "meta" && content !== undefined && /^(?:https?:)?\/\//.test(content)) found.push({ tag: name, attribute: "content", value: content });
  }
  return found;
}

/** The ids of a page's elements. */
const idsOf = (html: string) => new Set(tags(html).flatMap(({ attributes }) => (attributes["id"] === undefined ? [] : [attributes["id"]])));

/** The README's one sentence of what Tiehall is: the paragraph under its name. */
function readmeSentence(): string {
  const header = read("README.md").split(/^## /m)[0] ?? "";
  return [...header.matchAll(/<p align="center">\s*([^<]+?)\s*<\/p>/g)].map(([, text = ""]) => plain(text)).find((text) => text.startsWith("Tiehall ")) ?? "";
}

/** The anchors GitHub gives the README's headings, which a link to the repository's page may name. */
const readmeAnchors = new Set(headings(read("README.md")).map(({ anchor }) => anchor));

/** The plan's tasks, each done or not. */
const plan = taskStates(read("openspec/changes/add-tiehall-oss-v1/tasks.md"));

/**
 * Why an address a page names does not resolve, or undefined when it does: a file of the site, with an id of that
 * page for a fragment; an id of the page itself; or one of the addresses the page may name outside it, the public
 * repository's page, with the README itself or one of its headings, a file or folder the public repository holds on
 * main, the film's player and page on YouTube, and the page's own address on tiehall.com.
 */
function unresolved(page: string, value: string): string | undefined {
  if (value === "") return "an empty address";
  if (value.startsWith("#")) return idsOf(read(page)).has(value.slice(1)) ? undefined : `no element of ${page} has the id ${value.slice(1)}`;
  if (/^https?:|^\/\//i.test(value)) {
    if (value === REPOSITORY || value === `${REPOSITORY}#readme`) return undefined;
    if (value === FILM_PLAYER || value === FILM_WATCH) return undefined;
    const anchor = new RegExp(`^${REPOSITORY}#(.+)$`).exec(value)?.[1];
    if (anchor !== undefined) return readmeAnchors.has(anchor) ? undefined : `the README has no heading whose anchor is ${anchor}`;
    const file = new RegExp(`^${REPOSITORY}/(blob|tree)/main/([^#?]+)$`).exec(value);
    if (file !== null) {
      const [, kind = "", path = ""] = file;
      const absolute = join(root, path);
      if (!existsSync(absolute)) return `the repository holds no ${path}`;
      if (kind === "blob" && !statSync(absolute).isFile()) return `${path} is no file`;
      if (kind === "tree" && !statSync(absolute).isDirectory()) return `${path} is no folder`;
      if (kind === "blob" && !isPublic(path, loadPublicPaths().patterns)) return `the public repository does not hold ${path}`;
      return undefined;
    }
    const own = new RegExp(`^${ORIGIN}(/[^#?]*)$`).exec(value)?.[1];
    if (own !== undefined) return unresolved(page, own);
    return `an address outside the site that it may not name: ${value}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return `an address of another kind: ${value}`;
  const [path = "", fragment] = value.split("#", 2);
  const target = path.startsWith("/") ? posix.join(SITE, path) : posix.join(posix.dirname(page), path);
  const file = target.endsWith("/") || target === SITE ? posix.join(target, "index.html") : target;
  if (!file.startsWith(`${SITE}/`)) return `points outside the site: ${value}`;
  if (!existsSync(join(root, file)) || !statSync(join(root, file)).isFile()) return `the site holds no ${file}`;
  if (fragment !== undefined && !idsOf(read(file)).has(fragment)) return `no element of ${file} has the id ${fragment}`;
  return undefined;
}

const PAGES = ["site/index.html", "site/404.html"];
const index = read("site/index.html");
const notFound = read("site/404.html");
const stylesheet = parseCss(read("site/style.css"));

/** The images of the brand that the site shows, each with the file of the repository it is a copy of. */
const BRAND_COPIES: Readonly<Record<string, string>> = {
  "site/assets/mark.svg": "docs/assets/brand/mark.svg",
  "site/assets/mark.png": "docs/assets/brand/mark.png",
  "site/assets/social-preview.png": "docs/assets/brand/social-preview.png",
  "site/assets/every-teams-line-poster.jpg": "docs/assets/film/every-teams-line-poster.jpg",
};

/**
 * The screenshots of the web UI the page shows, from the repository's own browser test with its made-up people and
 * teams, packages/commands/test/screens-browser.test.ts (the change landing-page-showcase, decision (1)), each with
 * the file of test-results/screens/ it was cropped from.
 */
const SCREENSHOTS: Readonly<Record<string, string>> = {
  "site/assets/screen-confirm.jpg": "admin--confirm-proposal--1280x800--dark.png",
  "site/assets/screen-hall.jpg": "admin--hall--1280x800--dark.png",
  "site/assets/screen-requests.jpg": "admin--requests-list-all--1280x800--dark.png",
};

describe("the landing page's folder", () => {
  it("holds the two pages, the film's page, the stylesheet, the CNAME, the brand's images and the screenshots, and nothing else", () => {
    expect(filesUnder(SITE)).toEqual(
      ["site/404.html", "site/CNAME", ...Object.keys(BRAND_COPIES), ...Object.keys(SCREENSHOTS), "site/film.html", "site/index.html", "site/style.css"].sort(),
    );
  });

  it("holds only files the allowlist of public paths holds, and the allowlist takes no script or other kind of file there", () => {
    const { patterns } = loadPublicPaths();
    expect(filesUnder(SITE).filter((path) => !isPublic(path, patterns))).toEqual([]);
    for (const path of ["site/app.js", "site/assets/app.js", "site/assets/tracker.mjs", "site/notes.md", "site/drafts/index.html", "site/schemas/packet/v1.json"]) {
      expect(isPublic(path, patterns), path).toBe(false);
    }
  });

  it("names the domain in its CNAME, one line", () => {
    expect(read("site/CNAME")).toBe("tiehall.com\n");
  });

  it("shows the brand's own images, byte for byte, so they never drift from what the mark's source draws", () => {
    for (const [copy, source] of Object.entries(BRAND_COPIES)) {
      expect(existsSync(join(root, copy)), copy).toBe(true);
      expect(readFileSync(join(root, copy)).equals(readFileSync(join(root, source))), copy).toBe(true);
    }
  });

  it("serves nothing under /schemas/, which the published packet schemas keep (D26)", () => {
    expect(filesUnder(SITE).filter((path) => path.startsWith("site/schemas/"))).toEqual([]);
    for (const page of PAGES) expect(references(read(page)).filter(({ value }) => /(^|\/)schemas\//.test(value)), page).toEqual([]);
  });
});

describe("the landing page's pages", () => {
  it.each(PAGES)("%s runs no script and loads nothing from another host", (page) => {
    const html = read(page);
    expect(html).not.toBe("");
    const all = tags(html);
    expect(all.filter(({ name }) => ["script", "object", "embed", "form", "base", "noscript"].includes(name)).map(({ name }) => name)).toEqual([]);
    // One frame, on the home page, holds the film's own page; nothing else is framed.
    expect(all.filter(({ name }) => name === "iframe").map(({ attributes }) => attributes["src"])).toEqual(page === "site/index.html" ? ["film.html"] : []);
    expect(all.flatMap(({ name, attributes }) => Object.keys(attributes).filter((attribute) => attribute.startsWith("on")).map((attribute) => `${name} ${attribute}`))).toEqual([]);
    expect(references(html).filter(({ value }) => /^\s*(?:javascript|data|vbscript):/i.test(value))).toEqual([]);
    // What a browser loads with the page, its stylesheet, icons and images, is the site's own.
    const loaded = all.flatMap(({ name, attributes }) => {
      if (name === "link" && attributes["rel"] !== "canonical") return [attributes["href"] ?? ""];
      if (name === "iframe") return [attributes["src"] ?? ""];
      if (["img", "source", "video", "audio", "track", "input"].includes(name)) return [attributes["src"] ?? "", attributes["srcset"] ?? "", attributes["poster"] ?? ""];
      return [];
    });
    expect(loaded.filter((value) => value !== "" && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value))).toEqual([]);
    expect(all.filter(({ name, attributes }) => name === "link" && attributes["rel"] === "stylesheet").map(({ attributes }) => attributes["href"])).toHaveLength(1);
    // The browser runs no script and loads nothing from another host, whatever the page holds, but for the frame's
    // YouTube player once the visitor starts the film.
    const policy = all.find(({ name, attributes }) => name === "meta" && attributes["http-equiv"]?.toLowerCase() === "content-security-policy")?.attributes["content"] ?? "";
    const directives = Object.fromEntries(policy.split(";").map((part) => part.trim().split(/\s+/)).filter(([name]) => name !== undefined && name !== "").map(([name = "", ...values]) => [name, values]));
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(directives["script-src"] ?? ["'none'"]).toEqual(["'none'"]);
    for (const directive of ["style-src", "img-src"]) expect(directives[directive], directive).toEqual(["'self'"]);
    expect(directives["frame-src"]).toEqual(page === "site/index.html" ? ["'self'", FILM_HOST] : undefined);
    expect(directives["base-uri"]).toEqual(["'none'"]);
    expect(directives["form-action"]).toEqual(["'none'"]);
  });

  it("has a stylesheet that loads nothing: no import, no font face and no address", () => {
    expect(read("site/style.css")).not.toBe("");
    expect(stylesheet.statements).toEqual([]);
    expect(stylesheet.rules.filter(({ selector }) => selector.startsWith("@font-face"))).toEqual([]);
    expect(read("site/style.css").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/url\(/i);
  });

  it.each(PAGES)("%s has links and images that all resolve, to the site's own files or to the public repository", (page) => {
    const problems = references(read(page)).flatMap(({ tag, attribute, value }) => {
      const problem = unresolved(page, value);
      return problem === undefined ? [] : [`<${tag} ${attribute}="${value}">: ${problem}`];
    });
    expect(problems).toEqual([]);
  });

  it("names its own files by addresses from the site's root on the 404 page, which GitHub Pages serves at any depth", () => {
    const local = references(notFound).filter(({ value }) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value));
    expect(local.length).toBeGreaterThan(0);
    expect(local.filter(({ value }) => !value.startsWith("/"))).toEqual([]);
  });

  it.each(PAGES)("%s names no email address and no tracker", (page) => {
    const html = read(page);
    expect(html).not.toMatch(/mailto:/i);
    expect(withoutComments(html)).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(html).not.toMatch(/google-analytics|googletagmanager|plausible|matomo|segment\.|hotjar|gtag\(|_paq/i);
  });
});

describe("the landing page's meta tags", () => {
  it("name the page's language, its characters first, and a viewport for phones", () => {
    expect(tags(index).find(({ name }) => name === "html")?.attributes["lang"]).toBe("en");
    const head = tags(index.slice(0, index.indexOf("</head>")));
    expect(head.find(({ name }) => name === "meta")?.attributes["charset"]?.toLowerCase()).toBe("utf-8");
    expect(meta(index, "viewport")).toBe("width=device-width, initial-scale=1");
  });

  it("give the name, a description within 160 characters and the page's address", () => {
    const title = /<title>([^<]+)<\/title>/.exec(index)?.[1] ?? "";
    expect(decodeEntities(title)).toMatch(/^Tiehall\b/);
    const description = meta(index, "description") ?? "";
    expect(description).toMatch(/^Tiehall /);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(tags(index).find(({ name, attributes }) => name === "link" && attributes["rel"] === "canonical")?.attributes["href"]).toBe(`${ORIGIN}/`);
  });

  it("give link previews the name, the description and the social preview, as Open Graph and Twitter's card", () => {
    const title = decodeEntities(/<title>([^<]+)<\/title>/.exec(index)?.[1] ?? "");
    const description = meta(index, "description");
    expect(meta(index, "og:type")).toBe("website");
    expect(meta(index, "og:site_name")).toBe("Tiehall");
    expect(meta(index, "og:url")).toBe(`${ORIGIN}/`);
    expect(meta(index, "og:title")).toBe(title);
    expect(meta(index, "og:description")).toBe(description);
    expect(meta(index, "og:image")).toBe(`${ORIGIN}/assets/social-preview.png`);
    expect(meta(index, "og:image:type")).toBe("image/png");
    expect([meta(index, "og:image:width"), meta(index, "og:image:height")]).toEqual(["1280", "640"]);
    expect(meta(index, "og:image:alt")).toMatch(/\S/);
    expect(meta(index, "twitter:card")).toBe("summary_large_image");
    expect(meta(index, "twitter:title")).toBe(title);
    expect(meta(index, "twitter:description")).toBe(description);
    expect(meta(index, "twitter:image")).toBe(`${ORIGIN}/assets/social-preview.png`);
    expect(meta(index, "twitter:image:alt")).toBe(meta(index, "og:image:alt"));
  });

  it.each(PAGES)("%s takes its icon from the brand's mark and its color from the navy ground", (page) => {
    const html = read(page);
    const link = (rel: string) => tags(html).find(({ name, attributes }) => name === "link" && attributes["rel"] === rel)?.attributes;
    expect(link("icon")).toEqual(expect.objectContaining({ type: "image/svg+xml" }));
    expect(link("icon")?.["href"]).toMatch(/^\/?assets\/mark\.svg$/);
    expect(link("apple-touch-icon")?.["href"]).toMatch(/^\/?assets\/mark\.png$/);
    expect(meta(html, "theme-color")).toBe("#0A1428");
    expect(meta(html, "color-scheme")).toBe("dark");
  });

  it("keep the 404 page out of search engines", () => {
    expect(meta(notFound, "robots")).toBe("noindex");
    expect(decodeEntities(/<title>([^<]+)<\/title>/.exec(notFound)?.[1] ?? "")).toMatch(/Tiehall/);
  });
});

describe("the landing page's content", () => {
  it("names Tiehall in its one heading of the first level, with the tagline and the README's own sentence", () => {
    expect(tags(index).filter(({ name }) => name === "h1")).toHaveLength(1);
    expect(/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(index)?.[1]?.replace(/<[^>]*>/g, "").trim()).toBe("Tiehall");
    expect(readmeSentence()).not.toBe("");
    expect(plain(textOf(index))).toContain(readmeSentence());
    expect(textOf(index)).toContain(TAGLINE);
  });

  it("has one call to action, View on GitHub, to the public repository", () => {
    const actions = [...withoutComments(index).matchAll(/<a\b([^>]*\bclass="[^"]*\bcta\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/g)];
    expect(actions).toHaveLength(1);
    const [action] = actions;
    expect(/\bhref="([^"]+)"/.exec(action?.[1] ?? "")?.[1]).toBe(REPOSITORY);
    expect((action?.[2] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).toBe("View on GitHub");
  });

  it("makes four points: an address for each team, typed requests with questions going back, people confirming commitments, and an install that is the company's own", () => {
    const points = textOf(index, "points");
    expect(withoutComments(index).match(/<li\b/g)?.length).toBeGreaterThan(0);
    const items = /<[a-z]+\b[^>]*\bid="points"[^>]*>([\s\S]*?)<\/section>/.exec(withoutComments(index))?.[1]?.match(/<li\b/g) ?? [];
    expect(items).toHaveLength(4);
    for (const words of [/\baddress\b/, /\btyped\b/, /\bquestions\b/, /\bconfirm/, /\bself-hosted\b/i, /\bopen source\b/i, /\bmodel-agnostic\b/i, /\bno telemetry\b/i]) {
      expect(points).toMatch(words);
    }
  });

  it("says how it works in three steps", () => {
    const how = /<[a-z]+\b[^>]*\bid="how"[^>]*>([\s\S]*?)<\/section>/.exec(withoutComments(index))?.[1] ?? "";
    expect(how.match(/<ol\b/g)).toHaveLength(1);
    expect(how.match(/<li\b/g)).toHaveLength(3);
  });

  it("names the clients it works with: Claude Code, Codex, Cursor and any MCP client", () => {
    const clients = textOf(index, "clients");
    for (const client of ["Claude Code", "Codex", "Cursor", "any MCP client"]) expect(clients).toContain(client);
  });

  it("names the licenses: the server under AGPL-3.0, the client pieces under Apache-2.0, and links the README's map", () => {
    const licenses = textOf(index, "licenses");
    for (const words of ["AGPL-3.0", "Apache-2.0", "tiehall", "@tiehall/client", "Claude Code plugin", "contract", "packet schema"]) {
      expect(licenses).toContain(words);
    }
    expect(references(index).map(({ value }) => value)).toContain(`${REPOSITORY}#licenses-by-directory`);
  });

  it("ends with a footer that links the repository and the security policy", () => {
    for (const page of PAGES) {
      const footer = /<footer\b[\s\S]*?<\/footer>/.exec(withoutComments(read(page)))?.[0] ?? "";
      const targets = references(footer).map(({ value }) => value);
      expect(targets, page).toEqual(expect.arrayContaining([REPOSITORY, `${REPOSITORY}/blob/main/SECURITY.md`]));
    }
  });

  it("plays the film in a large frame on the page, in YouTube's privacy-enhanced player once the visitor starts it (the change play-film-from-youtube)", () => {
    // The frame holds the film's own page, with what YouTube's player needs to play at once, fill the screen and be
    // told where it is shown, which it refuses to play without.
    const frame = tags(index).find(({ name }) => name === "iframe")?.attributes ?? {};
    expect(frame["src"]).toBe("film.html");
    expect(frame["title"]).toMatch(/\bfilm\b/i);
    expect((frame["allow"] ?? "").split(";").map((feature) => feature.trim()).sort()).toEqual(["autoplay", "encrypted-media", "fullscreen", "picture-in-picture"]);
    expect(frame["allowfullscreen"]).toBe("");
    expect(frame["referrerpolicy"]).toBe("strict-origin-when-cross-origin");
    // The frame stands in its own section, as wide as the page's content, rather than in a column beside the hero.
    expect(textOf(index, "film")).toMatch(/\S/);
    expect(withoutComments(index).indexOf('id="film"')).toBeGreaterThan(withoutComments(index).indexOf("</section>"));
    // The film's page shows the poster and its label, the site's own files, as one link to the player, so that nothing
    // comes from YouTube until the visitor starts the film.
    const film = read("site/film.html");
    const filmTags = tags(film);
    expect(filmTags.filter(({ name }) => ["script", "iframe", "object", "embed", "form", "base", "noscript"].includes(name)).map(({ name }) => name)).toEqual([]);
    expect(filmTags.flatMap(({ name, attributes }) => Object.keys(attributes).filter((attribute) => attribute.startsWith("on")).map((attribute) => `${name} ${attribute}`))).toEqual([]);
    expect(filmTags.filter(({ name }) => name === "a").map(({ attributes }) => attributes["href"])).toEqual([FILM_PLAYER]);
    expect(references(film).filter(({ tag }) => tag !== "a").map(({ value }) => value).filter((value) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value))).toEqual([]);
    for (const { value } of references(film)) expect(unresolved("site/film.html", value), value).toBeUndefined();
    expect(filmTags.find(({ name, attributes }) => name === "img" && attributes["src"] === "assets/every-teams-line-poster.jpg")?.attributes["alt"]).toMatch(/\S/);
    expect(textOf(film)).toMatch(/Watch the film/);
    const policy = filmTags.find(({ name, attributes }) => name === "meta" && attributes["http-equiv"]?.toLowerCase() === "content-security-policy")?.attributes["content"] ?? "";
    expect(policy.split(";").map((part) => part.trim()).filter(Boolean).sort()).toEqual(["base-uri 'none'", "default-src 'none'", "form-action 'none'", "img-src 'self'", "style-src 'self'"]);
    expect(meta(film, "referrer")).toBe("strict-origin-when-cross-origin");
    // Under the frame, a plain link to the film on YouTube; and no link is left to the README's attachment, which
    // GitHub serves only to people signed in to it.
    expect(references(index).map(({ value }) => value)).toContain(FILM_WATCH);
    expect([...references(index), ...references(film)].filter(({ value }) => value.includes("user-attachments"))).toEqual([]);
    // The footer says what the page loads, the film's player included.
    expect(textOf(index)).toMatch(/sets no cookies and runs no scripts/);
    expect(textOf(index)).toMatch(/YouTube/);
    expect(textOf(index)).not.toMatch(/loads nothing from another host/);
  });

  it("claims no Jira mirror while the plan has not built it, and no address under the install's own host", () => {
    const jiraOpen = [...plan].some(([task, done]) => task.startsWith("25.") && !done);
    if (jiraOpen) expect(textOf(index)).not.toMatch(/\bJira\b/);
    expect(index).not.toContain("localhost");
  });
});

describe("the landing page's accessibility", () => {
  it.each(PAGES)("%s has a header, one main and a footer, and a link that skips to the main content first", (page) => {
    const html = withoutComments(read(page));
    const all = tags(html);
    expect(all.filter(({ name }) => name === "main")).toHaveLength(1);
    expect(all.find(({ name }) => name === "main")?.attributes["id"]).toBe("main");
    expect(all.filter(({ name }) => name === "header").length).toBeGreaterThan(0);
    expect(all.filter(({ name }) => name === "footer")).toHaveLength(1);
    expect(all.find(({ name }) => name === "a")?.attributes["href"]).toBe("#main");
  });

  it.each(PAGES)("%s gives every image an alt text and every link a name", (page) => {
    const html = withoutComments(read(page));
    expect(tags(html).filter(({ name, attributes }) => name === "img" && attributes["alt"] === undefined)).toEqual([]);
    const nameless = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].filter(([, attributes = "", content = ""]) => {
      const alts = [...content.matchAll(/\balt="([^"]*)"/g)].map(([, alt = ""]) => alt).join("");
      return content.replace(/<[^>]*>/g, "").trim() === "" && alts.trim() === "" && !/\baria-label="[^"]+"/.test(attributes);
    });
    expect(nameless.map(([link]) => link)).toEqual([]);
  });

  it.each(PAGES)("%s has headings that skip no level, and labels each section by its heading", (page) => {
    const html = withoutComments(read(page));
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map(([, level = ""]) => Number(level));
    expect(levels[0]).toBe(1);
    expect(levels.filter((level, at) => at > 0 && level > (levels[at - 1] ?? 0) + 1)).toEqual([]);
    const ids = idsOf(html);
    const sections = tags(html).filter(({ name }) => name === "section");
    for (const { attributes } of sections) expect(ids.has(attributes["aria-labelledby"] ?? ""), JSON.stringify(attributes)).toBe(true);
  });
});

/** The custom properties of the rules with this selector, outside any at-rule or inside the one given. */
function tokensOf(rules: CssRule[], selector: string, context: string[] = []): Record<string, string> {
  return Object.fromEntries(
    rules
      .filter((rule) => rule.selector === selector && JSON.stringify(rule.context) === JSON.stringify(context))
      .flatMap(({ declarations }) => declarations.filter(({ property }) => property.startsWith("--")).map(({ property, value }) => [property, value])),
  );
}

const site = tokensOf(stylesheet.rules, ":root");
const webUi = parseCss(read("packages/commands/assets/tiehall.css")).rules;
/** The web UI's dark theme, its light tokens with the dark ones over them, and its type, which no theme changes. */
const webUiDark = { ...tokensOf(webUi, ":root"), ...tokensOf(webUi, ":root", ["@media (prefers-color-scheme: dark)"]) };
/** The colors the page may take: the web UI's dark theme, and the live hall's own for the tokens only the hall has, such as its glows. */
const palette = { ...tokensOf(webUi, ".hall"), ...webUiDark };
/** A color as the stylesheet writes one. */
const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

/** A value that names a token, followed through the tokens it names in turn, as a color, or the value itself. */
function resolve(value: string): string {
  const name = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1];
  const next = name === undefined ? undefined : site[name];
  return next === undefined ? value : resolve(next).toUpperCase();
}

describe("the landing page's motion (the change landing-page-motion)", () => {
  const all = tags(index);
  const classes = ({ attributes }: Tag) => (attributes["class"] ?? "").split(/\s+/);
  const hero = withoutComments(index).slice(withoutComments(index).indexOf('<section class="hero"'), withoutComments(index).indexOf("</section>"));
  // The steps' list, to its own end: other ordered lists of the page come before it.
  const stepsAt = withoutComments(index).indexOf('<ol class="steps"');
  const steps = withoutComments(index).slice(stepsAt, withoutComments(index).indexOf("</ol>", stepsAt));

  it("draws the hall beside the hero's text: the six teams' switchboards and the cords between them, in one SVG named for screen readers", () => {
    const art = tags(hero).find((tag) => tag.name === "svg" && classes(tag).includes("hall-art"));
    expect(art?.attributes["role"]).toBe("img");
    expect(art?.attributes["aria-label"]).toMatch(/\bteams?\b/);
    expect(tags(hero).filter((tag) => tag.name === "g" && classes(tag).includes("hall-node"))).toHaveLength(6);
    expect(tags(hero).filter((tag) => tag.name === "path" && classes(tag).includes("hall-cord")).length).toBeGreaterThanOrEqual(6);
    // A request travels one cord, its question comes back, the answer follows, and the line turns to done.
    for (const pulse of ["pulse-request", "pulse-question", "pulse-answer"]) {
      expect(tags(hero).filter((tag) => tag.name === "path" && classes(tag).includes(pulse)), pulse).toHaveLength(1);
    }
  });

  it("puts a backdrop of drifting shapes behind the hero, which screen readers skip and no pointer reaches", () => {
    const backdrop = tags(hero).find((tag) => tag.name === "svg" && classes(tag).includes("backdrop"));
    expect(backdrop?.attributes["aria-hidden"]).toBe("true");
    expect(tags(hero).filter((tag) => classes(tag).includes("shape")).length).toBeGreaterThanOrEqual(6);
    const rule = stylesheet.rules.find((candidate) => candidate.context.length === 0 && selectorsOf(candidate).includes(".backdrop"));
    expect(rule?.declarations).toContainEqual(expect.objectContaining({ property: "pointer-events", value: "none" }));
  });

  it("gives each of the three steps a small moving picture that screen readers skip", () => {
    const pictures = tags(steps).filter(({ name }) => name === "svg");
    expect(pictures.map(({ attributes }) => attributes["aria-hidden"])).toEqual(["true", "true", "true"]);
  });

  it("moves only through the stylesheet's animations, never through SVG's own animation elements or inline styles, which the policy would block", () => {
    expect(all.filter(({ name }) => ["animate", "animatemotion", "animatetransform", "set"].includes(name)).map(({ name }) => name)).toEqual([]);
    for (const page of [...PAGES, "site/film.html"]) {
      expect(tags(read(page)).filter(({ attributes }) => "style" in attributes).map(({ name }) => name), page).toEqual([]);
    }
    const keyframes = stylesheet.rules.filter(({ context }) => context.some((at) => at.startsWith("@keyframes")));
    expect(keyframes.length).toBeGreaterThan(0);
  });

  it("keeps every drawing hidden until the stylesheet that draws it loads, so an old or missing stylesheet leaves the text alone", () => {
    const drawings = all.filter(({ name }) => name === "svg");
    expect(drawings.length).toBeGreaterThanOrEqual(5);
    // SVG's own display attribute, which any rule of the stylesheet overrides; HTML's hidden attribute hides no SVG.
    expect(drawings.filter(({ attributes }) => attributes["display"] !== "none").map((tag) => classes(tag).join(" "))).toEqual([]);
    for (const selector of [".backdrop", ".hall-art", ".step-art"]) {
      const shown = stylesheet.rules.find((rule) => rule.context.length === 0 && selectorsOf(rule).includes(selector))?.declarations.find(({ property }) => property === "display");
      expect(shown?.value, selector).toMatch(/^(?:block|inline-block)$/);
    }
  });

  it("stops every animation and transition for people who ask for reduced motion", () => {
    const reduced = stylesheet.rules.filter(({ context }) => context.some((at) => /prefers-reduced-motion:\s*reduce/.test(at))).flatMap(({ declarations }) => declarations);
    expect(reduced).toContainEqual(expect.objectContaining({ property: "animation", value: "none", important: true }));
    expect(reduced).toContainEqual(expect.objectContaining({ property: "transition", value: "none", important: true }));
  });
});

/** The width and height a PNG or JPEG gives in its header, or undefined for any other kind of file. */
function imageSize(bytes: Buffer): { kind: "png" | "jpeg"; width: number; height: number } | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1] ?? 0;
    // A start-of-frame segment, baseline or progressive, holds the size; 0xC4, 0xC8 and 0xCC are other segments.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { kind: "jpeg", height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

/** The markup of the page's section with this id, which no section of the page nests in another. */
const sectionOf = (id: string) => new RegExp(`<section\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?<\\/section>`).exec(withoutComments(index))?.[0] ?? "";

/** The commands of docs/install.md's blocks that its docs test runs, by the block's name. */
const installBlocks = Object.fromEntries([...read("docs/install.md").matchAll(/^```sh docs-test=([a-z0-9-]+)\n([\s\S]*?)^```$/gm)].map(([, name = "", body = ""]) => [name, body]));

/** A command as a reader copies it, with white space made single spaces. */
const command = (text: string) => text.replace(/\s+/g, " ").trim();

/** The keyframes rules of the stylesheet, by their name, each with its frames' rules. */
function keyframesByName(): Map<string, CssRule[]> {
  const found = new Map<string, CssRule[]>();
  for (const rule of stylesheet.rules) {
    const at = rule.context.find((context) => context.startsWith("@keyframes "));
    if (at === undefined) continue;
    const name = at.slice("@keyframes ".length).trim();
    found.set(name, [...(found.get(name) ?? []), rule]);
  }
  return found;
}

/** The declarations a keyframes rule gives at one offset, such as 0% or 100%, each as "property: value", sorted. */
function frameAt(frames: CssRule[], offset: string): string[] {
  const aliases: Record<string, string> = { "0%": "from", "100%": "to" };
  return frames
    .filter((frame) => selectorsOf(frame).some((selector) => selector === offset || selector === aliases[offset]))
    .flatMap(({ declarations }) => declarations.map(({ property, value }) => `${property}: ${value}`))
    .sort();
}

describe("the landing page's showcase (the change landing-page-showcase)", () => {
  const all = tags(index);
  const classes = ({ attributes }: Tag) => (attributes["class"] ?? "").split(/\s+/);

  it("shows real screenshots of the web UI, each a JPEG of the site of at most 250 KB, with its alt text, its size and lazy loading, as a link to itself", () => {
    const screens = sectionOf("screens");
    expect(screens).not.toBe("");
    const images = tags(screens).filter(({ name, attributes }) => name === "img" && (attributes["src"] ?? "").startsWith("assets/screen-"));
    expect(images.map(({ attributes }) => `site/${attributes["src"] ?? ""}`).sort()).toEqual(Object.keys(SCREENSHOTS).sort());
    for (const { attributes } of images) {
      const path = `site/${attributes["src"] ?? ""}`;
      const bytes = existsSync(join(root, path)) ? readFileSync(join(root, path)) : Buffer.alloc(0);
      expect(bytes.length, path).toBeGreaterThan(0);
      expect(bytes.length, path).toBeLessThanOrEqual(250 * 1024);
      const size = imageSize(bytes);
      expect(size?.kind, path).toBe("jpeg");
      expect([attributes["width"], attributes["height"]], path).toEqual([String(size?.width), String(size?.height)]);
      expect(attributes["alt"]?.length ?? 0, path).toBeGreaterThan(40);
      expect(attributes["loading"], path).toBe("lazy");
      expect(attributes["decoding"], path).toBe("async");
      // The window is a link to the full image, so a visitor can read it at its size.
      expect(new RegExp(`<a\\b[^>]*\\bhref="${attributes["src"] ?? ""}"[^>]*>(?:(?!</a>)[\\s\\S])*<img\\b[^>]*\\bsrc="${attributes["src"] ?? ""}"`).test(screens), path).toBe(true);
    }
    // The change's design says how each was made, from which screenshot of the repository's own browser test.
    const design = read("openspec/changes/landing-page-showcase/design.md");
    expect(design).toContain("packages/commands/test/screens-browser.test.ts");
    for (const [copy, source] of Object.entries(SCREENSHOTS)) {
      expect(design, copy).toContain(copy);
      expect(design, copy).toContain(source);
    }
  });

  it("shows a live request card, FE-142, with its typed packet, a question and its answer, and its pull request merged, as one image beside the same story in five steps of text", () => {
    const request = sectionOf("request");
    expect(request).not.toBe("");
    const card = tags(request).find((tag) => classes(tag).includes("req"));
    expect(card?.attributes["role"]).toBe("img");
    for (const words of [/FE-142/, /\bBE\b/, /\bFE\b/, /packet/, /question/, /answer/, /pull request/, /\bdone\b/]) expect(card?.attributes["aria-label"]).toMatch(words);
    const text = textOf(index, "request");
    for (const words of ["FE-142", "need", "acceptance_criteria", "code_refs", "due_date", "merged"]) expect(text).toContain(words);
    expect(tags(request).filter(({ name }) => ["svg", "script", "button"].includes(name))).toEqual([]);
    const story = /<ol\b[^>]*\bclass="story"[^>]*>([\s\S]*?)<\/ol>/.exec(request)?.[1] ?? "";
    expect(story.match(/<li\b/g)).toHaveLength(5);
    expect(request.indexOf('class="story"')).toBeGreaterThan(-1);
  });

  it("rests the request card on done: each of its keyframes rules starts and ends on the same frame", () => {
    const card = [...keyframesByName()].filter(([name]) => name.startsWith("req-"));
    expect(card.length).toBeGreaterThanOrEqual(5);
    for (const [name, frames] of card) {
      expect(frameAt(frames, "0%").length, name).toBeGreaterThan(0);
      expect(frameAt(frames, "0%"), name).toEqual(frameAt(frames, "100%"));
    }
  });

  it("sets the copy and paste of the past beside Tiehall's one line, in a section labelled by its heading and in the README's words", () => {
    const section = sectionOf("before-after");
    expect(section).not.toBe("");
    const label = tags(section).find(({ name }) => name === "section")?.attributes["aria-labelledby"] ?? "";
    expect(new RegExp(`<h2\\b[^>]*\\bid="${label}"`).test(section)).toBe(true);
    const text = plain(textOf(index, "before-after"));
    for (const words of [/where replies bury it/, /does not make it across/, /typed handoff packet/, /when its pull request merges/]) expect(text).toMatch(words);
    for (const words of ["where replies bury it", "does not make it across", "typed handoff packet"]) expect(plain(read("README.md"))).toContain(words);
    // The drawing of a team chat says what the text beside it says, so screen readers skip it.
    const chat = tags(section).filter((tag) => classes(tag).includes("chat"));
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.map(({ attributes }) => attributes["aria-hidden"])).toEqual(chat.map(() => "true"));
    // Its messages are written twice for a loop without a seam; the second copy is hidden from a page without the
    // stylesheet, which shows it.
    const runs = tags(section).filter((tag) => classes(tag).includes("chat-run"));
    expect(runs.map(({ attributes }) => attributes["hidden"])).toEqual([undefined, ""]);
    const run = stylesheet.rules.find((rule) => rule.context.length === 0 && selectorsOf(rule).includes(".chat-run"));
    expect(run?.declarations.find(({ property }) => property === "display")?.value).toBe("grid");
  });

  it("gives the install commands of docs/install.md word for word, read from the doc so they cannot drift, and says that they wait for the first release", () => {
    const blocks = ["install-download", "install-init", "install-up", "install-setup-code"].map((name) => installBlocks[name] ?? "");
    expect(blocks.filter((block) => block === "")).toEqual([]);
    const section = sectionOf("install");
    expect(section).not.toBe("");
    const shown = [...section.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)].map(([, inner = ""]) => command(decodeEntities(inner.replace(/<[^>]*>/g, ""))));
    expect(shown).toEqual(blocks.map(command));
    expect(plain(textOf(index, "install"))).toMatch(/There is no release yet/);
    expect(references(section).map(({ value }) => value)).toContain(`${REPOSITORY}/blob/main/docs/install.md`);
    // No copy button: one would take a script.
    expect(all.filter(({ name }) => name === "button")).toEqual([]);
    expect(references(index).filter(({ value }) => value === "#install").length).toBeGreaterThanOrEqual(2);
  });

  it("sets the tagline's last words in gold, and the name's gradient only where the browser can clip it to the text", () => {
    const tagline = /<p\b[^>]*\bclass="tagline"[^>]*>([\s\S]*?)<\/p>/.exec(index)?.[1] ?? "";
    expect(tagline).toMatch(/<span class="accent">in one hall\.<\/span>/);
    const accent = stylesheet.rules.find((rule) => rule.context.length === 0 && selectorsOf(rule).some((selector) => selector.endsWith(".accent")));
    expect(resolve(accent?.declarations.find(({ property }) => property === "color")?.value ?? "")).toBe(site["--signal"]);
    // A transparent text color, which the gradient shows through, only inside the @supports that clips the gradient to the text.
    const clear = stylesheet.rules.filter((rule) => rule.declarations.some(({ property, value }) => /^(?:color|-webkit-text-fill-color)$/.test(property) && value === "transparent"));
    expect(clear.length).toBeGreaterThan(0);
    for (const rule of clear) expect(rule.context.some((at) => /^@supports\b.*background-clip:\s*text/.test(at)), rule.selector).toBe(true);
  });

  it("ties animations to scrolling only where the browser supports it and the visitor has not asked for reduced motion", () => {
    const tied = stylesheet.rules.filter((rule) => rule.declarations.some(({ property, value }) => property === "animation-timeline" || (property === "animation" && /\b(?:view|scroll)\(/.test(value))));
    expect(tied.length).toBeGreaterThan(0);
    for (const rule of tied) {
      expect(rule.context.some((at) => /^@supports \(animation-timeline: (?:view|scroll)\(\)\)/.test(at)), rule.selector).toBe(true);
      expect(rule.context.some((at) => /prefers-reduced-motion:\s*no-preference/.test(at)), rule.selector).toBe(true);
    }
    // And the keyframes they run never make a part unseen, so that a tool that captures the whole page without
    // scrolling it, where a part below the screen waits at its first frame, still shows every part.
    const names = tied.flatMap(({ declarations }) => declarations.filter(({ property }) => property === "animation").map(({ value }) => value.split(/\s+/)[0] ?? ""));
    expect(names.length).toBeGreaterThan(0);
    const keyframes = keyframesByName();
    for (const name of names) {
      const unseen = (keyframes.get(name) ?? []).flatMap(({ declarations }) => declarations.filter(({ property, value }) => property === "opacity" && Number(value) === 0));
      expect(keyframes.has(name), name).toBe(true);
      expect(unseen, name).toEqual([]);
    }
  });

  it("hides nothing until an animation shows it: outside a keyframes rule, only the travelling dots start unseen", () => {
    const hidden = stylesheet.rules
      .filter(({ context }) => !context.some((at) => at.startsWith("@keyframes")))
      .filter((rule) => rule.declarations.some(({ property, value }) => (property === "opacity" && Number(value) === 0) || (property === "visibility" && value === "hidden")))
      .map(({ selector }) => selector);
    expect(hidden.sort()).toEqual([".hall-pulse", ".req-dot"]);
  });

  it("moves the page through transforms, opacity and colors, never through an animated filter, shadow or size outside the hall's drawing", () => {
    const allowed = new Set(["transform", "translate", "rotate", "scale", "opacity", "stroke-dashoffset", "stroke", "stroke-width", "fill", "color", "background-color", "border-color", "background-position", "content"]);
    const animated = [...keyframesByName()]
      .filter(([name]) => !name.startsWith("hall-"))
      .flatMap(([name, frames]) => frames.flatMap(({ declarations }) => declarations.filter(({ property }) => !allowed.has(property)).map(({ property }) => `${name}: ${property}`)));
    expect(animated).toEqual([]);
  });
});

describe("the landing page's colors", () => {
  it("are the web UI's Navy & Gold tokens of its dark theme, with its system font stack", () => {
    expect(site["--ground"]).toBe("#0A1428");
    expect(site["--ink"]).toBe("#E9EDF5");
    expect(site["--button"]).toBe("#E3B341");
    expect(site["--font-sans"]).toBe(webUiDark["--font-sans"]);
    const colors = Object.entries(site).filter(([, value]) => value.startsWith("#"));
    expect(colors.map(([token]) => token)).toEqual(expect.arrayContaining(["--ground", "--surface", "--border", "--ink", "--ink-2", "--line", "--focus", "--button", "--button-ink"]));
    expect(colors.filter(([token, value]) => palette[token] !== value).map(([token, value]) => `${token}: ${value} where the web UI has ${palette[token] ?? "no such token"}`)).toEqual([]);
  });

  it("are tokens wherever the stylesheet sets one, never a color written into a rule", () => {
    const written = stylesheet.rules.flatMap((rule) =>
      rule.declarations.filter(({ property, value }) => !property.startsWith("--") && COLOR.test(value)).map(({ property, value }) => `${rule.selector} { ${property}: ${value} }`),
    );
    expect(written).toEqual([]);
    // A token is a color of its own, #RRGGBB or with its alpha, or holds none, as a length or the font stack does.
    expect(Object.entries(site).filter(([, value]) => !/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/.test(value) && COLOR.test(value)).map(([token]) => token)).toEqual([]);
  });

  it("contrast at least 4.5:1 for text and 3:1 for the focus ring, on every background the page uses", () => {
    for (const text of ["--ink", "--ink-2", "--line", "--line-hover"]) {
      for (const background of ["--ground", "--surface"]) {
        expect(contrast(resolve(`var(${text})`), resolve(`var(${background})`)), `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const background of ["--button", "--button-hover"]) {
      expect(contrast(resolve("var(--button-ink)"), resolve(`var(${background})`)), `--button-ink on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const background of ["--ground", "--surface"]) {
      expect(contrast(resolve("var(--focus)"), resolve(`var(${background})`)), `--focus on ${background}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("contrast at least 4.5:1 in every rule that sets both a background and a text color", () => {
    const checked: string[] = [];
    for (const rule of stylesheet.rules) {
      const background = rule.declarations.find(({ property }) => property === "background" || property === "background-color")?.value;
      const text = rule.declarations.find(({ property }) => property === "color")?.value;
      if (background === undefined || text === undefined || !background.startsWith("var(")) continue;
      const [back, fore] = [resolve(background), resolve(text)];
      expect(back, `${rule.selector} { background: ${background} }`).toMatch(/^#[0-9A-F]{6}$/);
      expect(fore, `${rule.selector} { color: ${text} }`).toMatch(/^#[0-9A-F]{6}$/);
      expect(contrast(fore, back), `${rule.selector} { color: ${text}; background: ${background} }`).toBeGreaterThanOrEqual(4.5);
      checked.push(rule.selector);
    }
    expect(checked.length).toBeGreaterThan(2);
  });

  it("draws a focus ring in the focus color on whatever the keyboard reaches, and takes no outline away", () => {
    const focus = stylesheet.rules.find((rule) => selectorsOf(rule).includes(":focus-visible"));
    expect(focus?.declarations).toContainEqual(expect.objectContaining({ property: "outline", value: "2px solid var(--focus)" }));
    const removed = stylesheet.rules.flatMap((rule) =>
      rule.declarations.filter(({ property, value }) => property === "outline" && /^(?:none|0)$/.test(value)).map(() => rule.selector),
    );
    expect(removed).toEqual([]);
  });

  it("sets the page's text in the system's fonts and fits phones from 360 pixels wide", () => {
    const body = stylesheet.rules.find((rule) => rule.context.length === 0 && selectorsOf(rule).includes("body"));
    expect(body?.declarations).toContainEqual(expect.objectContaining({ property: "font-family", value: "var(--font-sans)" }));
    expect(body?.declarations).toContainEqual(expect.objectContaining({ property: "background", value: "var(--ground)" }));
    const images = stylesheet.rules.find((rule) => rule.context.length === 0 && selectorsOf(rule).includes("img"));
    expect(images?.declarations).toEqual(expect.arrayContaining([expect.objectContaining({ property: "max-width", value: "100%" }), expect.objectContaining({ property: "height", value: "auto" })]));
    // Outside a media query for wider screens, nothing is set wider than a 360-pixel screen less its two 16-pixel gutters.
    const wide = stylesheet.rules
      .filter(({ context }) => !context.some((at) => /min-width/.test(at)))
      .flatMap((rule) =>
        rule.declarations
          .filter(({ property }) => ["width", "min-width", "flex-basis"].includes(property))
          .filter(({ value }) => [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].some(([, pixels = "0"]) => Number(pixels) > 328))
          .map(({ property, value }) => `${rule.selector} { ${property}: ${value} }`),
      );
    expect(wide).toEqual([]);
  });

  it("stops every transition for people who ask for reduced motion", () => {
    const moves = stylesheet.rules.some((rule) => rule.declarations.some(({ property }) => property.startsWith("transition") || property.startsWith("animation")));
    if (moves) expect(stylesheet.rules.some(({ context }) => context.some((at) => /prefers-reduced-motion:\s*reduce/.test(at)))).toBe(true);
  });
});

describe("the workflow that publishes the landing page", () => {
  interface Step {
    uses?: string;
    with?: Record<string, unknown>;
  }
  interface Job {
    if?: string;
    needs?: string | string[];
    permissions?: Record<string, string>;
    environment?: { name?: string };
    steps?: Step[];
  }
  const file = read(".github/workflows/pages.yml");
  const workflow = (file === "" ? {} : parse(file)) as { on?: Record<string, unknown>; permissions?: unknown; jobs?: Record<string, Job> };
  const jobs = workflow.jobs ?? {};

  it("runs on a push to main that changes the site, and when a maintainer starts it, never on a pull request", () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["push", "workflow_dispatch"]);
    const push = (workflow.on?.["push"] ?? {}) as { branches?: string[]; paths?: string[] };
    expect(push.branches).toEqual(["main"]);
    expect(push.paths).toEqual(expect.arrayContaining(["site/**", ".github/workflows/pages.yml"]));
  });

  it("uploads the folder as it is in a job that can only read, and publishes it in a job that holds only what GitHub Pages needs", () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(jobs).sort()).toEqual(["build", "deploy"]);
    expect(jobs["build"]?.permissions).toEqual({ contents: "read" });
    const uploads = (jobs["build"]?.steps ?? []).filter(({ uses }) => uses?.startsWith("actions/upload-pages-artifact@") === true);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.with?.["path"]).toBe("site/");
    expect(jobs["deploy"]?.needs).toBe("build");
    expect(jobs["deploy"]?.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(jobs["deploy"]?.environment?.name).toBe("github-pages");
    expect((jobs["deploy"]?.steps ?? []).map(({ uses }) => uses?.split("@")[0])).toEqual(["actions/deploy-pages"]);
    expect(loadPolicy(root).writePermissions["pages.yml#deploy"]).toEqual(["id-token", "pages"]);
    expect(checkWorkflows(root).filter((violation) => violation.file === "pages.yml")).toEqual([]);
  });

  it("runs only in the public repository, so the private archive and forks publish nothing", () => {
    const condition = jobs["build"]?.if ?? "";
    expect(condition).toContain("github.repository == 'tiehall/tiehall'");
    expect(condition).toContain("github.event.repository.private == false");
  });
});

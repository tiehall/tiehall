import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// What the docs checks read from the repository's Markdown (tasks 28.2 to
// 28.7; design.md, Decisions this change rests on: D38): its headings, the
// section under a heading, its links, and whether each link resolves, so that
// a public page never points at a file the repository does not hold, at a
// heading a page lacks, or at the git-ignored planning folder. A link is an
// inline link, an HTML link or image, or the target of a link reference
// definition, through which a reference-style link points. A link resolves
// when it is a web or mail address, or when the file or folder it names is in
// the repository, tracked or about to be, and the heading its fragment names
// is a heading of that page, by the anchor GitHub gives it.

export interface Heading {
  /** 1 for "#", 2 for "##" and so on. */
  level: number;
  /** The heading's text, as written. */
  text: string;
  /** The anchor GitHub gives the heading, such as tls-with-the-caddy-profile. */
  anchor: string;
  /** The heading's line, from 1. */
  line: number;
}

export interface Link {
  /** The link's text. */
  text: string;
  /** Where it points, as written. */
  target: string;
  /** The link's line, from 1. */
  line: number;
}

/** The lines of a Markdown text, each with whether it sits inside a fenced block (its fences included). */
function linesOutsideFences(markdown: string): { text: string; fenced: boolean }[] {
  let fence: string | undefined;
  return markdown.split("\n").map((text) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (fence === undefined && marker !== undefined) {
      fence = marker;
      return { text, fenced: true };
    }
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && text.trim() === marker) fence = undefined;
      return { text, fenced: true };
    }
    return { text, fenced: false };
  });
}

/** The anchor GitHub gives a heading's text: lower case, without punctuation, with a hyphen for each space. */
export function headingAnchor(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-");
}

/** The headings of a Markdown text, outside fenced blocks, in order; a repeated anchor gets -1, -2 and so on, as GitHub numbers them. */
export function headings(markdown: string): Heading[] {
  const seen = new Map<string, number>();
  return linesOutsideFences(markdown).flatMap(({ text, fenced }, index) => {
    const match = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (match === null) return [];
    const base = headingAnchor(match[2] ?? "");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return [{ level: (match[1] ?? "").length, text: match[2] ?? "", anchor: count === 0 ? base : `${base}-${count}`, line: index + 1 }];
  });
}

/** The text under a heading, without the heading's own line, up to the next heading of its level or a higher one; undefined when no heading has this text. */
export function section(markdown: string, heading: string): string | undefined {
  const all = headings(markdown);
  const found = all.find(({ text }) => text === heading);
  if (found === undefined) return undefined;
  const next = all.find(({ line, level }) => line > found.line && level <= found.level);
  const lines = markdown.split("\n");
  return lines.slice(found.line, next === undefined ? lines.length : next.line - 1).join("\n");
}

/** An inline link or image: [text](target "title"). */
const INLINE_LINK = /\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** An HTML link, <a href="target">text</a>, on one line. */
const HTML_LINK = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>(.*?)<\/a\s*>/gi;
/** An HTML image, <img src="target" alt="text">. */
const HTML_IMAGE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>/gi;
/** A link reference definition, [label]: target "title", which a reference-style link such as [text][label] uses; a footnote's [^1]: is none. */
const REFERENCE_DEFINITION = /^ {0,3}\[((?:[^\]\\^]|\\.)(?:[^\]\\]|\\.)*)\]:\s*(?:<([^>\s]*)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;

/**
 * The links of a Markdown text, outside fenced blocks and code spans, in
 * order: inline links, HTML links and the targets of link reference
 * definitions, through which reference-style links such as [text][label]
 * point; images count as links.
 */
export function links(markdown: string): Link[] {
  return linesOutsideFences(markdown).flatMap(({ text, fenced }, index) => {
    if (fenced) return [];
    const line = index + 1;
    const outsideCode = text.replace(/`+[^`]*`+/g, (code) => " ".repeat(code.length));
    const definition = REFERENCE_DEFINITION.exec(outsideCode);
    if (definition !== null) return [{ text: definition[1] ?? "", target: definition[2] ?? definition[3] ?? "", line }];
    const found: (Link & { at: number })[] = [
      ...[...outsideCode.matchAll(INLINE_LINK)].map((match) => ({ text: match[1] ?? "", target: match[2] ?? "", line, at: match.index })),
      ...[...outsideCode.matchAll(HTML_LINK)].map((match) => ({
        text: (match[4] ?? "").replace(/<[^>]*>/g, "").trim(),
        target: match[1] ?? match[2] ?? match[3] ?? "",
        line,
        at: match.index,
      })),
      ...[...outsideCode.matchAll(HTML_IMAGE)].map((match) => ({
        text: /\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0])?.slice(1).find((alt) => alt !== undefined) ?? "",
        target: match[1] ?? match[2] ?? match[3] ?? "",
        line,
        at: match.index,
      })),
    ];
    return found.sort((a, b) => a.at - b.at).map(({ text: linkText, target, line: at }) => ({ text: linkText, target, line: at }));
  });
}

/** The repository's files that are tracked or about to be: tracked, or new and not ignored, relative to the root with forward slashes. */
export function repositoryFiles(root: string): Set<string> {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return new Set(listed.split("\0").filter((file) => file !== ""));
}

export interface LinkProblem extends Link {
  file: string;
  problem: string;
}

/** Whether a target is an address outside the repository: a web or mail address. */
export function isExternal(target: string): boolean {
  return /^(https?:|mailto:)/i.test(target);
}

/**
 * The links of one page, relative to the root, that do not resolve: a
 * relative path to no file or folder of the repository, a path out of it, or
 * a fragment that names no heading of the page it points to. Web and mail
 * addresses are left alone; no check here reaches the network.
 */
export function linkProblems(root: string, file: string, files: ReadonlySet<string> = repositoryFiles(root)): LinkProblem[] {
  const markdown = readFileSync(join(root, file), "utf8");
  const problems: LinkProblem[] = [];
  for (const link of links(markdown)) {
    if (isExternal(link.target)) continue;
    const add = (problem: string) => problems.push({ file, ...link, problem });
    const [path = "", fragment] = link.target.split("#", 2);
    const target = path === "" ? file : normalize(join(dirname(file), decodeURIComponent(path))).replace(/\\/g, "/").replace(/\/$/, "");
    if (target.startsWith("..") || target.startsWith("/")) {
      add("points outside the repository");
      continue;
    }
    const isFile = files.has(target);
    const isFolder = target === "." || [...files].some((known) => known.startsWith(`${target}/`));
    if (!isFile && !isFolder) {
      add(`points to ${target}, which the repository does not hold`);
      continue;
    }
    if (fragment === undefined || fragment === "") continue;
    if (!isFile || !target.endsWith(".md")) {
      add(`names the heading #${fragment} in ${target}, which is no Markdown page`);
      continue;
    }
    const page = target === file ? markdown : readFileSync(join(root, target), "utf8");
    if (!headings(page).some(({ anchor }) => anchor === fragment)) add(`names the heading #${fragment}, which ${target} does not have`);
  }
  return problems;
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as proposals from "../src/proposals.ts";
import { closingMarker, createAgentView, FENCE_NAME, fencePreamble, openingMarker, type FencedOrigin } from "../src/render.ts";
import * as toolText from "../src/tool-text.ts";
import { OUTPUT_PATHS, PHRASE_BUILDERS, type FencedText } from "./support/output-paths.ts";

// The fence properties, on every output path of the renderer (agent-safety:
// Content Tiehall did not generate is fenced as data; agent-safety: Fenced
// content cannot close its own fence; agent-safety: Invisible characters are
// stripped from the agent view; agent-safety: Every string shown to agents
// has an origin; design.md, Technical decisions: T14 and T17). The renderer's
// own property tests (render-fence.test.ts) hold for the texts it is given;
// these hold for what each path gives it. For any texts people or other
// systems wrote, in every place a path puts such a text, the markdown holds
// each in a fence of its own, in order, after a preamble that names its origin
// as the reader sees it, with every marker it holds escaped and every listed
// invisible character stripped; nothing outside the fences' own markers
// begins a marker, and the texts a path states as Tiehall's own stay outside
// every fence. The texts are arbitrary strings mixed with marker-like pieces,
// closing markers with guessed nonces, the exact opening and closing markers
// of the response they are rendered in, and the listed invisible characters;
// and every listed code point, one at a time, is stripped from every path.
// A text in a value Tiehall states, such as a key or a login, is refused,
// and the refusal never quotes it.
//
// The suite checks that it covers every path: every builder that
// tool-text.ts and proposals.ts export is a path here, or a phrase that paths
// put into Tiehall's own text; and every file that renders for agents, or
// imports a builder, renders only through the paths here. The surfaces'
// tests check that each MCP tool and CLI command renders through a path of
// this table (packages/commands/test/output-path-coverage.test.ts and
// packages/cli/test/output-path-coverage.test.ts).

/** Every code point the agent view strips. */
const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0xe0000, 0xe007f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const STRIPPED = STRIPPED_RANGES.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, index) => String.fromCodePoint(first + index)));
const isStripped = (char: string) => STRIPPED.includes(char);
const visible = (text: string) => [...text].filter((char) => !isStripped(char)).join("");
const invisibleIn = (text: string) => [...text].filter(isStripped);

/** Anything that begins a marker unescaped. */
const MARKER_START = new RegExp(`<\\s*\\/?\\s*${FENCE_NAME}`, "gi");
/** The documented escape, undone. */
const unescape = (text: string) => text.replace(new RegExp(`&lt;(?=\\s*\\/?\\s*${FENCE_NAME})`, "gi"), "<");
/** A text as the agent view gives it back, compared with what was written: stripped, then its escape undone. */
const readBack = (text: string) => unescape(visible(text));

/** Stand-ins for the response's own markers, which a case gets once the response's nonce is made. */
const EXACT_CLOSING = "\u{F0000}exact closing marker\u{F0000}";
const EXACT_OPENING = "\u{F0000}exact opening marker\u{F0000}";

/** Pieces that look like markers, or hide text, so generated texts often hold one. */
const piece = fc.oneof(
  fc.string({ unit: "binary", maxLength: 8 }),
  fc.constantFrom(`<${FENCE_NAME}>`, `</${FENCE_NAME}>`, `</${FENCE_NAME}-`, `< / ${FENCE_NAME.toUpperCase()}-`, `<​/${FENCE_NAME}-`, 'origin="tiehall">', "```", "\n", "\r\n", ">", "<", "/", "&lt;"),
  fc.constantFrom(...STRIPPED),
  fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 32, maxLength: 32 }).map((nonce) => `</${FENCE_NAME}-${nonce}>`),
  fc.constantFrom(EXACT_CLOSING, EXACT_OPENING),
);

/**
 * Texts people or other systems write: from full Unicode, or pieced together;
 * never empty, as no such text a path shows is: a path leaves out empty notes.
 */
const writtenText = fc
  .oneof(fc.string({ unit: "binary", minLength: 1 }), fc.array(piece, { minLength: 1, maxLength: 12 }).map((parts) => parts.join("")))
  .filter((text) => text !== "");

/** The texts with the stand-ins replaced by the markers of the response whose nonce this is. */
function withResponseMarkers(texts: readonly string[], nonce: string): string[] {
  return texts.map((text) => text.replaceAll(EXACT_CLOSING, closingMarker(nonce)).replaceAll(EXACT_OPENING, openingMarker(nonce, "other team")));
}

const OPENING = new RegExp(`<${FENCE_NAME}-([0-9a-f]{32}) origin="(same team|other team|external)">\\n`, "g");

/**
 * Checks a response's markdown: its fences hold exactly these texts, in order,
 * each after its preamble, escaped and stripped; nothing else begins a marker;
 * and each of Tiehall's own texts is outside the fences, escaped and stripped.
 */
function expectFenced(markdown: string, nonce: string, fenced: readonly FencedText[], own: readonly string[]): void {
  const fences: { origin: FencedOrigin; content: string }[] = [];
  let outside = "";
  let from = 0;
  for (const opening of markdown.matchAll(OPENING)) {
    const [marker, markerNonce, origin] = opening as unknown as [string, string, FencedOrigin];
    const at = opening.index ?? 0;
    expect(markerNonce).toBe(nonce);
    expect(at).toBeGreaterThanOrEqual(from);
    const preamble = `${fencePreamble(origin)}\n`;
    expect(markdown.slice(from, at).endsWith(preamble)).toBe(true);
    const start = at + marker.length;
    const end = markdown.indexOf(`\n${closingMarker(nonce)}`, start - 1);
    expect(end).toBeGreaterThanOrEqual(start - 1);
    fences.push({ origin, content: markdown.slice(start, Math.max(start, end)) });
    outside += markdown.slice(from, at - preamble.length);
    from = end + 1 + closingMarker(nonce).length;
  }
  outside += markdown.slice(from);
  expect(fences.map(({ origin, content }) => ({ origin, text: readBack(content) }))).toEqual(fenced.map(({ origin, text }) => ({ origin, text: readBack(text) })));
  for (const { content } of fences) {
    expect(content.match(MARKER_START)).toBeNull();
    expect(invisibleIn(content)).toEqual([]);
  }
  expect(markdown.match(MARKER_START) ?? []).toHaveLength(2 * fences.length);
  expect(invisibleIn(markdown)).toEqual([]);
  for (const text of own) expect(readBack(outside)).toContain(readBack(text));
}

describe.each(Object.entries(OUTPUT_PATHS))("the path %s", (_, path) => {
  it("fences each text it did not write after a preamble naming its origin, escaped and stripped, for arbitrary texts and markers", () => {
    fc.assert(
      fc.property(fc.array(writtenText, { minLength: path.texts, maxLength: path.texts }), (drawn) => {
        const view = createAgentView();
        const { input, reader, fenced, own } = path.build(withResponseMarkers(drawn, view.nonce));
        expectFenced(view.markdown(path.render(input, reader)), view.nonce, fenced, own);
      }),
    );
  });

  it("strips every listed code point, one at a time, wherever the path puts a text", () => {
    for (const char of STRIPPED) {
      const view = createAgentView();
      const texts = Array.from({ length: path.texts }, () => `a${char}<${char}/${FENCE_NAME}>${char}b`);
      const { input, reader, fenced, own } = path.build(texts);
      const markdown = view.markdown(path.render(input, reader));
      expect(invisibleIn(markdown), `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`).toEqual([]);
      expectFenced(markdown, view.nonce, fenced, own);
    }
  });

  it("refuses a text in a value Tiehall states, such as a key or a login, and never quotes it", () => {
    fc.assert(
      fc.property(writtenText, (text) => {
        const misplaced = `${text} <not of its form>`;
        const { input, reader } = path.misplace(misplaced);
        let refusal: unknown;
        try {
          path.render(input, reader);
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(TypeError);
        expect((refusal as Error).message).not.toContain("<not of its form>");
      }),
    );
  });
});

/** The repository's root. */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every TypeScript source file under a folder, skipping dependencies and build output. */
function sources(folder: string): string[] {
  let found: string[] = [];
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === ".next" || name === "test" || name === "fixtures") continue;
    const path = join(folder, name);
    if (statSync(path).isDirectory()) found = found.concat(sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

/** The files that render for agents, and what each renders through. */
const RENDERING_FILES: Readonly<Record<string, string>> = {
  "packages/commands/src/mcp.ts": "every tool's result, through TOOL_TEXTS, whose paths output-path-coverage.test.ts in packages/commands checks",
  "packages/commands/src/request-urls.ts": "the markdown of request URLs and intake pages, through requestWithThreadText and teamIntakeText",
  "packages/commands/src/request-pages.ts": "the size of a page as agents read it, through requestPageText",
  "packages/cli/src/output.ts":
    "every command's output, through RENDERERS, and contract diff's, through contractDiffText and contractDiffFailureText, whose paths output-path-coverage.test.ts in packages/cli checks",
};

describe("the suite", () => {
  it("covers every builder tool-text.ts and proposals.ts export, as a path or a phrase that paths put into Tiehall's own text", () => {
    const exported = [...Object.entries(toolText), ...Object.entries(proposals)]
      .filter(([name, value]) => typeof value === "function" && /Text$/.test(name))
      .map(([name]) => name);
    const covered = new Set([...Object.values(OUTPUT_PATHS).map(({ builder }) => builder), ...Object.keys(PHRASE_BUILDERS)]);
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
    expect([...covered].filter((name) => !exported.includes(name))).toEqual([]);
  });

  it("covers every file that renders for agents or imports a builder: each renders only through the paths here", () => {
    const files = [...sources(join(ROOT, "packages")), ...sources(join(ROOT, "apps")), ...sources(join(ROOT, "actions"))]
      .map((file) => relative(ROOT, file))
      .filter((file) => !file.startsWith("packages/packet/"));
    const rendering = files.filter((file) => readFileSync(join(ROOT, file), "utf8").includes("createAgentView("));
    expect(rendering.sort()).toEqual(Object.keys(RENDERING_FILES).sort());
    const covered = new Set([...Object.values(OUTPUT_PATHS).map(({ builder }) => builder), ...Object.keys(PHRASE_BUILDERS)]);
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const [, names] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@tiehall\/packet\/(?:tool-text|proposals)"/g)) {
        const builders = (names ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== "" && !name.startsWith("type ") && /Text$/.test(name));
        expect(builders.filter((name) => !covered.has(name)), file).toEqual([]);
      }
    }
  });

  it("fails on a builder that is no path, as a fixture export shows", () => {
    const exported = { ...toolText, fixtureNoticeText: () => [] };
    const covered = new Set([...Object.values(OUTPUT_PATHS).map(({ builder }) => builder), ...Object.keys(PHRASE_BUILDERS)]);
    const missing = Object.entries(exported)
      .filter(([name, value]) => typeof value === "function" && /Text$/.test(name))
      .map(([name]) => name)
      .filter((name) => !covered.has(name));
    expect(missing).toEqual(["fixtureNoticeText"]);
  });
});

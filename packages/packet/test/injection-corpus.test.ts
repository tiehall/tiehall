import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentJson, closingMarker, createAgentView, FENCE_NAME, fencePreamble, openingMarker } from "../src/render.ts";

// The injection corpus (agent-safety: Fenced content cannot close its own
// fence; agent-safety: Invisible characters are stripped from the agent
// view). Each entry of injection-corpus.json is an attempt to escape the fence
// or to hide text from a person: fake closing markers, a guessed nonce, a fake
// preamble, markers split by invisible characters, text in Unicode tag
// characters, bidirectional overrides, an attempt to leave a JSON string, and
// the escape sequences, carriage returns and operating-system commands a
// terminal acts on (decisions-from-groups-15-28: design.md, Decisions this
// change rests on: D55 (36)).
// Rendered as markdown, each entry stays in one fence, with every marker it
// holds escaped; rendered as JSON, it stays under its untrusted object; and in
// both views, no invisible character of the spec's list is left.

interface Entry {
  name: string;
  text: string;
}

const corpus = (JSON.parse(readFileSync(new URL("./injection-corpus.json", import.meta.url), "utf8")) as { entries: Entry[] }).entries;

/** The code points the spec strips from the agent view, by range. */
const STRIPPED_RANGES: readonly [number, number][] = [
  [0xe0000, 0xe007f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],  // The control characters a terminal acts on (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (36)).
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x007f],
  [0x0080, 0x009f],
];
const isStripped = (codePoint: number) => STRIPPED_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
const visible = (text: string) => [...text].filter((char) => !isStripped(char.codePointAt(0) ?? 0)).join("");
const invisibleIn = (text: string) => [...text].filter((char) => isStripped(char.codePointAt(0) ?? 0));

const MARKER_START = new RegExp(`<\\s*\\/?\\s*${FENCE_NAME}`, "gi");
const unescape = (text: string) => text.replace(new RegExp(`&lt;(?=\\s*\\/?\\s*${FENCE_NAME})`, "gi"), "<");

/** An entry as another team's message, rendered as markdown, and the content of its fence. */
function asMarkdown(text: string) {
  const view = createAgentView();
  const markdown = view.markdown([{ origin: "other team", text }]);
  const head = `${fencePreamble("other team")}\n${openingMarker(view.nonce, "other team")}\n`;
  const tail = `\n${closingMarker(view.nonce)}`;
  return { view, markdown, head, tail, content: markdown.slice(head.length, markdown.length - tail.length) };
}

/** An entry as the body of a message in the JSON an agent reads, after a round trip through JSON text. */
function asJson(text: string) {
  return JSON.parse(JSON.stringify(agentJson({ key: "FE-142", state: "open", untrusted: { body: text } }))) as Record<string, unknown>;
}

describe("the injection corpus", () => {
  it("holds marker-like text and characters of every stripped range", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(25);
    expect(corpus.filter(({ text }) => visible(text).match(MARKER_START) !== null).length).toBeGreaterThanOrEqual(10);
    const codePoints = corpus.flatMap(({ text }) => invisibleIn(text).map((char) => char.codePointAt(0) ?? 0));
    for (const [first, last] of STRIPPED_RANGES) {
      expect(codePoints.some((codePoint) => codePoint >= first && codePoint <= last), `U+${first.toString(16).toUpperCase()}`).toBe(true);
    }
  });
});

describe.each(corpus)("$name", ({ text }) => {
  it("stays in one fence as markdown, with every marker it holds escaped", () => {
    const { view, markdown, head, tail, content } = asMarkdown(text);
    expect(markdown.startsWith(head) && markdown.endsWith(tail)).toBe(true);
    expect(markdown.split(openingMarker(view.nonce, "other team")).length - 1).toBe(1);
    expect(markdown.split(closingMarker(view.nonce)).length - 1).toBe(1);
    expect(content.match(MARKER_START)).toBeNull();
    if (text.match(MARKER_START) !== null) expect(content).toContain("&lt;");
    expect(visible(unescape(content))).toBe(visible(unescape(text)));
  });

  it("stays under its untrusted object as JSON", () => {
    const json = asJson(text);
    expect(Object.keys(json)).toEqual(["key", "state", "untrusted"]);
    expect(json).toMatchObject({ key: "FE-142", state: "open" });
    const untrusted = json["untrusted"] as Record<string, unknown>;
    expect(Object.keys(untrusted)).toEqual(["body"]);
    expect(visible(String(untrusted["body"]))).toBe(visible(text));
  });
});

describe("the stripped characters", () => {
  it("are gone from every entry as markdown, and nothing else is", () => {
    for (const { name, text } of corpus) {
      const { markdown, content } = asMarkdown(text);
      expect(invisibleIn(markdown), name).toEqual([]);
      expect(unescape(content), name).toBe(visible(unescape(text)));
      // A marker that only stripping completes is escaped too.
      if (visible(text).match(MARKER_START) !== null) expect(content, name).toContain("&lt;");
    }
  });

  it("are gone from every entry as JSON, and nothing else is", () => {
    for (const { name, text } of corpus) {
      const body = (asJson(text)["untrusted"] as Record<string, unknown>)["body"];
      expect(body, name).toBe(visible(text));
    }
  });
});

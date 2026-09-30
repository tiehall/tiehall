import { describe, expect, it } from "vitest";
import { agentJson, createAgentView } from "@tiehall/packet/render";
import { requestPageText } from "@tiehall/packet/tool-text";
import { PAGE_CHARACTERS, pagesOf, type PagePartView, type RequestPageView } from "../src/request-pages.ts";

// Cutting a request into pages (agent-surfaces: Reading a request by key or
// URL, in pages; design.md, Decisions this change rests on: D28 #69). A page
// holds at most 8,000 tokens at 4 characters per token, 32,000 characters,
// counting what an agent reads of it: its markdown and its structured content
// as compact JSON. Parts follow in order, as many as fit; a text too long for
// one page is split over several, as parts of one field or message, whose
// texts join back to it exactly, and never between the two halves of a
// surrogate pair. Pages of one section hold that section's parts only.

const FE = { id: "00000000-0000-4000-8000-000000000001", key: "FE" };
const QA = { id: "00000000-0000-4000-8000-000000000002", key: "QA" };
const sam = { id: "00000000-0000-4000-8000-000000000003", login: "sam-qa", kind: "human" as const, bot: false };

const request = {
  id: "00000000-0000-4000-8000-000000000010",
  key: "FE-142",
  state: "open" as const,
  targetTeam: FE,
  requester: { user: sam, team: QA },
  claimant: null,
  createdAt: "2026-09-30T08:00:00.000Z",
  needsHuman: false,
  untrusted: { title: "Add a dark mode" },
};

const packet = { revision: 1, kind: "request" as const, dueDate: null, team: QA };

function field(name: string, text: string): PagePartView {
  return { kind: "packet_field", field: name, part: 1, parts: 1, untrusted: { text } };
}

function message(id: number, text: string): PagePartView {
  return {
    kind: "message",
    message: {
      id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
      kind: "comment",
      blocking: false,
      questionId: null,
      answered: null,
      version: 1,
      postedAt: "2026-09-30T08:05:00.000Z",
      editedAt: null,
      provenance: { actorKind: "web_session", surface: "web", user: sam, team: QA },
    },
    part: 1,
    parts: 1,
    untrusted: { text, client: null },
  };
}

/** What an agent reads of a page, in characters: its markdown and its structured content as compact JSON. */
function size(page: RequestPageView, teams: readonly string[] = ["FE"]): number {
  const output = agentJson(page);
  return createAgentView().markdown(requestPageText(output, { teams })).length + JSON.stringify(output).length;
}

/** The texts of the parts over every page, joined by field or message. */
function joined(pages: readonly RequestPageView[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const page of pages) {
    for (const part of page.parts) {
      const id = part.kind === "message" ? part.message.id : part.field;
      texts.set(id, (texts.get(id) ?? "") + part.untrusted.text);
    }
  }
  return texts;
}

describe("the pages of a request", () => {
  it("hold a request that fits in one page as page 1 of 1, with no next page", () => {
    const pages = pagesOf({ request, packet, parts: [field("need", "A dark mode."), message(1, "Which browsers?")], section: "all", reader: { teams: ["FE"] } });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ section: "all", page: 1, pages: 1, next: null });
    expect(pages[0]?.parts).toHaveLength(2);
  });

  it("keep every page within 32,000 characters, split long texts over pages, and give each text back whole", () => {
    const need = "N".repeat(20_000);
    // Quotes and control characters take more characters as JSON than as text.
    const quoted = '"\\'.repeat(15_000);
    const control = "\u0001\u0002".repeat(10_000);
    const pages = pagesOf({
      request,
      packet,
      parts: [field("need", need), message(1, quoted), message(2, control), message(3, "Short.")],
      section: "all",
      reader: { teams: ["FE"] },
    });
    expect(pages.length).toBeGreaterThan(3);
    expect(PAGE_CHARACTERS).toBe(32_000);
    pages.forEach((page, index) => {
      expect(size(page), `page ${index + 1}`).toBeLessThanOrEqual(PAGE_CHARACTERS);
      expect(page.page).toBe(index + 1);
      expect(page.pages).toBe(pages.length);
      expect(page.next).toEqual(index + 1 === pages.length ? null : { section: "all", page: index + 2 });
    });
    const texts = joined(pages);
    expect(texts.get("need")).toBe(need);
    expect([...texts.values()]).toEqual([need, quoted, control, "Short."]);
    // A split text's parts say where each sits among them.
    const needParts = pages.flatMap(({ parts }) => parts).filter((part) => part.kind === "packet_field");
    expect(needParts.length).toBeGreaterThan(1);
    expect(needParts.map(({ part, parts }) => [part, parts])).toEqual(needParts.map((_, index) => [index + 1, needParts.length]));
  });

  it("never split a text between the two halves of a surrogate pair", () => {
    const emoji = "😀".repeat(20_000);
    const pages = pagesOf({ request, packet, parts: [message(1, emoji)], section: "all", reader: { teams: [] } });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      for (const part of page.parts) expect(part.untrusted.text).toMatch(/^(?:😀)+$/);
    }
    expect(joined(pages).get("00000000-0000-4000-8000-000000000001")).toBe(emoji);
  });

  it("hold only the parts of the section a reader names, in pages of their own", () => {
    const parts = [field("need", "A dark mode."), message(1, "Which browsers?"), message(2, "The last two of each.")];
    const thread = pagesOf({ request, packet, parts, section: "thread", reader: { teams: ["FE"] } });
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ section: "thread", page: 1, pages: 1, next: null });
    expect(thread[0]?.parts.map(({ kind }) => kind)).toEqual(["message", "message"]);
    const packetPages = pagesOf({ request, packet, parts, section: "packet", reader: { teams: ["FE"] } });
    expect(packetPages[0]?.parts.map(({ kind }) => kind)).toEqual(["packet_field"]);
  });

  it("give a section with nothing in it one empty page", () => {
    const pages = pagesOf({ request, packet, parts: [field("need", "A dark mode.")], section: "thread", reader: { teams: [] } });
    expect(pages).toEqual([expect.objectContaining({ section: "thread", page: 1, pages: 1, next: null, parts: [] })]);
  });
});

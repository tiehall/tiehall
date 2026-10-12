import { PAGE_CHARACTERS, readRequest, type Packet, type requestPage } from "@tiehall/catalog";
import { REQUEST_KEY, Refusal } from "@tiehall/core";
import { packetRevisions, teams } from "@tiehall/db";
import { agentJson, createAgentView } from "@tiehall/packet/render";
import { requestPageText, type Reader } from "@tiehall/packet/tool-text";
import { and, asc, desc, eq, exists, sql, type Column, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { defineHandler, type Handlers } from "./execute.ts";
import { teamsOfMember } from "./members.ts";
import { packetAsItStands } from "./packet-as-it-stands.ts";
import { actingUserOf } from "./request-changes.ts";
import { resolveRequestKey } from "./request-keys.ts";
import { requestView, threadOf, type MessageView } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";

// Reading a request in pages, for agents (agent-surfaces: Reading a request by
// key or URL, in pages; agent-surfaces: The MCP tools; requests: Every member
// sees every request; design.md, Decisions this change rests on: D28 #69;
// design.md, Self-hosting decisions: S15).
//
// get_request names a request by its key, one written with a team's earlier
// key included, which names the same request under its current key, or by its
// URL on the install's own origin: the install's URL, a slash and the key,
// such as https://tiehall.example.com/FE-142, with or without the .md or
// .json of its other representations. A URL on any other origin is refused as
// input that fails the schema, and nothing is sent to it: the URL is only
// read, never fetched. So is anything that is neither.
//
// The request's text comes as parts: one for each packet field the current
// revision carries, in the order the packet schema gives them, and one for
// each message, oldest first, each with its text as its author wrote it (a
// packet field that is not text, such as the links, as its JSON). A reader may
// name a section, the packet or the thread, and gets that section's parts
// only. The parts are cut into pages of at most 32,000 characters, 8,000
// tokens at 4 characters a token, counting all an agent reads of a page: the
// markdown the MCP route renders from it, with the reader's own teams deciding
// each fence's origin, and its structured content as compact JSON, so no
// result reaches the 10,000 tokens at which Claude Code warns. Parts follow in
// order, as many as fit a page; a text too long for any page is split into
// parts of one field or message, each saying which part it is of how many,
// whose texts join back to the whole, and never between the two halves of a
// surrogate pair. Each page is measured with the largest numbers it could
// carry, and a margin is kept for a reader whose teams change between the
// page's measure and its rendering. A page a section does not have is refused
// as input that fails the schema.

/** A page of a request, as get_request returns it. */
export type RequestPageView = z.input<typeof requestPage>;
/** One part of a page: a packet field's text, or a message's, whole or in parts. */
export type PagePartView = RequestPageView["parts"][number];

export { PAGE_CHARACTERS };

/** What a page's measure leaves for a reader whose teams change before the page is rendered, each fence's origin with them. */
const MARGIN = 500;

/** The largest page or part number a page is measured with. */
const LARGEST = 99_999;

/** The packet fields under `untrusted`, in the order the packet schema gives them. */
const PACKET_FIELDS = ["need", "acceptance_criteria", "code_refs", "links", "contract", "extensions"] as const;

/** The key a request's name gives: the key itself, or the key in a URL on the install's origin; refused as input otherwise. */
export function keyOfRequestName(name: string, installUrl: string | undefined): string {
  if (REQUEST_KEY.test(name)) return name;
  const refused = (message: string) => new Refusal("invalid-input", message, { issues: [{ path: ["request"], message }] });
  let url: URL | undefined;
  try {
    url = new URL(name);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw refused("Name the request by its key, such as FE-142, or by its URL on this install.");
  }
  if (installUrl === undefined || url.origin !== installUrl) {
    throw refused("The URL is not on this install's origin, so Tiehall read nothing from it; name the request by its key, or by its URL on this install.");
  }
  const key = /^\/([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9})(?:\.md|\.json)?$/.exec(url.pathname)?.[1];
  if (key === undefined) throw refused("The URL names no request: a request's URL is the install's URL, a slash and the request's key.");
  return key;
}

/** A team as a page names it, or none for text Tiehall added. */
type Writer = { id: string; key: string } | null;

/**
 * The request's current packet revision, with the team whose member wrote its
 * text, and, for each field, the team whose member wrote that field's text
 * (agent-safety: Every string shown to agents has an origin). The text is the
 * packet's `untrusted` object, and the writer of the packet's text, or of a
 * field's, is the team that added the first revision that held it as it is
 * now: a revision that kept it as it was, such as the one a due date the
 * target team proposed adds once it is confirmed, wrote none of it; a
 * revision by another team that changes one field wrote that field alone, so
 * each other field keeps its origin; and a revision that brought back text an
 * earlier revision held, as undoing a scope change does, wrote none of it
 * either, so that text keeps the origin of the team that first wrote it.
 */
async function currentRevision({ tx, orgId }: OrgContext, requestId: string) {
  const [row] = await tx
    .select({ number: packetRevisions.number, packet: packetRevisions.packet })
    .from(packetRevisions)
    .where(and(eq(packetRevisions.orgId, orgId), eq(packetRevisions.requestId, requestId)))
    .orderBy(desc(packetRevisions.number))
    .limit(1);
  if (row === undefined) throw new Error("A request has no packet revision.");
  const team = await writerOf({ tx, orgId }, requestId, row.number, (packet) => sql`(${packet} -> 'untrusted')::jsonb`);
  const fields = new Map<string, Writer>();
  for (const field of PACKET_FIELDS) {
    fields.set(field, await writerOf({ tx, orgId }, requestId, row.number, (packet) => sql`(${packet} -> 'untrusted' -> ${field})::jsonb`));
  }
  return { number: row.number, packet: packetAsItStands(row.packet), team, fields };
}

/** The team that added the first revision whose `text`, read from its packet, is the one revision `current` holds. */
async function writerOf(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  requestId: string,
  current: number,
  text: (packet: Column) => SQL,
): Promise<Writer> {
  const now = alias(packetRevisions, "now");
  const [writer] = await tx
    .select({ teamId: teams.id, teamKey: teams.key })
    .from(packetRevisions)
    .leftJoin(teams, and(eq(teams.orgId, packetRevisions.orgId), eq(teams.id, packetRevisions.teamId)))
    .where(
      and(
        eq(packetRevisions.orgId, orgId),
        eq(packetRevisions.requestId, requestId),
        exists(
          tx
            .select({ number: now.number })
            .from(now)
            .where(
              and(
                eq(now.orgId, packetRevisions.orgId),
                eq(now.requestId, packetRevisions.requestId),
                eq(now.number, current),
                sql`${text(now.packet)} IS NOT DISTINCT FROM ${text(packetRevisions.packet)}`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(packetRevisions.number))
    .limit(1);
  return writer === undefined || writer.teamId === null || writer.teamKey === null ? null : { id: writer.teamId, key: writer.teamKey };
}

/**
 * The text of a packet field: a text as it is, anything else as its JSON, made
 * from its value as agents read it, so a control character the JSON would
 * write as an escape, such as \u001b, is stripped like every other one
 * (decisions-from-groups-15-28: design.md, Decisions this change rests on:
 * D55 (36)).
 */
function fieldText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(agentJson(value), null, 2);
}

/** The parts of the packet: one for each field the revision carries, with the team that wrote its text. */
function packetParts(packet: Packet, writers: ReadonlyMap<string, Writer>): PagePartView[] {
  const fields = packet.untrusted as Record<string, unknown>;
  return PACKET_FIELDS.filter((field) => fields[field] !== undefined).map((field) => ({
    kind: "packet_field" as const,
    field,
    part: 1,
    parts: 1,
    team: writers.get(field) ?? null,
    untrusted: { text: fieldText(fields[field]) },
  }));
}

/** The parts of the thread: one for each message, oldest first. */
function threadParts(thread: readonly MessageView[]): PagePartView[] {
  return thread.map(({ untrusted, ...facts }) => ({
    kind: "message" as const,
    message: facts,
    part: 1,
    parts: 1,
    untrusted: { text: untrusted.body, client: untrusted.client },
  }));
}

/** What a reader asks to read of a request, and whose teams decide the origins its pages are measured with. */
export interface PagingInput {
  request: RequestPageView["request"];
  packet: RequestPageView["packet"];
  /** Every part of the request, each whole. */
  parts: readonly PagePartView[];
  section: RequestPageView["section"];
  reader: Reader;
}

/** What an agent reads of a page, in characters: its markdown and its structured content as compact JSON. */
function sizeOf(page: RequestPageView, reader: Reader): number {
  const output = agentJson(page);
  return createAgentView().markdown(requestPageText(output, reader)).length + JSON.stringify(output).length;
}

/** The part with this text, as this part of how many. */
function withText(part: PagePartView, text: string, number: number, parts: number): PagePartView {
  return part.kind === "message"
    ? { ...part, part: number, parts, untrusted: { ...part.untrusted, text } }
    : { ...part, part: number, parts, untrusted: { text } };
}

/** Whether a UTF-16 code unit is the first half of a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Every page of the section a reader asks for, each within the page's characters. */
export function pagesOf(input: PagingInput): RequestPageView[] {
  const { request, packet, section, reader } = input;
  const budget = PAGE_CHARACTERS - MARGIN;
  const fits = (parts: PagePartView[]) =>
    sizeOf({ request, packet, section, page: LARGEST, pages: LARGEST, next: { section, page: LARGEST }, parts }, reader) <= budget;
  const wanted = input.parts.filter(({ kind }) => section === "all" || (section === "packet" ? kind === "packet_field" : kind === "message"));
  const chunks = wanted.flatMap((part) => split(part, fits));
  const pages: PagePartView[][] = [];
  let current: PagePartView[] = [];
  for (const chunk of chunks) {
    if (current.length > 0 && !fits([...current, chunk])) {
      pages.push(current);
      current = [];
    }
    current.push(chunk);
  }
  pages.push(current);
  return pages.map((parts, index) => ({
    request,
    packet,
    section,
    page: index + 1,
    pages: pages.length,
    next: index + 1 < pages.length ? { section, page: index + 2 } : null,
    parts,
  }));
}

/** A part as the pieces a page can hold alone: itself when it fits, or its text split into parts of it. */
function split(part: PagePartView, fits: (parts: PagePartView[]) => boolean): PagePartView[] {
  if (fits([part])) return [part];
  const pieces: string[] = [];
  let rest = part.untrusted.text;
  const piece = (length: number) => fits([withText(part, rest.slice(0, length), LARGEST, LARGEST)]);
  while (rest.length > 0) {
    if (piece(rest.length)) {
      pieces.push(rest);
      break;
    }
    // The longest start of the rest that a page holds, found by halving: `low` fits and `high` does not.
    let low = 0;
    let high = rest.length;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (piece(middle)) low = middle;
      else high = middle;
    }
    let length = low;
    if (length > 1 && isHighSurrogate(rest.charCodeAt(length - 1))) length -= 1;
    if (length < 1) throw new Error("A page cannot hold one character of a part.");
    pieces.push(rest.slice(0, length));
    rest = rest.slice(length);
  }
  return pieces.map((text, index) => withText(part, text, index + 1, pieces.length));
}

export const REQUEST_PAGE_HANDLERS: Handlers = {
  [readRequest.id]: defineHandler(readRequest, async ({ request: name, section, page }, context) => {
    const { requestId } = await resolveRequestKey(context, keyOfRequestName(name, context.url));
    const view = await requestView(context, requestId);
    const revision = await currentRevision(context, requestId);
    const parts = [...packetParts(revision.packet, revision.fields), ...threadParts(await threadOf(context, requestId))];
    // The reader's teams, which decide each fence's origin in the markdown the page is measured by.
    const reader: Reader = { teams: (await teamsOfMember(context, actingUserOf(context))).map(({ key }) => key) };
    const packet = { revision: revision.number, kind: revision.packet.kind, dueDate: revision.packet.due_date ?? null, team: revision.team };
    const pages = pagesOf({ request: view, packet, parts, section: section ?? "all", reader });
    const found = pages[(page ?? 1) - 1];
    if (found === undefined) {
      const message = `The request has ${pages.length} page${pages.length === 1 ? "" : "s"} in this section.`;
      throw new Refusal("invalid-input", message, { issues: [{ path: ["page"], message }] });
    }
    return found;
  }),
};

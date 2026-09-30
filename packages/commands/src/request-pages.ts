import { readRequest, type Packet, type requestPage } from "@tiehall/catalog";
import { packetRevisions, teams } from "@tiehall/db";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { defineHandler, type Handlers } from "./execute.ts";
import { resolveRequestKey } from "./request-keys.ts";
import { requestView, threadOf, type MessageView } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";

// Reading a request in pages, for agents (agent-surfaces: Reading a request by
// key or URL, in pages; agent-surfaces: The MCP tools; requests: Every member
// sees every request). get_request reads a request, which every member may
// read, by its key, one written with a team's earlier key included, which
// names the same request under its current key. It returns the request, the
// facts of its current packet revision, and the text of its packet and its
// thread as parts: one part for each packet field the current revision
// carries, in the order the packet schema gives them, and one for each
// message, oldest first. Text people wrote is kept as they wrote it: a packet
// field that is text is its text, and any other field, such as the links, is
// its JSON.

/** A page of a request, as get_request returns it. */
export type RequestPageView = z.input<typeof requestPage>;
type PagePart = RequestPageView["parts"][number];

/** The packet fields under `untrusted`, in the order the packet schema gives them. */
const PACKET_FIELDS = ["need", "acceptance_criteria", "code_refs", "links", "contract", "extensions"] as const;

/** The request's current packet revision, with the team whose member added it. */
async function currentRevision({ tx, orgId }: OrgContext, requestId: string) {
  const [row] = await tx
    .select({ number: packetRevisions.number, packet: packetRevisions.packet, teamId: teams.id, teamKey: teams.key })
    .from(packetRevisions)
    .leftJoin(teams, and(eq(teams.orgId, packetRevisions.orgId), eq(teams.id, packetRevisions.teamId)))
    .where(and(eq(packetRevisions.orgId, orgId), eq(packetRevisions.requestId, requestId)))
    .orderBy(desc(packetRevisions.number))
    .limit(1);
  if (row === undefined) throw new Error("A request has no packet revision.");
  const team = row.teamId === null || row.teamKey === null ? null : { id: row.teamId, key: row.teamKey };
  return { number: row.number, packet: row.packet as Packet, team };
}

/** The text of a packet field: a text as it is, anything else as its JSON. */
function fieldText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** The parts of the packet: one for each field the revision carries. */
function packetParts(packet: Packet): PagePart[] {
  const fields = packet.untrusted as Record<string, unknown>;
  return PACKET_FIELDS.filter((field) => fields[field] !== undefined).map((field) => ({
    kind: "packet_field" as const,
    field,
    part: 1,
    parts: 1,
    untrusted: { text: fieldText(fields[field]) },
  }));
}

/** The parts of the thread: one for each message, oldest first. */
function threadParts(thread: readonly MessageView[]): PagePart[] {
  return thread.map(({ untrusted, ...facts }) => ({
    kind: "message" as const,
    message: facts,
    part: 1,
    parts: 1,
    untrusted: { text: untrusted.body, client: untrusted.client },
  }));
}

export const REQUEST_PAGE_HANDLERS: Handlers = {
  [readRequest.id]: defineHandler(readRequest, async ({ request: key }, context) => {
    const { requestId } = await resolveRequestKey(context, key);
    const view = await requestView(context, requestId);
    const revision = await currentRevision(context, requestId);
    const parts = [...packetParts(revision.packet), ...threadParts(await threadOf(context, requestId))];
    return {
      request: view,
      packet: { revision: revision.number, kind: revision.packet.kind, dueDate: revision.packet.due_date ?? null, team: revision.team },
      section: "all" as const,
      page: 1,
      pages: 1,
      next: null,
      parts,
    };
  }),
};

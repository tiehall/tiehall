import { getPacket, getRequest, listRequestProposals, readDirectory, requestActivity, whoami } from "@tiehall/catalog";
import type { ProblemDetails } from "@tiehall/core";
import type { z } from "zod";
import type { PacketRevisionView } from "./packet-revisions.ts";
import type { ProposalView } from "./proposals.ts";
import type { MessageView, RequestView } from "./request-views.ts";
import type { WebCommands, WebResult } from "./web-commands.ts";

// What the web UI's page of a request shows (agent-surfaces: Negotiated
// request URLs; agent-safety: The needs_human flag is visible and reaches the
// people on the request; requests: What a proposal records and shows;
// design.md, Technical decisions: T3): the request with its thread, as the
// /api/v1 read returns it, its packet at its current revision, and its
// proposals, newest first, who reads it, with the reader's teams, which
// decide the actions the page offers them, the install's teams, by key and
// name, which a reassignment picks from and the page names the request's two
// teams by, and its activity: who wrote on it last, whether their agent is at
// work, its latest events and who posted each message (web-ui: The request
// page shows who works on it and what happened; request-activity.ts), each
// read through execute() as the
// reader, in a read-only transaction. The page, a server component, reads them as the
// signed-in member's web session; the proxy that lets a browser through to it
// reads them too, as the same session, for the page's ETag, which so changes
// whenever what the page shows of the request does.

/** A request with its thread, oldest message first, and its pending proposals, oldest first. */
export type RequestWithThreadView = RequestView & { messages: MessageView[]; pendingProposals: ProposalView[] };

/** Who reads the page, as whoami says: the user, by id, and the teams they belong to. */
export interface RequestPageViewer {
  user: { id: string };
  teams: { id: string; key: string }[];
}

/** A request's activity, as requests.activity reads it. */
export type RequestActivityView = z.output<typeof requestActivity.output>;

/** What the page of a request shows. */
export interface RequestPageData {
  request: RequestWithThreadView;
  packet: PacketRevisionView;
  proposals: ProposalView[];
  viewer: RequestPageViewer;
  /** The install's teams, by key and name, in the directory's order. */
  teams: { key: string; name: string }[];
  activity: RequestActivityView;
}

/** Runs one of the page's reads as its reader; a refusal is thrown. */
export type PageRead = <Output>(commandId: string, input: unknown) => Promise<Output>;

/** Reads what the page of a request shows, from the request's own key; the request's read is given when the caller has it already. */
export async function readRequestPage(read: PageRead, key: string, request?: RequestWithThreadView): Promise<RequestPageData> {
  const found = request ?? (await read<RequestWithThreadView>(getRequest.id, { key }));
  const packet = await read<PacketRevisionView>(getPacket.id, { key: found.key });
  // The key is quoted, so the source-citation check does not take the name and its colon for a citation of the capability.
  const { "proposals": proposals } = await read<{ "proposals": ProposalView[] }>(listRequestProposals.id, { key: found.key });
  const { user, teams } = await read<RequestPageViewer>(whoami.id, {});
  const directory = await read<{ teams: { key: string; untrusted: { name: string } }[] }>(readDirectory.id, {});
  const activity = await read<RequestActivityView>(requestActivity.id, { key: found.key });
  return {
    request: found,
    packet,
    proposals,
    viewer: { user: { id: user.id }, teams: teams.map(({ id, key }) => ({ id, key })) },
    teams: directory.teams.map(({ key, untrusted }) => ({ key, name: untrusted.name })),
    activity,
  };
}

/**
 * What the page's ETag is made from: the request, its packet, its proposals,
 * its reader's teams and the install's, and its activity but the moment it was
 * read, as its reader reads them.
 */
export function requestPageFacts({ request, packet, proposals, viewer, teams, activity }: RequestPageData): string[] {
  const { now: _now, ...lasting } = activity;
  return [JSON.stringify(request), JSON.stringify(packet), JSON.stringify(proposals), JSON.stringify(viewer), JSON.stringify(teams), JSON.stringify(lasting)];
}

/** A web session's refusal of one of the page's reads, carried out of readRequestPage(). */
class PageReadRefused extends Error {
  readonly problem: ProblemDetails;
  constructor(problem: ProblemDetails) {
    super(problem.title);
    this.problem = problem;
  }
}

/** Reads what the page of a request shows as the signed-in member's web session, for the server component: its data, or the problem a read was refused with. */
export async function readRequestPageAs(web: WebCommands, key: string): Promise<WebResult<RequestPageData>> {
  const read: PageRead = async <Output>(commandId: string, input: unknown) => {
    const result = await web.read<Output>(commandId, input);
    if (!result.ok) throw new PageReadRefused(result.problem);
    return result.output;
  };
  try {
    return { ok: true, output: await readRequestPage(read, key) };
  } catch (error) {
    if (error instanceof PageReadRefused) return { ok: false, problem: error.problem };
    throw error;
  }
}

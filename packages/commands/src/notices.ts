import { formatRequestKey } from "@tiehall/core";
import { noticeEventType, noticeKey, noticeTeam, noticeUrl, type Notice } from "@tiehall/packet/notices";
import { requests, teams } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { OrgContext } from "./with-org.ts";

// What a notice about an event says (agent-safety: Notices that can reach a
// model carry only server text; design.md, Self-hosting decisions: S10;
// design.md, Readings to confirm with the founder: R16). The hooks, through
// the wait endpoint, and the notification emails tell people about an event
// on a request with a notice made from Tiehall's own records alone: the
// request's key, the event's type, the request's target team and the
// request's URL on the install, each checked against its form by the notice
// templates. Nothing that people wrote, such as the title, the packet or a
// message, is read here. An event about no request, such as a role change,
// gives no notice.

/** An event as a notice reads it: its type and the ids and values it carries. */
export interface NoticeEvent {
  type: string;
  data: Readonly<Record<string, unknown>>;
}

/** The notice about an event on a request, for the install at installUrl; undefined for an event about no request. */
export async function noticeOfEvent({ tx, orgId }: OrgContext, installUrl: string, event: NoticeEvent): Promise<Notice | undefined> {
  const requestId = event.data["requestId"];
  if (typeof requestId !== "string") return undefined;
  const [row] = await tx
    .select({ number: requests.number, teamKey: teams.key })
    .from(requests)
    .innerJoin(teams, and(eq(teams.orgId, requests.orgId), eq(teams.id, requests.targetTeamId)))
    .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));
  if (row === undefined) return undefined;
  const key = noticeKey(formatRequestKey(row.teamKey, row.number));
  return { key, eventType: noticeEventType(event.type), team: noticeTeam(row.teamKey), url: noticeUrl(installUrl, key) };
}

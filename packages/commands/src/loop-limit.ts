import { recordAgentWrite, Refusal, requestNeedsHumanCleared, requestNeedsHumanFlagged } from "@tiehall/core";
import { requests } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { OrgContext } from "./with-org.ts";
import type { Writer } from "./write.ts";

// The loop limit in the writing transaction (agent-safety: Runaway agent loops
// flag the request needs_human; public-api: One error model for Tiehall's own
// refusals; design.md, Decisions this change rests on: D28 #50, D30 (1), (4);
// design.md, Technical decisions: T14; design.md, Self-hosting decisions: S7).
// Every write on an existing request declares it through the writer's
// changesRequest(), which runs countAgentWrite() in the write's own
// transaction, holding the request's row lock:
// - a write made with an OAuth token or a personal access token, recorded with
//   the actor kind agent, is refused with 409 needs-human while the request is
//   flagged, and is not counted; otherwise its time joins the request's agent
//   writes, and the write that makes 7 within 10 minutes, or 30 in total,
//   flags the request and is accepted;
// - a write recorded as system, integration or web_session is neither counted
//   nor refused.
// Setting the flag and clearing it each append a domain event on the request
// in the same transaction (agent-safety: The needs_human flag is visible and
// reaches the people on the request), which the pull readers carry, with no
// email at once. Because the row is locked, two writes at once take turns, and
// only one of them can pass the limit. A refused write, and a write that fails later,
// rolls back with its count. A human action, a message posted from a web
// session or a confirmation in the web UI of a proposal on the request (task
// 14.8 calls the same function), clears the flag and both counts with
// recordHumanAction(). Acknowledging events and reading write nothing on a
// request, so neither ever meets the limit.

/** The request's loop state, with its row locked until the write's transaction ends. */
async function lockLoopState({ tx, orgId }: OrgContext, requestId: string) {
  const [row] = await tx
    .select({ needsHuman: requests.needsHuman, agentWriteTimes: requests.agentWriteTimes })
    .from(requests)
    .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)))
    .for("update");
  if (row === undefined) throw new Error("A write names a request the install does not have.");
  return row;
}

/** Counts an agent's write on the request, or refuses it while the request waits for a person. */
export async function countAgentWrite(writer: Writer, requestId: string): Promise<void> {
  if (writer.provenance.actorKind !== "agent") return;
  const state = await lockLoopState(writer, requestId);
  if (state.needsHuman) {
    throw new Refusal(
      "needs-human",
      "This request waits for a person: agents made too many writes on it since a person last acted. A message posted on it in the web UI lets agents write on it again.",
    );
  }
  const { writes, flags } = recordAgentWrite(state.agentWriteTimes, writer.now());
  await writer.tx
    .update(requests)
    .set({ agentWriteTimes: writes, needsHuman: flags })
    .where(and(eq(requests.orgId, writer.orgId), eq(requests.id, requestId)));
  if (flags) await writer.record(requestNeedsHumanFlagged, { requestId });
}

/** A human action on the request: it clears the flag and restarts both counts. */
export async function recordHumanAction(writer: Writer, requestId: string): Promise<void> {
  const state = await lockLoopState(writer, requestId);
  await writer.tx
    .update(requests)
    .set({ agentWriteTimes: [], needsHuman: false })
    .where(and(eq(requests.orgId, writer.orgId), eq(requests.id, requestId)));
  if (state.needsHuman) await writer.record(requestNeedsHumanCleared, { requestId });
}

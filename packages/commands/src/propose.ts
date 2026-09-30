import { isProposalAnswer, proposeTool, type Packet } from "@tiehall/catalog";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import type { PacketRevisionView } from "./packet-revisions.ts";
import { revisePacket } from "./packets.ts";
import { withdrawProposalFor } from "./proposal-endings.ts";
import type { ProposalAnswer } from "./proposals.ts";
import { proposeReassignment, proposeWithdrawal } from "./requests.ts";
import { requestView } from "./request-views.ts";

// The propose tool (agent-surfaces: Commitment tools return proposals;
// handoff-packet: Immutable, numbered revisions; handoff-packet: Packet
// changes that are commitments; requests: How a proposal ends without taking
// effect; design.md, Decisions this change rests on: D23; D28 #14, #16). It
// runs the same code as the REST operations that make the same commitments,
// so both surfaces refuse and propose alike:
// - due_date makes the packet's next revision from the current one with the
//   due date set, moved or removed, and scope takes the next revision whole,
//   through revisePacket(), which packets.add_revision runs too: the
//   requester side only, the expected revision named or 428, current or 412,
//   and a proposal for what is a commitment, or the revision added at once;
// - reassign and withdraw propose as requests.propose does;
// - withdraw_proposal ends a pending proposal of the caller's user without
//   any effect, as proposals.withdraw does in the web UI, and answers with it.
// A change that made no commitment answers with the request and its packet
// as they are now.

/** The packet with the due date set, or removed when it is null; everything else stays as it is. */
function withDueDate(current: Packet, dueDate: string | null): Packet {
  if (dueDate !== null) return { ...current, due_date: dueDate };
  const { due_date: _removed, ...rest } = current;
  return rest as Packet;
}

/** What a packet change answers when it made no commitment: the request and its packet as they are now. */
async function revised(context: HandlerContext, answer: PacketRevisionView | ProposalAnswer) {
  if (isProposalAnswer(answer)) return answer;
  return { request: await requestView(context, answer.request.id), packet: answer };
}

export const PROPOSE_HANDLERS: Handlers = {
  [proposeTool.id]: defineHandler(proposeTool, async (input, context) => {
    switch (input.kind) {
      case "due_date":
        return revised(context, await revisePacket(context, input.key, input.expectedRevision, (current) => withDueDate(current, input.dueDate)));
      case "scope":
        return revised(context, await revisePacket(context, input.key, input.expectedRevision, () => input.packet));
      case "reassign":
        return proposeReassignment(context, input.key, input.team);
      case "withdraw":
        return proposeWithdrawal(context, input.key);
      case "withdraw_proposal":
        return { proposal: await withdrawProposalFor(context, input.proposal) };
    }
  }),
};

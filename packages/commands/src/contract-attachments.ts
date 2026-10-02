import { attachContractChanges, isProposalAnswer, type Packet } from "@tiehall/catalog";
import { defineHandler, type Handlers } from "./execute.ts";
import { revisePacket } from "./packets.ts";
import { requestView } from "./request-views.ts";

// Attaching a contract diff to a request by hand (contract-changes: Attaching
// a contract diff to a request by hand; agent-access: OAuth scopes are coarse;
// handoff-packet: Packet changes that are commitments; design.md, Decisions
// this change rests on: D14, D23; D28 #3, #15, #77; D30 (3)). The classified
// diff becomes the contract section of the request's packet, through the same
// code as every packet change (packets.ts): the request's row locked, only
// the requester side, the expected revision named, or 428, and current, or
// 412, the packet's kind kept, and a proposal for a commitment, which a new
// contract section on a claimed request is, a change of its scope; otherwise
// the next revision is added at once, as the user's change. execute() has
// refused a token without contracts:report already. Nothing is routed: no
// other request is opened or updated, and no report is stored, whoever
// consumes the API, since routing reads only the reports of CI runs.

export const CONTRACT_ATTACHMENT_HANDLERS: Handlers = {
  [attachContractChanges.id]: defineHandler(attachContractChanges, async ({ key, expectedRevision, contract }, context) => {
    const answer = await revisePacket(context, key, expectedRevision, (current: Packet) => ({ ...current, untrusted: { ...current.untrusted, contract } }) as Packet);
    if (isProposalAnswer(answer)) return answer;
    return { request: await requestView(context, answer.request.id), packet: answer };
  }),
};

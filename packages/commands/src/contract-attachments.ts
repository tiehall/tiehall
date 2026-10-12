import { attachContractChanges, contractSection, isProposalAnswer, type ContractSection, type Packet } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { defineHandler, type Handlers } from "./execute.ts";
import { issuesOf } from "./input-issues.ts";
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
//
// A section attached by hand may name no provider pull request and no
// provider status, but a contract-change request's packet always names both
// (handoff-packet: Packet fields; decisions-from-groups-15-28, D55 (63)), so a
// section attached to one that leaves either out is refused with 400, before
// anything is added or proposed.

/** The packet with the attached contract section; 400 for a contract-change packet's section that names no provider pull request or status. */
function withContract(current: Packet, contract: ContractSection): Packet {
  if (current.kind === "contract_change") {
    const reported = contractSection.safeParse(contract);
    if (!reported.success) {
      throw new Refusal("invalid-input", "A contract-change request's packet names its provider pull request and its status, so a contract section attached to it names both.", {
        issues: issuesOf(reported.error).map(({ path, message }) => ({ path: ["contract", ...path], message })),
      });
    }
    return { ...current, untrusted: { ...current.untrusted, contract: reported.data } };
  }
  return { ...current, untrusted: { ...current.untrusted, contract } };
}

export const CONTRACT_ATTACHMENT_HANDLERS: Handlers = {
  [attachContractChanges.id]: defineHandler(attachContractChanges, async ({ key, expectedRevision, contract }, context) => {
    const answer = await revisePacket(context, key, expectedRevision, (current: Packet) => withContract(current, contract));
    if (isProposalAnswer(answer)) return answer;
    return { request: await requestView(context, answer.request.id), packet: answer };
  }),
};

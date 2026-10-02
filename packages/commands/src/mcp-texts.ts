import {
  attachContractChanges,
  claimRequest,
  createRequest,
  isProposalAnswer,
  linkPullRequest,
  listInbox,
  postMessage,
  proposeTool,
  readDirectory,
  readRequest,
  readUpdates,
  setRequestStatus,
  whoami,
} from "@tiehall/catalog";
import { proposalText, type ProposalJson } from "@tiehall/packet/proposals";
import type { AgentText } from "@tiehall/packet/render";
import {
  directoryText,
  inboxText,
  postedMessageText,
  pullRequestLinkText,
  requestPageText,
  requestText,
  revisedPacketText,
  updatesText,
  whoamiText,
  type DirectoryJson,
  type InboxJson,
  type LinkedPullRequestJson,
  type MessagePostJson,
  type Reader,
  type RequestJson,
  type RequestPageJson,
  type RevisedPacketJson,
  type UpdatesJson,
  type WhoamiJson,
} from "@tiehall/packet/tool-text";

// The markdown of each MCP tool's result (agent-surfaces: Tool results carry
// structured content and fenced markdown; agent-safety: Every string shown to
// agents has an origin; design.md, Technical decisions: T14). Every tool the
// catalog offers on MCP has a renderer here, by its operation's id, which
// turns the operation's output into texts with their origins for the one
// renderer; the MCP route refuses to start while a tool has none. A call that
// made a commitment answers with the proposal it created instead, which is
// Tiehall's own text wherever it is shown, and holds no confirm URL.

/** Turns an operation's output into the texts of its tool's markdown, for this reader. */
export type ToolText = (output: unknown, reader: Reader) => AgentText[];

/** The renderer of each tool's result, by its operation's id. */
export const TOOL_TEXTS: Readonly<Record<string, ToolText>> = {
  [createRequest.id]: (output, reader) => requestText(output as RequestJson, reader),
  [listInbox.id]: (output, reader) => inboxText(output as InboxJson, reader),
  [claimRequest.id]: (output, reader) => requestText(output as RequestJson, reader),
  [setRequestStatus.id]: (output, reader) => requestText(output as RequestJson, reader),
  [postMessage.id]: (output, reader) => postedMessageText(output as MessagePostJson, reader),
  [linkPullRequest.id]: (output, reader) => pullRequestLinkText(output as LinkedPullRequestJson, reader),
  [proposeTool.id]: (output, reader) => revisedPacketText(output as RevisedPacketJson, reader),
  [attachContractChanges.id]: (output, reader) => revisedPacketText(output as RevisedPacketJson, reader),
  [readRequest.id]: (output, reader) => requestPageText(output as RequestPageJson, reader),
  [whoami.id]: (output) => whoamiText(output as WhoamiJson),
  [readDirectory.id]: (output, reader) => directoryText(output as DirectoryJson, reader),
  [readUpdates.id]: (output, reader) => updatesText(output as UpdatesJson, reader),
};

/**
 * The texts of a retry after an elicitation (agent-surfaces: Retrying after an
 * elicitation): a line in Tiehall's words while the proposal waits, the
 * proposal, and, once the commitment took effect, the operation's output as it
 * is now through its renderer.
 */
export function retriedTexts(proposal: unknown, applied: { output: unknown; render: ToolText } | undefined, reader: Reader): AgentText[] {
  const view = proposal as ProposalJson;
  const waiting: AgentText[] =
    view.state === "pending"
      ? [{ origin: "tiehall", text: `Proposal ${view.id} is waiting for confirmation, so nothing has changed yet; a person confirms or rejects it in Tiehall's web UI.` }]
      : [];
  return [...waiting, { origin: "tiehall", text: proposalText(view) }, ...(applied === undefined ? [] : applied.render(applied.output, reader))];
}

/** The texts of a tool's result: the proposal a commitment created, or the operation's output through its renderer. */
export function toolTexts(render: ToolText, output: unknown, reader: Reader): AgentText[] {
  if (isProposalAnswer(output)) return [{ origin: "tiehall", text: proposalText(output.proposal as ProposalJson) }];
  return render(output, reader);
}

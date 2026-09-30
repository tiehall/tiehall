import {
  claimRequest,
  createRequest,
  isProposalAnswer,
  linkPullRequest,
  listInbox,
  postMessage,
  readDirectory,
  readRequest,
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
  whoamiText,
  type DirectoryJson,
  type InboxJson,
  type LinkedPullRequestJson,
  type MessagePostJson,
  type Reader,
  type RequestJson,
  type RequestPageJson,
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
  [readRequest.id]: (output, reader) => requestPageText(output as RequestPageJson, reader),
  [whoami.id]: (output) => whoamiText(output as WhoamiJson),
  [readDirectory.id]: (output, reader) => directoryText(output as DirectoryJson, reader),
};

/** The texts of a tool's result: the proposal a commitment created, or the operation's output through its renderer. */
export function toolTexts(render: ToolText, output: unknown, reader: Reader): AgentText[] {
  if (isProposalAnswer(output)) return [{ origin: "tiehall", text: proposalText(output.proposal as ProposalJson) }];
  return render(output, reader);
}

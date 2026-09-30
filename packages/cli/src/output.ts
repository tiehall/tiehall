import { proposalText, type ProposalJson } from "@tiehall/packet/proposals";
import { agentJson, createAgentView, type AgentText } from "@tiehall/packet/render";
import {
  inboxText,
  postedMessageText,
  pullRequestLinkText,
  requestPageText,
  requestText,
  revisedPacketText,
  updatesText,
  type InboxJson,
  type LinkedPullRequestJson,
  type MessagePostJson,
  type Reader,
  type RequestJson,
  type RequestPageJson,
  type RevisedPacketJson,
  type UpdatesJson,
} from "@tiehall/packet/tool-text";

// What the CLI prints (agent-surfaces: CLI request commands; agent-safety:
// Every string shown to agents has an origin; agent-safety: Content Tiehall
// did not generate is fenced as data; agent-safety: The confirm URL never
// reaches the model; design.md, Technical decisions: T14). By default each
// command prints its operation's answer as text, through the one renderer the
// MCP tools use: Tiehall's own words as they are, and every string Tiehall did
// not generate fenced with its origin as the user sees it, their own team's,
// another team's or external, from the teams the install says they belong
// to. A call that makes a commitment prints the proposal it became, in
// Tiehall's words, with the confirmations it needs, when it expires and whose
// web inbox it waits in, and no link: the confirm URL reaches people only
// through the web inbox, email and URL-mode elicitation. With --json, a
// command prints the install's JSON answer instead, as agents read it, in
// which user text sits under objects named `untrusted`. A refusal prints the
// problem the install answered with: its title and its detail, in Tiehall's
// words.

/** The texts of an operation's answer, for this reader. */
export type Render = (output: unknown, reader: Reader) => AgentText[];

/** The renderer of each operation a request command runs, by its id. */
export const RENDERERS: Readonly<Record<string, Render>> = {
  "requests.inbox": (output, reader) => inboxText(output as InboxJson, reader),
  "requests.read": (output, reader) => requestPageText(output as RequestPageJson, reader, "cli"),
  "requests.create": (output, reader) => requestText(output as RequestJson, reader),
  "requests.claim": (output, reader) => requestText(output as RequestJson, reader),
  "requests.set_status": (output, reader) => requestText(output as RequestJson, reader),
  "messages.post": (output, reader) => postedMessageText(output as MessagePostJson, reader),
  "requests.link_pr": (output, reader) => pullRequestLinkText(output as LinkedPullRequestJson, reader),
  "proposals.propose": (output, reader) => revisedPacketText(output as RevisedPacketJson, reader),
  "updates.read": (output, reader) => updatesText(output as UpdatesJson, reader, "cli"),
};

/** Whether an answer is the proposal a commitment became, or the proposal a withdrawal ended. */
function isProposalAnswer(output: unknown): output is { proposal: ProposalJson } {
  return typeof output === "object" && output !== null && !Array.isArray(output) && Object.hasOwn(output, "proposal");
}

/** An operation's answer as the CLI prints it: text for this reader, or JSON. */
export function answerText(operationId: string, output: unknown, reader: Reader | undefined): string {
  if (reader === undefined) return `${JSON.stringify(agentJson(output), null, 2)}\n`;
  if (isProposalAnswer(output)) return `${createAgentView().markdown([{ origin: "tiehall", text: proposalText(output.proposal) }])}\n`;
  const render = RENDERERS[operationId];
  if (render === undefined) throw new Error(`The CLI has no text for the answer of ${operationId}.`);
  return `${createAgentView().markdown(render(output, reader))}\n`;
}

/** An RFC 9457 problem, as the install answers a refusal. */
export interface Problem {
  type?: unknown;
  title?: unknown;
  status?: unknown;
  detail?: unknown;
  errors?: unknown;
}

/** Whether an answer's body is a problem the install wrote. */
export function isProblem(body: unknown): body is Problem {
  return typeof body === "object" && body !== null && typeof (body as Problem).title === "string" && typeof (body as Problem).detail === "string";
}

/** A refusal as the CLI prints it: its title and detail, and where the input fails its schema, in Tiehall's words. */
export function problemText(problem: Problem): string {
  const lines = [`${String(problem.title)}: ${String(problem.detail)}`];
  if (Array.isArray(problem.errors)) {
    for (const issue of problem.errors as { path?: unknown; message?: unknown }[]) {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(the input)";
      lines.push(`  ${path}: ${String(issue.message)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

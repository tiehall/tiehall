import { describe, expect, it } from "vitest";
import { OUTPUT_PATHS, plainCase } from "../../packet/test/support/output-paths.ts";
import { TOOL_TEXTS, toolTexts, type ToolText } from "../src/index.ts";

// Every MCP tool's result renders through a path of the fence suite
// (agent-safety: Content Tiehall did not generate is fenced as data;
// agent-surfaces: Tool results carry structured content and fenced markdown;
// design.md, Technical decisions: T14). The fence property tests run every
// output path of the renderer (packages/packet/test/output-path-fences.test.ts),
// and each tool's renderer is named here with the path it renders through:
// for that path's case, the tool's texts are the path's texts. A tool that
// renders without a path named here fails the check, so a new tool joins the
// suite before it ships; a commitment's answer renders as its proposal, the
// proposalText path.

/** The path of the fence suite each tool's result renders through, by the tool's operation id. */
const TOOL_PATHS: Readonly<Record<string, string>> = {
  "requests.create": "requestText",
  "requests.inbox": "inboxText",
  "requests.claim": "requestText",
  "requests.set_status": "requestText",
  "messages.post": "postedMessageText",
  "requests.link_pr": "pullRequestLinkText",
  "proposals.propose": "revisedPacketText",
  "contract.attach_changes": "revisedPacketText",
  "requests.read": "requestPageText, for MCP",
  "users.whoami": "whoamiText",
  "directory.get": "directoryText",
  "updates.read": "updatesText, for MCP",
};

/** Every way the tools' renderers stray from the suite, as a sentence; none when each renders through its path. */
function strays(renderers: Readonly<Record<string, ToolText>>): string[] {
  const problems: string[] = [];
  for (const id of Object.keys(renderers)) if (TOOL_PATHS[id] === undefined) problems.push(`${id} renders through no path of the fence suite.`);
  for (const [id, name] of Object.entries(TOOL_PATHS)) {
    const render = renderers[id];
    const path = OUTPUT_PATHS[name];
    if (render === undefined) problems.push(`${id} has no renderer, but the table names its path ${name}.`);
    else if (path === undefined) problems.push(`${id} names ${name}, which is no path of the fence suite.`);
    else {
      const { input, reader } = plainCase(path);
      if (JSON.stringify(render(input, reader)) !== JSON.stringify(path.render(input, reader))) problems.push(`${id} does not render as ${name} does.`);
    }
  }
  return problems;
}

describe("the MCP tools' results", () => {
  it("each render through the path of the fence suite named for it", () => {
    expect(strays(TOOL_TEXTS)).toEqual([]);
  });

  it("render a commitment's answer as its proposal, through the proposalText path", () => {
    const path = OUTPUT_PATHS["proposalText"];
    if (path === undefined) throw new Error("The suite has no proposalText path.");
    const { input, reader } = plainCase(path);
    for (const render of Object.values(TOOL_TEXTS)) expect(toolTexts(render, { proposal: input }, reader)).toEqual(path.render(input, reader));
  });

  it("fail the check for a tool that renders through no path, or not as its path does, as fixture renderers show", () => {
    expect(strays({ ...TOOL_TEXTS, "fixtures.read": () => [{ origin: "other team", text: "x" }] })).toEqual(["fixtures.read renders through no path of the fence suite."]);
    expect(strays({ ...TOOL_TEXTS, "users.whoami": () => [{ origin: "tiehall", text: "Someone else's words." }] })).toEqual(["users.whoami does not render as whoamiText does."]);
  });
});

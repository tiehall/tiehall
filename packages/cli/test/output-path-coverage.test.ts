import { describe, expect, it } from "vitest";
import { agentJson, createAgentView } from "@tiehall/packet/render";
import type { ContractDiffFailureJson, ContractDiffJson } from "@tiehall/packet/tool-text";
import { OUTPUT_PATHS, plainCase } from "../../packet/test/support/output-paths.ts";
import { answerText, contractDiffFailureOutput, contractDiffOutput, contractReportOutput, RENDERERS, type Render } from "../src/output.ts";

// Every CLI command's output renders through a path of the fence suite
// (agent-safety: Content Tiehall did not generate is fenced as data;
// agent-surfaces: CLI request commands; design.md, Technical decisions: T14).
// The fence property tests run every output path of the renderer
// (packages/packet/test/output-path-fences.test.ts), and each command's
// renderer is named here, by its operation, with the path it renders
// through: for that path's case, the command's texts are the path's texts. A
// command that renders without a path named here fails the check, so a new
// command joins the suite before it ships; a commitment's answer prints as its
// proposal, the proposalText path. tiehall contract diff runs no operation
// for what it prints: a diff the engine classified renders through the
// contractDiffText path, and one it could not make through
// contractDiffFailureText.

/** The path of the fence suite each command's output renders through, by its operation id. */
const COMMAND_PATHS: Readonly<Record<string, string>> = {
  "requests.inbox": "inboxText",
  "requests.read": "requestPageText, for the CLI",
  "requests.create": "requestText",
  "requests.claim": "requestText",
  "requests.set_status": "requestText",
  "messages.post": "postedMessageText",
  "requests.link_pr": "pullRequestLinkText",
  "proposals.propose": "revisedPacketText",
  "contract.attach_changes": "revisedPacketText",
  "updates.read": "updatesText, for the CLI",
  "contract.report": "contractReportText",
};

/** Every way the commands' renderers stray from the suite, as a sentence; none when each renders through its path. */
function strays(renderers: Readonly<Record<string, Render>>): string[] {
  const problems: string[] = [];
  for (const id of Object.keys(renderers)) if (COMMAND_PATHS[id] === undefined) problems.push(`${id} renders through no path of the fence suite.`);
  for (const [id, name] of Object.entries(COMMAND_PATHS)) {
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

/** An output with each fence's nonce left out, so two renderings of the same texts compare equal. */
const withoutNonces = (output: string) => output.replace(/tiehall-data-[0-9a-f]{32}/g, "tiehall-data-NONCE");

/** The ways tiehall contract diff's printers stray from their paths, as sentences; none when each prints as its path renders. */
function contractDiffStrays(printers: { diff: (diff: ContractDiffJson) => string; failure: (failure: ContractDiffFailureJson) => string }): string[] {
  const problems: string[] = [];
  for (const [name, print] of [
    ["contractDiffText", (input: unknown) => printers.diff(input as ContractDiffJson)],
    ["contractDiffFailureText", (input: unknown) => printers.failure(input as ContractDiffFailureJson)],
  ] as const) {
    const path = OUTPUT_PATHS[name];
    if (path === undefined) {
      problems.push(`${name} is no path of the fence suite.`);
      continue;
    }
    const { input, reader } = plainCase(path);
    if (withoutNonces(print(input)) !== withoutNonces(`${createAgentView().markdown(path.render(input, reader))}\n`)) problems.push(`contract diff does not print as ${name} renders.`);
  }
  return problems;
}

describe("the CLI's command output", () => {
  it("renders each command's answer through the path of the fence suite named for it", () => {
    expect(strays(RENDERERS)).toEqual([]);
  });

  it("prints a commitment's answer as its proposal, through the proposalText path", () => {
    const path = OUTPUT_PATHS["proposalText"];
    if (path === undefined) throw new Error("The suite has no proposalText path.");
    const { input, reader } = plainCase(path);
    const expected = `${createAgentView().markdown(path.render(input, reader))}\n`;
    for (const operationId of Object.keys(RENDERERS)) expect(answerText(operationId, { proposal: input }, reader)).toBe(expected);
  });

  it("prints tiehall contract diff's diff through the contractDiffText path, and a failing engine through contractDiffFailureText", () => {
    expect(contractDiffStrays({ diff: (diff) => contractDiffOutput(diff, false), failure: contractDiffFailureOutput })).toEqual([]);
  });

  it("prints tiehall contract report's answer, with what it reported, through the contractReportText path", () => {
    const path = OUTPUT_PATHS["contractReportText, with what the CLI reported"];
    if (path === undefined) throw new Error("The suite has no path for tiehall contract report's answer.");
    const { input, reader } = plainCase(path);
    const { report, reported } = input as { report: Parameters<typeof contractReportOutput>[0]; reported: Parameters<typeof contractReportOutput>[1] };
    expect(contractReportOutput(report, reported)).toBe(`${createAgentView().markdown(path.render(input, reader))}\n`);
  });

  it("prints its diff with --json under untrusted, as agents read JSON", () => {
    const path = OUTPUT_PATHS["contractDiffText"];
    if (path === undefined) throw new Error("The suite has no contractDiffText path.");
    const { input } = plainCase(path);
    expect(JSON.parse(contractDiffOutput(input as ContractDiffJson, true))).toEqual(agentJson({ untrusted: { contract: input } }));
  });

  it("fails the contract diff check for a printer that writes the document's text as its own, as a fixture printer shows", () => {
    const own = (texts: readonly { text: string }[]) => `${texts.map(({ text }) => text).join("\n")}\n`;
    expect(
      contractDiffStrays({
        diff: (diff) => own([{ text: `${diff.api} ${diff.changes.map(({ operation }) => operation).join(" ")}` }]),
        failure: contractDiffFailureOutput,
      }),
    ).toEqual(["contract diff does not print as contractDiffText renders."]);
  });

  it("fails the check for a command that renders through no path, or not as its path does, as fixture renderers show", () => {
    expect(strays({ ...RENDERERS, "fixtures.read": () => [{ origin: "other team", text: "x" }] })).toEqual(["fixtures.read renders through no path of the fence suite."]);
    expect(strays({ ...RENDERERS, "contract.report": () => [{ origin: "tiehall", text: "Someone else's words." }] })).toEqual(["contract.report does not render as contractReportText does."]);
  });
});

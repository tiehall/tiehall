import { z } from "zod";
import { defineCommand } from "./command.ts";
import { packet } from "./packet.ts";
import { packetRevision } from "./packets.ts";
import { request, requestKey } from "./requests.ts";
import { teamKey } from "./teams.ts";

// The propose tool (agent-surfaces: Commitment tools return proposals;
// agent-surfaces: The MCP tools; handoff-packet: Immutable, numbered
// revisions; handoff-packet: Packet changes that are commitments; design.md,
// Decisions this change rests on: D23; D28 #14, #15; D30 (2)). It makes the
// commitments no other tool makes, each a proposal that people confirm in the
// web UI, answered with { proposal }:
// - due_date sets, moves or removes the request's due date, as the next
//   revision of its packet, which is always a commitment after the request
//   was opened;
// - scope adds the next revision of its packet, which is a commitment while
//   the request is claimed, and otherwise is added at once;
// - reassign and withdraw, as requests.propose does on REST.
// It also withdraws a pending proposal of the caller's user, named by its id,
// answered with the proposal it ended.
//
// A packet change names the revision it expects in expectedRevision, where
// REST takes it from If-Match: none is refused as REST refuses a missing
// If-Match (428), and one that is no longer current as REST refuses a
// mismatched one (412), and neither creates a proposal (design.md, Where the
// specs leave room: the expected revision off REST). A change that is no
// commitment answers with the request and its packet as they are now.
//
// The variants are strict objects, so an input that mixes them fails the
// schema (agent-surfaces: Tool schemas that current clients accept). It is
// offered on MCP, and on REST for the CLI's `propose`, which runs it as the
// tool does (agent-surfaces: CLI request commands); on REST the expected
// revision comes from If-Match, never from the body. packets.add_revision and
// requests.propose make the same commitments on REST too.

const expectedRevision = z
  .number()
  .int()
  .min(1)
  .optional()
  .meta({ description: "The revision of the packet you expect to be current, as get_request shows it; a change that names none, or one that is no longer current, is refused." });

export const proposeTool = defineCommand({
  id: "proposals.propose",
  summary:
    "Propose a commitment that people confirm in the web UI: set, move or remove a request's due date, change its scope (its need, acceptance criteria or contract section) with the next revision of its packet, reassign it to another team, or withdraw it; or withdraw a pending proposal you proposed, by its id. A scope change before the request is claimed is added to the packet at once.",
  input: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("due_date").meta({ description: "What to propose or withdraw." }),
      key: requestKey,
      dueDate: z.iso.date().nullable().meta({ description: "The due date to propose, such as 2026-10-15, or null to remove the request's due date." }),
      expectedRevision,
    }),
    z.strictObject({
      kind: z.literal("scope"),
      key: requestKey,
      expectedRevision,
      packet,
    }),
    z.strictObject({
      kind: z.literal("reassign"),
      key: requestKey,
      team: teamKey.meta({ description: "The key of the team to reassign the request to, such as MOB." }),
    }),
    z.strictObject({ kind: z.literal("withdraw"), key: requestKey }),
    z.strictObject({
      kind: z.literal("withdraw_proposal"),
      proposal: z.uuid().meta({ description: "The id of a pending proposal you proposed, which ends without taking effect." }),
    }),
  ]),
  output: z.object({ request, packet: packetRevision }),
  method: "POST",
  path: "/api/v1/proposals",
  scopes: ["requests:write"],
  commitment: true,
  confirm: false,
  surfaces: ["rest", "mcp", "cli"],
  tool: "propose",
  cli: [{ command: "propose", arguments: ["kind", "key"] }],
  ifMatch: "expectedRevision",
  stability: "alpha",
});

export const PROPOSE_COMMANDS = [proposeTool];

import { CANCEL_REASONS, COMMITMENT_KINDS, PROPOSAL_STATES, SECOND_CONFIRMERS, SURFACES } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { packet } from "./packet.ts";
import { requestKey, requestRef, teamRef } from "./request-refs.ts";
import { user } from "./schemas.ts";

// Proposals as the operations return them (requests: Commitments become
// proposals; requests: What a proposal records and shows; public-api:
// Commitments over the API answer 202 with a proposal; design.md, Decisions
// this change rests on: D23). An operation flagged as a commitment answers a
// call that makes no commitment with its own output, and a call that makes one
// with the proposal it created instead, as `{ proposal }`: over REST with 202.
// So a commitment operation's own output never has a field named proposal,
// which the catalog checks. A proposal names its request, the kind of
// commitment and what it changes, where it is, its accountable human, who
// proposed it (the user, the actor kind and the surface, with the client under
// untrusted, since the client named itself), the confirmations it needs and
// those it has received, each with its user and time, when it was created and
// expires, and, once it ended, when and why it was cancelled. A proposed
// packet sits under untrusted, as every packet does. It holds no confirm URL:
// agents read it (requests: What a proposal records and shows).

/** The two steps of a proposal's confirmations: its accountable human's, then, where it needs one, the other side's. */
export const CONFIRMATION_STEPS = ["accountable_human", "other_side"] as const;

/** A confirmation a proposal needs. */
const neededConfirmation = z.object({
  step: z.enum(CONFIRMATION_STEPS),
  /** For the accountable human's step, that human; null for the other side's, whose person is decided when they confirm. */
  user: user.nullable(),
  /**
   * For the other side's step, the rules its person meets, all of them: a
   * member of the target team, the requesting user or a member of the
   * requesting team, or the claimant (a member of the target team once the
   * claimant is no longer a member of the install); none for the accountable
   * human's.
   */
  rules: z.array(z.enum(SECOND_CONFIRMERS)),
  /** For the other side's step, the team whose members may give it: the target team, or the requesting team. */
  team: teamRef.nullable(),
});

/** A confirmation a proposal has received: its step, who gave it and when. */
const receivedConfirmation = z.object({
  step: z.enum(CONFIRMATION_STEPS),
  user,
  confirmedAt: z.iso.datetime(),
});

/** A proposal as the operations return it. */
export const proposal = z.object({
  id: z.uuid(),
  request: requestRef,
  kind: z.enum(COMMITMENT_KINDS).meta({ description: "The kind of commitment it proposes." }),
  state: z.enum(PROPOSAL_STATES).meta({
    description: "pending while it waits for its confirmations; applied once it took effect; otherwise how it ended without taking effect.",
  }),
  /** The user who proposed it, whose confirmation it needs first. */
  accountableHuman: user,
  /** Who proposed it, as the server stamped it: the user, whether an agent or the web UI, and the surface. */
  proposedBy: z.object({
    user,
    actorKind: z.enum(["agent", "web_session", "integration"]),
    surface: z.enum(SURFACES).nullable(),
  }),
  /** What it changes: for a due date, the date it proposes, null to remove it; for a reassignment, the team. */
  change: z.object({
    dueDate: z.iso.date().nullable().optional(),
    team: teamRef.optional(),
  }),
  /** The confirmations it needs, in order, and those it has received. */
  confirmations: z.object({ needed: z.array(neededConfirmation), received: z.array(receivedConfirmation) }),
  createdAt: z.iso.datetime(),
  /** 7 days after it was created: every confirmation it needs comes before then, or it expires. */
  expiresAt: z.iso.datetime(),
  /** When it took effect or ended without taking effect; null while it is pending. */
  endedAt: z.iso.datetime().nullable(),
  /** Why it was cancelled: its request reached a terminal state or was reassigned, its accountable human was removed, or its base revision was overtaken. */
  cancelReason: z.enum(CANCEL_REASONS).nullable(),
  untrusted: z.object({
    /** The agent client that proposed it, as it named itself; null for the web UI and a personal access token. */
    client: z.string().nullable(),
    /** For a packet change, the packet it proposes, as its requester side wrote it. */
    packet: packet.nullable(),
  }),
});

/** What a commitment operation answers a call that makes a commitment with: the proposal it created. */
export const proposalAnswer = z.object({ proposal });

/** Whether an operation's answer is the proposal a commitment created, rather than the operation's own output. */
export function isProposalAnswer(output: unknown): output is z.input<typeof proposalAnswer> {
  return typeof output === "object" && output !== null && !Array.isArray(output) && Object.hasOwn(output, "proposal");
}

export const getProposal = defineCommand({
  id: "proposals.get",
  summary:
    "Read a proposal: what it proposes, who proposed it, the confirmations it needs and those it has received, when it expires, and how it ended. Every member can read every proposal.",
  input: z.object({ proposal: z.uuid().meta({ description: "The proposal's id." }) }),
  output: proposal,
  method: "GET",
  path: "/api/v1/proposals/{proposal}",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "beta",
});

export const listRequestProposals = defineCommand({
  id: "proposals.list",
  summary:
    "List a request's proposals, newest first, pending or ended, each as proposals.get returns it, for the web UI's page of the request. Every member can read every request's proposals.",
  input: z.object({ key: requestKey }),
  // The key is quoted, so the source-citation check does not take the name and its colon for a citation of the capability.
  output: z.object({ "proposals": z.array(proposal) }),
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const confirmProposal = defineCommand({
  id: "proposals.confirm",
  summary:
    "Confirm a proposal in the web UI, as its accountable human or, once that human has confirmed, as a person who may give the other side's confirmation; the last confirmation it needs applies the commitment.",
  input: z.object({ proposal: z.uuid().meta({ description: "The proposal's id." }) }),
  output: proposal,
  scopes: [],
  commitment: false,
  confirm: true,
  surfaces: [],
  stability: "alpha",
});

export const rejectProposal = defineCommand({
  id: "proposals.reject",
  summary:
    "Reject a pending proposal in the web UI, as its accountable human or, once that human has confirmed, as a person who may give the other side's confirmation; it ends without taking effect.",
  input: z.object({ proposal: z.uuid().meta({ description: "The proposal's id." }) }),
  output: proposal,
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const withdrawProposal = defineCommand({
  id: "proposals.withdraw",
  summary: "Withdraw a pending proposal you proposed, in the web UI; it ends without taking effect.",
  input: z.object({ proposal: z.uuid().meta({ description: "The proposal's id." }) }),
  output: proposal,
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const undoCommitment = defineCommand({
  id: "proposals.undo",
  summary:
    "Undo, in the web UI, a due date, a scope change, a reassignment or a decline you confirmed, within 15 minutes of when it took effect.",
  input: z.object({ proposal: z.uuid().meta({ description: "The id of the proposal whose commitment took effect." }) }),
  output: proposal,
  scopes: [],
  commitment: false,
  confirm: true,
  surfaces: [],
  stability: "alpha",
});

export const PROPOSAL_COMMANDS = [getProposal, listRequestProposals, confirmProposal, rejectProposal, withdrawProposal, undoCommitment];

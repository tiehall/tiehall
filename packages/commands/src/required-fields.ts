import type { IntakeField, Packet } from "@tiehall/catalog";
import { Refusal, type RefusalIssue } from "@tiehall/core";
import { teams } from "@tiehall/db";
import { requiredFieldsText } from "@tiehall/packet/tool-text";
import { and, eq } from "drizzle-orm";
import type { OrgContext } from "./with-org.ts";

// A team's required fields (agent-surfaces: Requests missing a team's required
// fields are refused; agent-surfaces: Admins set a team's intake notes and
// required fields; design.md, Decisions this change rests on: D28 #26;
// decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (41)). They hold when a request is opened to the team, when a
// reassignment into it is proposed, and when a revision of a request addressed
// to it is added or proposed:
// - a request that lacks one is not opened;
// - a reassignment into a team whose required fields the current packet lacks
//   is not proposed, since otherwise a team's requirement could be bypassed by
//   opening a request to another team and reassigning it;
// - a revision that drops a field its team requires, and the current revision
//   has, is neither added nor proposed; one that lacks a field the current
//   revision lacks too is taken, so a request opened before its team required
//   a field is not blocked by a rule it predates.
// An empty list, such as no acceptance criteria, counts as missing. Each is
// refused as input that fails the schema, with 400, naming each missing field
// in the order the team's intake page lists them, and creates nothing. The
// requests a contract report opens, and the revisions a report adds, are
// written by the system and never come here.

/** Where each field a team may require sits in a packet input, and whether a packet has it. */
export const REQUIRED_FIELD_CHECKS: Readonly<Record<IntakeField, { path: string[]; has: (packet: Packet) => boolean }>> = {
  acceptance_criteria: { path: ["packet", "untrusted", "acceptance_criteria"], has: (packet) => (packet.untrusted.acceptance_criteria?.length ?? 0) > 0 },
  code_refs: { path: ["packet", "untrusted", "code_refs"], has: (packet) => (packet.untrusted.code_refs?.length ?? 0) > 0 },
  links: { path: ["packet", "untrusted", "links"], has: (packet) => (packet.untrusted.links?.length ?? 0) > 0 },
  due_date: { path: ["packet", "due_date"], has: (packet) => packet.due_date !== undefined },
};

/** A team as its required fields name it: its id and its key. */
export interface RequiringTeam {
  id: string;
  key: string;
}

/** The fields a team requires, in the order its intake page lists them, read in the call's transaction. */
async function requiredFieldsOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, teamId: string): Promise<IntakeField[]> {
  const [row] = await tx
    .select({ requiredFields: teams.requiredFields })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.id, teamId)));
  return (row?.requiredFields ?? []) as IntakeField[];
}

/** The refusal of input that lacks these fields of a team, each named at its place in the input. */
function missingFields(team: RequiringTeam, missing: readonly IntakeField[], pathOf: (field: IntakeField) => string[], detail: string): Refusal {
  const issues: RefusalIssue[] = missing.map((field) => ({ path: pathOf(field), message: `Team ${team.key} requires ${requiredFieldsText([field])}.` }));
  return new Refusal("invalid-input", detail, { issues });
}

/** Refuses a packet that lacks a field the target team requires, as a request opened to it. */
export async function assertRequiredFields(context: Pick<OrgContext, "tx" | "orgId">, target: RequiringTeam, packet: Packet): Promise<void> {
  const missing = (await requiredFieldsOf(context, target.id)).filter((field) => !REQUIRED_FIELD_CHECKS[field].has(packet));
  if (missing.length === 0) return;
  throw missingFields(
    target,
    missing,
    (field) => REQUIRED_FIELD_CHECKS[field].path,
    `Team ${target.key} requires ${requiredFieldsText(missing)} of the requests opened to it, which this packet lacks, so nothing was opened.`,
  );
}

/** Refuses a reassignment into a team whose required fields the request's current packet lacks; the input names the team. */
export async function assertReassignable(context: Pick<OrgContext, "tx" | "orgId">, team: RequiringTeam, packet: Packet): Promise<void> {
  const missing = (await requiredFieldsOf(context, team.id)).filter((field) => !REQUIRED_FIELD_CHECKS[field].has(packet));
  if (missing.length === 0) return;
  throw missingFields(
    team,
    missing,
    () => ["team"],
    `Team ${team.key} requires ${requiredFieldsText(missing)} of the requests reassigned to it, which this request's packet lacks, so nothing was proposed.`,
  );
}

/**
 * Refuses a revision that drops a field its request's team requires and the
 * current revision has; `pathOf` names where the input sets each field.
 */
export async function assertRevisionKeepsRequiredFields(
  context: Pick<OrgContext, "tx" | "orgId">,
  team: RequiringTeam,
  current: Packet,
  next: Packet,
  pathOf: (field: IntakeField) => string[] = (field) => REQUIRED_FIELD_CHECKS[field].path,
): Promise<void> {
  const missing = (await requiredFieldsOf(context, team.id)).filter((field) => REQUIRED_FIELD_CHECKS[field].has(current) && !REQUIRED_FIELD_CHECKS[field].has(next));
  if (missing.length === 0) return;
  throw missingFields(
    team,
    missing,
    pathOf,
    `Team ${team.key} requires ${requiredFieldsText(missing)}, which the packet's current revision has and this revision drops, so nothing was added or proposed.`,
  );
}

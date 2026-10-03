// The text of a proposal that the MCP tools and the CLI print (public-api:
// Commitments over the API answer 202 with a proposal; agent-safety: The
// confirm URL never reaches the model; agent-surfaces: Commitment tools return
// proposals; requests: What a proposal records and shows). A call that makes
// a commitment gets back the proposal it created, as JSON, and an agent's
// tools and the CLI show it in Tiehall's own words: its id, what it proposes
// for which request, the confirmations it needs and those it has received,
// when it expires or how it ended, and, while it waits, whose web inbox it
// waits in, where a person confirms or rejects it; and, when the proposal
// says, what a due date or reassignment changes to and who proposed it,
// through which surface. It holds no link, so never
// the confirm URL, which reaches people only through the web inbox, email and
// URL-mode elicitation.
//
// Every value it prints is one whose form holds no text anyone wrote: ids,
// request and team keys, GitHub logins, dates and fixed values. A value
// without its form is refused, and the refusal never quotes it. It lives in
// this Apache-2.0 directory, next to the renderer, because the CLI prints it.

/** A user as a proposal names them. */
export interface ProposalUserJson {
  id: string;
  login: string;
  kind: string;
  bot: boolean;
}

/** A proposal as the API returns it: the parts the text shows. */
export interface ProposalJson {
  id: string;
  request: { id: string; key: string };
  kind: string;
  state: string;
  accountableHuman: ProposalUserJson;
  confirmations: {
    needed: { step: string; user: ProposalUserJson | null; rules: string[]; team: { id: string; key: string } | null }[];
    received: { step: string; user: ProposalUserJson; confirmedAt: string }[];
  };
  createdAt: string;
  expiresAt: string;
  /** Who proposed it: the user, whether an agent or the web UI, and the surface. */
  proposedBy?: { user: ProposalUserJson; actorKind: string; surface: string | null };
  /** What it changes: for a due date, the date it proposes, null to remove it; for a reassignment, the team. */
  change?: { dueDate?: string | null; team?: { id: string; key: string } };
  /** The agent client that proposed it, as it named itself, and a proposed packet: text Tiehall did not write, which proposalText leaves out. */
  untrusted?: { client: string | null; packet: unknown };
}

/** A proposal value without its form; the message never quotes the value. */
export class ProposalTextError extends TypeError {
  override name = "ProposalTextError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/;
const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What each kind of commitment proposes for a request, in Tiehall's words. */
const WHAT: Readonly<Record<string, (key: string) => string>> = {
  due_date: (key) => `change the due date of ${key}`,
  scope: (key) => `change the scope of ${key}: its need, acceptance criteria or contract section`,
  decline: (key) => `decline ${key}`,
  reassign: (key) => `reassign ${key} to another team`,
  withdraw: (key) => `withdraw ${key}`,
  done: (key) => `mark ${key} done`,
};

const STATES = ["pending", "applied", "rejected", "withdrawn", "expired", "cancelled"];
const STEPS = ["accountable_human", "other_side"];
const RULES = ["target_team", "requester_side", "claimant"];
const ACTOR_KINDS = ["agent", "web_session", "integration"];
const SURFACES = ["web", "mcp", "cli", "api", "github", "jira"];

function checked(value: unknown, form: RegExp, what: string): string {
  if (typeof value !== "string" || !form.test(value)) throw new ProposalTextError(`A proposal's ${what} does not have its form.`);
  return value;
}

function oneOf(value: unknown, values: readonly string[], what: string): string {
  if (typeof value !== "string" || !values.includes(value)) throw new ProposalTextError(`A proposal's ${what} is not one of its values.`);
  return value;
}

/** Who may give the other side's confirmation, for these rules, in Tiehall's words. */
function otherSide(rules: readonly string[], team: string | undefined, key: string): string {
  const members = team === undefined ? "a member of the request's team" : `a member of team ${team}`;
  const parts: string[] = [];
  if (rules.includes("target_team")) parts.push(members);
  if (rules.includes("requester_side")) parts.push(`the requesting user or ${members}`);
  if (rules.includes("claimant")) parts.push(`the claimant of ${key}`);
  const who = parts.length <= 1 ? (parts[0] ?? "the other side of the request") : `a person who is ${parts.join(" and ")}`;
  return rules.includes("claimant") ? `${who}, or ${members} once the claimant is no longer a member of the install` : who;
}

/** The proposal in Tiehall's own words, one sentence per line, with no link. */
export function proposalText(proposal: ProposalJson): string {
  const id = checked(proposal.id, UUID, "id");
  const key = checked(proposal.request?.key, REQUEST_KEY, "request key");
  const kind = oneOf(proposal.kind, Object.keys(WHAT), "kind");
  const state = oneOf(proposal.state, STATES, "state");
  const accountable = checked(proposal.accountableHuman?.login, LOGIN, "accountable human");
  const expiresAt = checked(proposal.expiresAt, DATE_TIME, "expiry");
  const needed = (proposal.confirmations?.needed ?? []).map((step) => ({
    step: oneOf(step.step, STEPS, "confirmation step"),
    login: step.user === null ? accountable : checked(step.user.login, LOGIN, "confirming user"),
    rules: step.rules.map((rule) => oneOf(rule, RULES, "confirmation rule")),
    team: step.team === null ? undefined : checked(step.team.key, TEAM_KEY, "team key"),
  }));
  const received = (proposal.confirmations?.received ?? []).map((confirmation) => ({
    step: oneOf(confirmation.step, STEPS, "confirmation step"),
    login: checked(confirmation.user?.login, LOGIN, "confirming user"),
    at: checked(confirmation.confirmedAt, DATE_TIME, "confirmation time"),
  }));

  const describe = (step: (typeof needed)[number]) =>
    step.step === "accountable_human" ? `${step.login}'s, its accountable human` : `one from ${otherSide(step.rules, step.team, key)}`;
  const [first, ...rest] = needed;
  const count = `${needed.length} confirmation${needed.length === 1 ? "" : "s"}`;
  const needs =
    first === undefined
      ? "It needs no confirmation."
      : rest.length === 0
        ? `It needs ${count}: ${describe(first)}.`
        : `It needs ${count}: first ${describe(first)}; then ${rest.map(describe).join("; then ")}.`;
  const has =
    received.length === 0
      ? "It has received none yet."
      : `It has received ${received.map(({ login, at }) => `${login}'s, at ${at}`).join(", and ")}.`;

  const lines = [`Proposal ${id}: ${WHAT[kind]?.(key) ?? kind}.${state === "pending" ? " It is pending." : ""}`];
  const change = proposal.change;
  if (kind === "due_date" && change?.dueDate !== undefined) {
    lines.push(change.dueDate === null ? `It proposes to remove the due date of ${key}.` : `It proposes the due date ${checked(change.dueDate, DATE, "due date")} for ${key}.`);
  }
  if (kind === "reassign" && change?.team !== undefined) lines.push(`It proposes to reassign ${key} to team ${checked(change.team.key, TEAM_KEY, "team key")}.`);
  if (proposal.proposedBy !== undefined) {
    const by = proposal.proposedBy;
    const login = checked(by.user?.login, LOGIN, "proposing user");
    const actorKind = oneOf(by.actorKind, ACTOR_KINDS, "proposer's kind");
    const through = by.surface === null ? "" : ` through ${oneOf(by.surface, SURFACES, "surface")}`;
    lines.push(`Proposed by ${login}${actorKind === "agent" ? "'s agent" : ""}${through} at ${checked(proposal.createdAt, DATE_TIME, "creation time")}.`);
  }
  lines.push(needs, has);
  if (state === "pending") {
    lines.push(`It expires at ${expiresAt}, unless every confirmation it needs has come by then.`);
    const where = received.some(({ step }) => step === "accountable_human")
      ? "the web inboxes of the people who may give the other side's confirmation"
      : `${accountable}'s web inbox`;
    lines.push(`It waits in ${where}: a person confirms or rejects it there, in Tiehall's web UI, not through an agent.`);
  } else if (state === "applied") {
    lines.push("It took effect.");
  } else {
    lines.push(`It ${state === "expired" ? "expired" : `was ${state}`}, so it will not take effect.`);
  }
  return lines.join("\n");
}

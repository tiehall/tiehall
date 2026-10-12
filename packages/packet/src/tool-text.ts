// What agents read of Tiehall's records, as markdown (agent-surfaces: Tool
// results carry structured content and fenced markdown; agent-safety: Every
// string shown to agents has an origin; agent-safety: Content Tiehall did not
// generate is fenced as data; agent-surfaces: Reading a request by key or URL,
// in pages; design.md, Technical decisions: T14). The MCP tools' results, and
// later the CLI's output and the markdown of request URLs, turn the JSON the
// operations return into texts for the one renderer (render.ts), each with its
// origin, so fencing is decided in one place. It lives in this Apache-2.0
// directory, beside the renderer, because the CLI renders with it too; the
// published @tiehall/packet leaves it out.
//
// Tiehall's own text states what Tiehall records: keys, states, teams, the
// GitHub logins of people, kinds and dates, each of a form that holds no
// space, so no text anyone wrote rides in it; a value that is not of its form
// is refused, and the refusal never quotes it. Everything people or other
// systems wrote is its own text, fenced with its origin as the reader sees it:
// the reader's own team's, when the team it was written for is one of the
// reader's; another team's; or external, for what no team wrote, such as a
// change GitHub or Jira reported, or a packet revision a contract report
// added. A system message is Tiehall's own text, written from its templates,
// and stays outside any fence.

import { proposalText, type ProposalJson } from "./proposals.ts";
import { agentJson, type AgentText, type FencedOrigin } from "./render.ts";

/** Who reads: the keys of the reader's teams, by which each text's origin is decided. */
export interface Reader {
  teams: readonly string[];
}

export interface TeamJson {
  id: string;
  key: string;
}

export interface UserJson {
  id: string;
  login: string;
  kind: string;
  bot: boolean;
}

/** A request as the operations return it. */
export interface RequestJson {
  id: string;
  key: string;
  state: string;
  targetTeam: TeamJson;
  requester: { user: UserJson | null; team: TeamJson };
  claimant: UserJson | null;
  createdAt: string;
  needsHuman: boolean;
  /** For a contract-change request, the provider change it follows; null or absent for any other request. */
  providerChange?: ProviderChangeJson | null;
  untrusted: { title: string };
}

/** The provider change a contract-change request follows, as the operations return it. */
export interface ProviderChangeJson {
  api: string;
  pullRequest: { repository: string; number: number; url: string };
  status: string;
  shippedAt: string | null;
}

/** What a page states about a message of the thread: all but its text. */
export interface MessageFactsJson {
  id: string;
  kind: string;
  blocking: boolean;
  questionId: string | null;
  answered: boolean | null;
  version: number;
  postedAt: string;
  editedAt: string | null;
  provenance: { actorKind: string; surface: string | null; user: UserJson | null; team: TeamJson | null };
}

/** One part of a page: the text of one packet field, or of one message, whole or in parts. */
export type PagePartJson =
  | { kind: "packet_field"; field: string; part: number; parts: number; team?: TeamJson | null; untrusted: { text: string } }
  | { kind: "message"; message: MessageFactsJson; part: number; parts: number; untrusted: { text: string; client: string | null } };

/** A page of a request, as get_request returns it. */
export interface RequestPageJson {
  request: RequestJson;
  packet: { revision: number; kind: string; dueDate: string | null; team: TeamJson | null };
  section: string;
  page: number;
  pages: number;
  next: { section: string; page: number } | null;
  parts: PagePartJson[];
}

/** A value that is not of its form; the message never quotes the value. */
export class ToolTextError extends TypeError {
  override name = "ToolTextError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/;
const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A registered API's name, such as payments-api. */
const API_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** A fixed value Tiehall writes, such as a state, a kind or a field's name: lower-case words joined by underscores. */
const WORD = /^[a-z][a-z_]{0,39}$/;

function checked(value: unknown, form: RegExp, what: string): string {
  if (typeof value !== "string" || !form.test(value)) throw new ToolTextError(`A ${what} does not have its form.`);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ToolTextError(`A ${what} is not a count.`);
  return value;
}

/** A user as Tiehall's text names them: their login, marked when an admin flagged them as a bot. */
function person(user: UserJson): string {
  const login = checked(user.login, LOGIN, "login");
  return user.bot === true ? `${login} (a bot user)` : login;
}

/** Where a text comes from, as the reader sees it: their own team's, another team's, or external for what no team wrote. */
export function originOf(team: { key: string } | null, reader: Reader): FencedOrigin {
  if (team === null) return "external";
  return reader.teams.includes(team.key) ? "same team" : "other team";
}

/** A request's state, teams, people and date, in Tiehall's words, and its title, fenced. */
export function requestText(request: RequestJson, reader: Reader): AgentText[] {
  const key = checked(request.key, REQUEST_KEY, "request key");
  const state = checked(request.state, WORD, "state");
  const target = checked(request.targetTeam.key, TEAM_KEY, "team key");
  const requestingTeam = checked(request.requester.team.key, TEAM_KEY, "team key");
  const at = checked(request.createdAt, DATE_TIME, "date");
  const requester = request.requester.user === null ? `team ${requestingTeam}` : `${person(request.requester.user)} for team ${requestingTeam}`;
  const lines = [
    `${key} is ${state}, addressed to team ${target}.`,
    `Requested by ${requester} at ${at}.`,
    request.claimant === null ? "Nobody has claimed it." : `Claimed by ${person(request.claimant)}.`,
  ];
  if (request.needsHuman === true) {
    lines.push(`${key} waits for a person (needs_human): agents' writes on it are refused until a member posts a message on it or confirms a proposal on it in the web UI.`);
  }
  const change = request.providerChange;
  if (change !== undefined && change !== null) lines.push(providerChangeLine(change));
  lines.push("Its title:");
  return [
    { origin: "tiehall", text: lines.join("\n") },
    { origin: originOf(request.requester.team, reader), text: request.untrusted.title },
  ];
}

/** The provider change a contract-change request follows, and what became of it, in Tiehall's words. */
export function providerChangeLine(change: ProviderChangeJson): string {
  const api = checked(change.api, API_NAME, "API name");
  const pr = `${checked(change.pullRequest.repository, REPOSITORY, "repository")}#${count(change.pullRequest.number, "pull request number")}`;
  const status = checked(change.status, WORD, "provider status");
  const what =
    status === "merged"
      ? `shipped: ${pr} merged at ${checked(change.shippedAt, DATE_TIME, "date")}`
      : status === "closed"
        ? `has not shipped: ${pr} closed without merging`
        : `has not shipped yet: ${pr} is open`;
  return `It follows the provider change to ${api} in ${pr}, which ${what}.`;
}

/** What a message is and who posted it, in Tiehall's words. */
function messageLine(message: MessageFactsJson, part: number, parts: number): string {
  const id = checked(message.id, UUID, "message id");
  const kind = checked(message.kind, WORD, "message kind");
  const what =
    kind === "question"
      ? `${message.blocking === true ? "a blocking question" : "a question"}, ${message.answered === true ? "answered" : "not answered yet"}`
      : kind === "answer"
        ? `an answer to question ${checked(message.questionId, UUID, "question id")}`
        : `a ${kind}`;
  const { provenance } = message;
  const actorKind = checked(provenance.actorKind, WORD, "actor kind");
  const by =
    actorKind === "system"
      ? "Tiehall"
      : provenance.user === null
        ? provenance.team === null
          ? actorKind
          : `team ${checked(provenance.team.key, TEAM_KEY, "team key")}`
        : `${person(provenance.user)}${provenance.team === null ? "" : ` for team ${checked(provenance.team.key, TEAM_KEY, "team key")}`}`;
  const through = provenance.surface === null ? "" : ` through ${checked(provenance.surface, WORD, "surface")}`;
  const posted = checked(message.postedAt, DATE_TIME, "date");
  const edited = message.editedAt === null ? "" : `, edited at ${checked(message.editedAt, DATE_TIME, "date")} (version ${count(message.version, "version")})`;
  const split = parts > 1 ? `, part ${part} of ${parts}` : "";
  return `Message ${id}: ${what}, posted by ${by}${through} at ${posted}${edited}${split}.`;
}

/** The origin of a message's text: Tiehall's own for a system message, external for one from GitHub or Jira, or its team's. */
function messageOrigin(message: MessageFactsJson, reader: Reader): AgentText["origin"] {
  if (message.provenance.actorKind === "system") return "tiehall";
  if (message.provenance.actorKind === "integration") return "external";
  return message.provenance.team === null ? "other team" : originOf(message.provenance.team, reader);
}

/**
 * A page of a request: where it sits among the pages, the request and its
 * packet revision in Tiehall's words, the title and each part, fenced with
 * their origins, and how to read the next page: with get_request, for a tool's
 * result, or with `tiehall get`, for the CLI's output.
 */
export function requestPageText(page: RequestPageJson, reader: Reader, surface: "mcp" | "cli" = "mcp"): AgentText[] {
  const key = checked(page.request.key, REQUEST_KEY, "request key");
  const section = checked(page.section, WORD, "section");
  const number = count(page.page, "page");
  const pages = count(page.pages, "page count");
  const of = section === "all" ? "" : ` of its ${section}`;
  const kind = checked(page.packet.kind, WORD, "packet kind");
  const due = page.packet.dueDate === null ? "with no due date" : `due ${checked(page.packet.dueDate, DATE, "due date")}`;
  const texts: AgentText[] = [
    { origin: "tiehall", text: `${key}, page ${number} of ${pages}${of}.` },
    ...requestText(page.request, reader),
    { origin: "tiehall", text: `Packet revision ${count(page.packet.revision, "revision")} of a ${kind.replace(/_/g, " ")}, ${due}.` },
  ];
  const packetOrigin = originOf(page.packet.team, reader);
  let heading: string | undefined;
  for (const part of page.parts) {
    const split = part.parts > 1 ? ` (part ${count(part.part, "part")} of ${count(part.parts, "part count")})` : "";
    if (part.kind === "packet_field") {
      if (heading !== "packet") texts.push({ origin: "tiehall", text: "The packet:" });
      heading = "packet";
      texts.push({ origin: "tiehall", text: `Its ${checked(part.field, WORD, "packet field")}${split}:` });
      // The field's own writer, which a page names for each field; a page that names none, the packet's.
      texts.push({ origin: part.team === undefined ? packetOrigin : originOf(part.team, reader), text: part.untrusted.text });
    } else {
      if (heading !== "thread") texts.push({ origin: "tiehall", text: "The thread:" });
      heading = "thread";
      texts.push({ origin: "tiehall", text: messageLine(part.message, count(part.part, "part"), count(part.parts, "part count")) });
      texts.push({ origin: messageOrigin(part.message, reader), text: part.untrusted.text });
    }
  }
  if (page.next === null) {
    texts.push({ origin: "tiehall", text: "This is the last page." });
  } else {
    const nextSection = checked(page.next.section, WORD, "section");
    texts.push({
      origin: "tiehall",
      text:
        surface === "cli"
          ? `For the rest, run tiehall get ${key} --section ${nextSection} --page ${count(page.next.page, "page")}.`
          : `For the rest, call get_request with request "${key}", section "${nextSection}" and page ${count(page.next.page, "page")}.`,
    });
  }
  return texts;
}

/** A request with its thread, oldest message first, and its pending proposals, oldest first, as the /api/v1 read and the JSON of its URL return it. */
export interface RequestWithThreadJson extends RequestJson {
  messages: (MessageFactsJson & { untrusted: { body: string; client: string | null } })[];
  pendingProposals: ProposalJson[];
}

/**
 * A request with its thread, as the markdown of its URL shows it: the same
 * data as its JSON. The request in Tiehall's words, its title fenced, then
 * each message, oldest first, with what it is and who posted it in Tiehall's
 * words and its latest text fenced with its origin; then each pending
 * proposal, by its id, in Tiehall's words, with the confirmations it needs
 * and has, when it expires and whose web inbox it waits in, and no link, so
 * never its confirm URL (agent-safety: The confirm URL never reaches the
 * model); and how to read the packet too, which the thread leaves out.
 */
export function requestWithThreadText(request: RequestWithThreadJson, reader: Reader): AgentText[] {
  const key = checked(request.key, REQUEST_KEY, "request key");
  const texts: AgentText[] = [...requestText(request, reader)];
  if (request.messages.length === 0) {
    texts.push({ origin: "tiehall", text: "Its thread has no message yet." });
  } else {
    texts.push({ origin: "tiehall", text: "The thread:" });
    for (const message of request.messages) {
      texts.push({ origin: "tiehall", text: messageLine(message, 1, 1) });
      texts.push({ origin: messageOrigin(message, reader), text: message.untrusted.body });
    }
  }
  if (request.pendingProposals.length === 0) {
    texts.push({ origin: "tiehall", text: "No proposal on it is pending." });
  } else {
    texts.push({ origin: "tiehall", text: "Its pending proposals, which people confirm or reject in Tiehall's web UI:" });
    for (const proposal of request.pendingProposals) texts.push(...pendingProposalTexts(proposal, originOf(request.requester.team, reader)));
  }
  texts.push({ origin: "tiehall", text: `For its packet too, run tiehall get ${key} or call get_request with request "${key}".` });
  return texts;
}

/** The fields of a packet, in the order its pages show them. */
const PACKET_FIELDS = ["need", "acceptance_criteria", "code_refs", "links", "contract", "extensions"] as const;

/**
 * A pending proposal, as much as its JSON holds: in Tiehall's words, then the
 * agent client that proposed it, as it named itself, fenced as external, and
 * the packet it proposes, its kind and due date in Tiehall's words and each
 * field fenced with the origin of the requester side, which wrote it.
 */
function pendingProposalTexts(proposal: ProposalJson, packetOrigin: FencedOrigin): AgentText[] {
  const texts: AgentText[] = [{ origin: "tiehall", text: proposalText(proposal) }];
  const client = proposal.untrusted?.client;
  if (typeof client === "string") {
    texts.push({ origin: "tiehall", text: "The agent client that proposed it, as it named itself:" }, { origin: "external", text: client });
  }
  const packet = proposal.untrusted?.packet as { kind?: unknown; due_date?: unknown; untrusted?: Record<string, unknown> } | null | undefined;
  if (packet !== null && packet !== undefined) {
    const kind = checked(packet.kind, WORD, "packet kind").replace(/_/g, " ");
    const due = packet.due_date === undefined || packet.due_date === null ? "with no due date" : `due ${checked(packet.due_date, DATE, "due date")}`;
    texts.push({ origin: "tiehall", text: `The packet it proposes, of a ${kind}, ${due}:` });
    const fields = packet.untrusted ?? {};
    for (const field of PACKET_FIELDS) {
      const value = fields[field];
      if (value === undefined) continue;
      // A field that is no text is its JSON, made from its value as agents read it, so no control character stays as an escape (D55 (36)).
      texts.push({ origin: "tiehall", text: `Its ${field}:` }, { origin: packetOrigin, text: typeof value === "string" ? value : JSON.stringify(agentJson(value), null, 2) });
    }
  }
  return texts;
}

/** A message as post_message returns it, with the text of its latest version. */
export interface PostedMessageJson extends MessageFactsJson {
  untrusted: { body: string; client: string | null };
}

/** What post_message returns: the message it posted and the request as it is now. */
export interface MessagePostJson {
  message: PostedMessageJson;
  request: RequestJson;
}

/**
 * A message just posted: which request it is on, what it is and who posted
 * it, in Tiehall's words, its text, fenced with its origin as the reader sees
 * it, and the request as it is now.
 */
export function postedMessageText(posted: MessagePostJson, reader: Reader): AgentText[] {
  const key = checked(posted.request.key, REQUEST_KEY, "request key");
  return [
    { origin: "tiehall", text: `Posted on ${key}. ${messageLine(posted.message, 1, 1)}` },
    { origin: messageOrigin(posted.message, reader), text: posted.message.untrusted.body },
    ...requestText(posted.request, reader),
  ];
}

/** A GitHub account's name, a user's or an organization's: letters, digits and hyphens, not starting with a hyphen. */
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
/** A repository's name: letters, digits, dots, hyphens and underscores, other than "." and "..". */
const NAME = "(?!\\.\\.?(?:/|$))[A-Za-z0-9\\._-]{1,100}";
/** A repository on GitHub.com, as owner/name, of GitHub's own form, which holds no space. */
const REPOSITORY = new RegExp(`^${OWNER}/${NAME}$`);
/** A pull request's URL on GitHub.com. */
const PULL_REQUEST_URL = new RegExp(`^https://github\\.com/${OWNER}/${NAME}/pull/[1-9][0-9]{0,8}$`);

/** A pull request linked to a request, as link_pr returns it. */
export interface PullRequestLinkJson {
  id: string;
  repository: string;
  number: number;
  url: string;
  linkedAt: string;
  linkedBy: UserJson | null;
}

/** What link_pr returns: the request as it is now and the pull request linked to it. */
export interface LinkedPullRequestJson {
  request: RequestJson;
  pullRequest: PullRequestLinkJson;
}

/** A linked pull request, in Tiehall's words: the pull request, the request, who linked it and when; then the request. */
export function pullRequestLinkText(linked: LinkedPullRequestJson, reader: Reader): AgentText[] {
  const key = checked(linked.request.key, REQUEST_KEY, "request key");
  const { pullRequest } = linked;
  const repository = checked(pullRequest.repository, REPOSITORY, "repository");
  const url = checked(pullRequest.url, PULL_REQUEST_URL, "pull request URL");
  const number = count(pullRequest.number, "pull request number");
  const at = checked(pullRequest.linkedAt, DATE_TIME, "date");
  const by = pullRequest.linkedBy === null ? "" : `, by ${person(pullRequest.linkedBy)}`;
  return [
    { origin: "tiehall", text: `Pull request ${repository}#${number} (${url}) is linked to ${key}${by} at ${at}.` },
    ...requestText(linked.request, reader),
  ];
}

/** What a packet change answers when it made no commitment: the request and its packet's revision as they are now. */
export interface RevisedPacketJson {
  request: RequestJson;
  packet: { request: { id: string; key: string }; revision: number; createdAt: string; packet: unknown };
}

/** A packet revised at once, in Tiehall's words: the revision it is at now and how to read it; then the request. */
export function revisedPacketText(revised: RevisedPacketJson, reader: Reader): AgentText[] {
  const key = checked(revised.request.key, REQUEST_KEY, "request key");
  const revision = count(revised.packet.revision, "revision");
  const at = checked(revised.packet.createdAt, DATE_TIME, "date");
  return [
    { origin: "tiehall", text: `The packet of ${key} is at revision ${revision} now, added at ${at}; get_request reads it.` },
    ...requestText(revised.request, reader),
  ];
}

/** What the install answers a contract report with, as `tiehall contract report` prints it: the report's id and the API it was taken for. */
export interface ContractReportJson {
  id: string;
  api: string;
}

/** What `tiehall contract report` reported, as it counts it: the pull request's number, the install it reported to, and the changes of each level. */
export interface ReportedChangesJson {
  pullRequest: number;
  install: string;
  changes: { ERR: number; WARN: number; INFO: number };
}

/** How many of something Tiehall states, such as the changes of a level a report holds: a whole number, none included, never a text. */
function howMany(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ToolTextError(`A ${what} is not a whole number.`);
  return value;
}

/**
 * A contract report the install took, in Tiehall's words: the API, by its
 * name, which holds no space, and the report's id; with what the CLI
 * reported, when it says, as `tiehall contract report` prints it: the pull
 * request's number, the install's URL and how many changes of each level.
 */
export function contractReportText(report: ContractReportJson, reported?: ReportedChangesJson): AgentText[] {
  const api = checked(report.api, API_NAME, "API name");
  const id = checked(report.id, UUID, "report id");
  if (reported === undefined) return [{ origin: "tiehall", text: `Tiehall took the contract report for ${api}, as report ${id}.` }];
  const number = count(reported.pullRequest, "pull request's number");
  const install = checked(reported.install, INSTALL_URL, "install URL");
  const levels = { ERR: howMany(reported.changes.ERR, "number of changes"), WARN: howMany(reported.changes.WARN, "number of changes"), INFO: howMany(reported.changes.INFO, "number of changes") };
  const total = levels.ERR + levels.WARN + levels.INFO;
  const summary =
    total === 0
      ? `Reported no classified change of ${api} in pull request #${number} to ${install}.`
      : `Reported ${total} classified change${total === 1 ? "" : "s"} of ${api} in pull request #${number} to ${install}: ${levels.ERR} breaking, ${levels.WARN} potentially breaking and ${levels.INFO} informational.`;
  return [{ origin: "tiehall", text: `${summary} Tiehall took it as report ${id}.` }];
}

/** The origin of an install, as TIEHALL_URL gives it: a scheme, a host and a port, and no path. */
const INSTALL_URL = /^https?:\/\/(?:[A-Za-z0-9\.-]+|\[[0-9A-Fa-f:\.]+\])(?::\d{1,5})?$/;

/** Who a connection acts for, as whoami returns it. */
export interface WhoamiJson {
  user: UserJson;
  teams: TeamJson[];
  install: { url: string };
  /** What the agent tells its user, such as that the skill it follows is older than the install supports. */
  warnings?: { kind: string; skillVersion: string; minimum: string }[];
}

/** A semantic version, such as 0.1.0 or 1.2.0-rc.1, which holds no space. */
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/** Who a connection acts for, the teams they belong to, and on which install, in Tiehall's words, and any warning, such as an old skill. */
export function whoamiText(whoami: WhoamiJson): AgentText[] {
  const url = checked(whoami.install.url, INSTALL_URL, "install URL");
  const keys = whoami.teams.map(({ key }) => checked(key, TEAM_KEY, "team key"));
  const teams = keys.length === 0 ? "no team" : `team${keys.length === 1 ? "" : "s"} ${listed(keys)}`;
  const texts: AgentText[] = [{ origin: "tiehall", text: `This connection acts for ${person(whoami.user)} on the Tiehall install at ${url}. They belong to ${teams}.` }];
  for (const warning of whoami.warnings ?? []) {
    if (warning.kind !== "skill_outdated") throw new ToolTextError("A warning is not of a kind Tiehall gives.");
    // The version the caller named is the caller's own text: the warning names only the install's minimum.
    const minimum = checked(warning.minimum, VERSION, "skill version");
    texts.push({
      origin: "tiehall",
      text: `The Tiehall skill you follow is older than the oldest version this install supports, ${minimum}: tell the user to update the Tiehall plugin, or the skill's folder in their client.`,
    });
  }
  return texts;
}

/** A commit's full sha: 40 or 64 lower-case hex digits. */
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The levels a diff engine's change has, as Tiehall names them. */
const CHANGE_LEVELS = ["ERR", "WARN", "INFO"] as const;

/** The contract section `tiehall contract diff` gives: the API and the refs as the developer named them, and the changes as the engine classified the document's. */
export interface ContractDiffJson {
  api: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  engine: { name: string; version: string };
  changes: { id: string; level: string; operation: string }[];
}

/** The engine and the two commits of a diff, in Tiehall's words. */
function engineAndCommits(engine: { name: string; version: string }, base: { sha: string }, head: { sha: string }) {
  return {
    engine: `${checked(engine.name, WORD, "diff engine")} ${checked(engine.version, VERSION, "diff engine version")}`,
    commits: `commits ${checked(base.sha, COMMIT_SHA, "commit").slice(0, 7)} and ${checked(head.sha, COMMIT_SHA, "commit").slice(0, 7)}`,
  };
}

/**
 * A diff `tiehall contract diff` classified, as it prints it: the engine, the
 * two commits and how many changes of each level, in Tiehall's words; then, in
 * one external text, the API and the refs as the developer named them and each
 * change, with its level, the engine's id and the operation it touches, as the
 * document gave them, since a contributor's pull request writes the document.
 */
export function contractDiffText(diff: ContractDiffJson): AgentText[] {
  const { engine, commits } = engineAndCommits(diff.engine, diff.base, diff.head);
  const levels = diff.changes.map(({ level }) => {
    if (!(CHANGE_LEVELS as readonly unknown[]).includes(level)) throw new ToolTextError("A change's level is not one Tiehall names.");
    return level;
  });
  const of = (level: (typeof CHANGE_LEVELS)[number]) => levels.filter((each) => each === level).length;
  const said =
    diff.changes.length === 0
      ? `${engine} classified no change between ${commits}. The API and the two refs, as you named them:`
      : `${engine} classified ${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"} between ${commits}: ${of("ERR")} breaking, ${of("WARN")} potentially breaking and ${of("INFO")} informational. The API, the two refs and each change, with its level, the engine's id and the operation it touches, as you named them and as the document gave them:`;
  const idWidth = Math.max(0, ...diff.changes.map(({ id }) => id.length));
  const section = [
    `API: ${diff.api}`,
    `Base: ${diff.base.ref}, at ${diff.base.sha.slice(0, 7)}`,
    `Head: ${diff.head.ref}, at ${diff.head.sha.slice(0, 7)}`,
    ...diff.changes.map(({ id, level, operation }) => `  ${level.padEnd(4)} ${id.padEnd(idWidth)}  ${operation}`),
  ];
  return [
    { origin: "tiehall", text: said },
    { origin: "external", text: section.join("\n") },
  ];
}

/** A diff engine that could not compare the document at two commits: the engine, the commits, and what it wrote on its standard error. */
export interface ContractDiffFailureJson {
  engine: { name: string; version: string };
  base: { sha: string };
  head: { sha: string };
  untrusted: { stderr: string };
}

/** A diff the engine could not make, in Tiehall's words, and what the engine wrote, as external text, since it can quote the document. */
export function contractDiffFailureText(failure: ContractDiffFailureJson): AgentText[] {
  const { engine, commits } = engineAndCommits(failure.engine, failure.base, failure.head);
  const stderr = failure.untrusted.stderr.trim();
  if (stderr === "") return [{ origin: "tiehall", text: `${engine} could not compare the document at ${commits}, and wrote nothing on its standard error.` }];
  return [
    { origin: "tiehall", text: `${engine} could not compare the document at ${commits}. What it wrote on its standard error:` },
    { origin: "external", text: stderr },
  ];
}

/** The install's teams and registered APIs, as directory returns them. */
export interface DirectoryJson {
  teams: {
    id: string;
    key: string;
    requiredFields?: readonly string[];
    /** The teams the admin who last wrote the intake notes belonged to then; null for notes from before Tiehall kept them; absent from an install that says nothing of it. */
    intakeNotesWrittenBy?: readonly TeamJson[] | null;
    untrusted: { name: string; intakeNotes?: string };
  }[];
  apis: { id: string; provider: TeamJson; consumers: TeamJson[]; untrusted: { name: string } }[];
}

/** "FE", "FE and QA", or "BE, FE and QA". */
function listed(keys: readonly string[]): string {
  return keys.length <= 2 ? keys.join(" and ") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1) ?? ""}`;
}

/** How Tiehall names each field a team may require in a packet (agent-surfaces: Admins set a team's intake notes and required fields). */
const REQUIRED_FIELD_WORDS: Readonly<Record<string, string>> = {
  acceptance_criteria: "the acceptance criteria",
  code_refs: "code refs",
  links: "links",
  due_date: "a due date",
};

/** The fields a team requires, in Tiehall's words, such as "the acceptance criteria and a due date"; a field Tiehall does not know is refused, never quoted. */
export function requiredFieldsText(fields: readonly string[]): string {
  return listed(
    fields.map((field) => {
      const words = Object.hasOwn(REQUIRED_FIELD_WORDS, field) ? REQUIRED_FIELD_WORDS[field] : undefined;
      if (words === undefined) throw new ToolTextError("A required field is not one a team may require.");
      return words;
    }),
  );
}

/** A team as its intake page gives it: its key, its name, its intake notes and the fields it requires. */
export type TeamIntakeJson = DirectoryJson["teams"][number];

/**
 * The origin of a team's intake notes as the reader sees them. Any admin
 * writes them, so they are the reader's own team's text only when the admin
 * who last wrote them belonged to one of the reader's teams then, and another
 * team's otherwise, as they are when Tiehall does not know who wrote them. An
 * install that says nothing of it fences them as the team's own text.
 */
function intakeNotesOrigin(team: TeamIntakeJson, reader: Reader): FencedOrigin {
  const writers = team.intakeNotesWrittenBy;
  if (writers === undefined) return originOf(team, reader);
  return writers !== null && writers.some(({ key }) => reader.teams.includes(key)) ? "same team" : "other team";
}

/**
 * A team's intake page, for agents (agent-surfaces: Team intake pages): the
 * team's key, its name and the notes in which it says how it wants requests
 * filed, fenced as the reader's own team's text or another team's, and the
 * fields it requires of the requests opened to it, in Tiehall's words.
 */
export function teamIntakeText(team: TeamIntakeJson, reader: Reader): AgentText[] {
  const key = checked(team.key, TEAM_KEY, "team key");
  const texts: AgentText[] = [
    { origin: "tiehall", text: `This is the intake page of team ${key}: how it wants requests filed, and the fields it requires.` },
    { origin: "tiehall", text: `Team ${key} is named:` },
    { origin: originOf(team, reader), text: team.untrusted.name },
  ];
  const notes = team.untrusted.intakeNotes ?? "";
  if (notes === "") texts.push({ origin: "tiehall", text: `Team ${key} gives no notes on how it wants requests filed.` });
  else texts.push({ origin: "tiehall", text: `Team ${key} says how it wants requests filed, as an admin wrote it:` }, { origin: intakeNotesOrigin(team, reader), text: notes });
  const required = team.requiredFields ?? [];
  texts.push({
    origin: "tiehall",
    text:
      required.length === 0
        ? `Team ${key} requires no field beyond the need, which every packet has.`
        : `Team ${key} requires ${requiredFieldsText(required)} of the requests opened to it.`,
  });
  return texts;
}

/**
 * The install's teams by their keys, each with its name, fenced as the
 * reader's own team's or another team's, with the intake notes an admin
 * wrote for it, which say how it wants requests filed, fenced the same way,
 * and the fields it requires, in Tiehall's words; and the registered APIs,
 * each with its provider team and the teams declared as its consumers, and
 * its name, fenced as its provider team's.
 */
export function directoryText(directory: DirectoryJson, reader: Reader): AgentText[] {
  const keys = directory.teams.map(({ key }) => checked(key, TEAM_KEY, "team key"));
  const texts: AgentText[] = [
    { origin: "tiehall", text: keys.length === 0 ? "The install has no team yet." : `The install has ${keys.length} team${keys.length === 1 ? "" : "s"}: ${listed(keys)}.` },
  ];
  for (const team of directory.teams) {
    const key = checked(team.key, TEAM_KEY, "team key");
    texts.push({ origin: "tiehall", text: `Team ${key} is named:` });
    texts.push({ origin: originOf(team, reader), text: team.untrusted.name });
    const notes = team.untrusted.intakeNotes ?? "";
    if (notes !== "") {
      texts.push({ origin: "tiehall", text: `Team ${key} says how it wants requests filed, as an admin wrote it:` });
      texts.push({ origin: intakeNotesOrigin(team, reader), text: notes });
    }
    const required = team.requiredFields ?? [];
    if (required.length > 0) texts.push({ origin: "tiehall", text: `Team ${key} requires ${requiredFieldsText(required)}.` });
  }
  if (directory.apis.length === 0) {
    texts.push({ origin: "tiehall", text: "No API is registered yet." });
  }
  for (const api of directory.apis) {
    const consumers = api.consumers.map(({ key }) => checked(key, TEAM_KEY, "team key"));
    const consumed =
      consumers.length === 0 ? "which no team consumes yet" : `which team${consumers.length === 1 ? "" : "s"} ${listed(consumers)} consume${consumers.length === 1 ? "s" : ""}`;
    texts.push({
      origin: "tiehall",
      text: `API ${checked(api.id, UUID, "API id")} of team ${checked(api.provider.key, TEAM_KEY, "team key")}, ${consumed}, is named:`,
    });
    texts.push({ origin: originOf(api.provider, reader), text: api.untrusted.name });
  }
  return texts;
}

/** The requests addressed to the reader's teams, as list_inbox returns them, newest first. */
export interface InboxJson {
  // The key is quoted, so the source-citation check does not take the name and its colon for a citation of the capability.
  "requests": RequestJson[];
}

/** Which of the reader's teams a list is for, and each request's summary, with its title fenced. */
export function inboxText(inbox: InboxJson, reader: Reader): AgentText[] {
  const teams = reader.teams.map((key) => checked(key, TEAM_KEY, "team key"));
  const yours = `your team${teams.length === 1 ? "" : "s"} ${listed(teams)}`;
  if (teams.length === 0) return [{ origin: "tiehall", text: "You belong to no team, so no request is addressed to you." }];
  const { "requests": requests } = inbox;
  if (requests.length === 0) return [{ origin: "tiehall", text: `No request is addressed to ${yours}.` }];
  const heading =
    requests.length === 1 ? `1 request is addressed to ${yours}.` : `${requests.length} requests are addressed to ${yours}, newest first.`;
  return [{ origin: "tiehall", text: heading }, ...requests.flatMap((request) => requestText(request, reader))];
}

/** The request an update is about, in Tiehall's own words, as the pull readers name it. */
export interface UpdateRequestJson {
  id: string;
  key: string;
  url: string;
  targetTeam: TeamJson;
}

/** An update: a domain event on a request in the reader's scope, as whats_new and `tiehall updates` return it. */
export interface UpdateJson {
  number: number;
  type: string;
  occurredAt: string;
  data: Readonly<Record<string, string | number | boolean>>;
  request: UpdateRequestJson;
}

/** A page of updates after the reader's cursor, and the requests they are about. */
export interface UpdatesJson {
  events: UpdateJson[];
  // The key is quoted, so the source-citation check does not take the name and its colon for a citation of the capability.
  "requests": RequestJson[];
  cursor: number;
  more: boolean;
}

/** An event's type, such as request.message_posted: dotted lower-case words. */
const EVENT_TYPE = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
/** A request's URL on the install: the install's URL, a slash and the key. */
const REQUEST_URL = new RegExp(`${INSTALL_URL.source.slice(0, -1)}/${REQUEST_KEY.source.slice(1)}`);

/** What each kind of commitment proposes to do to its request, in Tiehall's words. */
const COMMITMENTS: Readonly<Record<string, string>> = {
  due_date: "change its due date",
  scope: "change its scope",
  decline: "decline it",
  reassign: "reassign it to another team",
  withdraw: "withdraw it",
  done: "mark it done",
};

/** A whole number of an update's data, such as a revision; 0 is allowed where the form is a count from 0. */
function whole(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ToolTextError(`A ${what} is not a whole number.`);
  return value;
}

/**
 * What an update says, in Tiehall's words, from the ids and fixed values its
 * event carries; undefined for a type it does not know. For an agent, it names
 * the message or the proposal by its id, which the agent reads it by; for a
 * person in the web inbox, it leaves the ids out.
 */
export function updateDescription({ type, data }: Pick<UpdateJson, "type" | "data">, { ids = true }: { ids?: boolean } = {}): string | undefined {
  const id = (name: string) => checked(data[name], UUID, "id");
  const word = (name: string) => checked(data[name], WORD, name);
  /** The proposal the update is about: by its id for an agent, else as the proposal. */
  const proposal = (article: "a" | "the") => (ids ? `proposal ${id("proposalId")}` : `${article} proposal`);
  switch (type) {
    case "request.opened":
      return "it was opened";
    case "request.claimed":
      return "it was claimed";
    case "request.started":
      return "work on it started";
    case "request.released":
      return "its claim was released";
    case "request.message_posted": {
      const kind = data["kind"] === undefined ? undefined : word("kind");
      const what =
        kind === "question"
          ? data["blocking"] === true
            ? "a blocking question"
            : "a question"
          : kind === "answer"
            ? ids
              ? `an answer to question ${id("questionId")}`
              : "an answer"
            : kind === "comment"
              ? "a comment"
              : "a message";
      return ids ? `${what}, message ${id("messageId")}` : `${what} was posted`;
    }
    case "request.message_edited":
      return `${ids ? `message ${id("messageId")}` : "a message"} was edited, now at version ${count(data["version"], "version")}`;
    case "request.packet_revised":
      return `its packet is at revision ${count(data["revision"], "revision")}`;
    case "request.pull_request_linked":
      return "a pull request was linked to it";
    case "request.provider_change_shipped":
      return "the provider change it follows shipped: its provider pull request merged";
    case "request.tracker_changed": {
      const change = word("change");
      const what =
        change === "closed"
          ? `its mirror issue was closed in the tracker${data["reason"] === undefined ? "" : ` (${word("reason")})`}`
          : change === "reopened"
            ? "its mirror issue was reopened in the tracker"
            : change === "assignees_changed"
              ? "its mirror issue's assignees changed in the tracker"
              : undefined;
      if (what === undefined) throw new ToolTextError("A tracker's change is not one Tiehall records.");
      return `${what}, which changed nothing of the request`;
    }
    case "request.state_changed":
      return `it moved from ${word("previousState")} to ${word("state")}`;
    case "request.needs_human_flagged":
      return "it waits for a person (needs_human): agents' writes on it are refused until a member posts a message on it or confirms a proposal on it in the web UI";
    case "request.needs_human_cleared":
      return "a person cleared its needs_human flag";
    case "request.reassigned":
      return "it was reassigned to another team, which gave it a new key";
    case "proposal.created": {
      const kind = word("kind");
      const what = Object.hasOwn(COMMITMENTS, kind) ? COMMITMENTS[kind] : undefined;
      if (what === undefined) throw new ToolTextError("A proposal's kind is not one of the kinds of commitment.");
      return `${proposal("a")} to ${what} was made; it waits for confirmation in the web UI`;
    }
    case "proposal.confirmed": {
      const step = word("step");
      const applied = data["applied"] === true;
      if (step === "accountable_human") {
        return applied
          ? `${proposal("the")} was confirmed and took effect`
          : `${proposal("the")} was confirmed by its accountable human and waits for the other side's confirmation`;
      }
      if (step === "other_side") return `the other side confirmed ${proposal("the")}${applied ? ", which took effect" : ""}`;
      throw new ToolTextError("A confirmation's step is not one Tiehall records.");
    }
    case "proposal.undone":
      return `${proposal("the")} was undone`;
    case "proposal.ended": {
      const reason = data["reason"] === undefined ? "" : ` (${word("reason")})`;
      return `${proposal("the")} ended without taking effect: ${word("how")}${reason}`;
    }
    default:
      return undefined;
  }
}

/** One update, in Tiehall's words: its number, request, type, team, time, what it says and the request's URL. */
function updateLine(update: UpdateJson): string {
  const number = count(update.number, "update number");
  const key = checked(update.request.key, REQUEST_KEY, "request key");
  const type = checked(update.type, EVENT_TYPE, "event type");
  const team = checked(update.request.targetTeam.key, TEAM_KEY, "team key");
  const at = checked(update.occurredAt, DATE_TIME, "date");
  const url = checked(update.request.url, REQUEST_URL, "request URL");
  checked(update.data["requestId"], UUID, "request id");
  const detail = updateDescription(update);
  return `Update ${number}: ${key} ${type} (team ${team}), ${at}${detail === undefined ? "" : `: ${detail}`}. ${url}`;
}

/**
 * A page of updates, as whats_new and `tiehall updates` print it: how many
 * follow the reader's cursor and how to acknowledge them, with whats_new, for
 * a tool's result, or with `tiehall updates --acknowledge`, for the CLI's
 * output; each update in Tiehall's words; and the requests they are about,
 * each title fenced with its origin for the reader.
 */
export function updatesText(updates: UpdatesJson, reader: Reader, surface: "mcp" | "cli" = "mcp"): AgentText[] {
  const cursor = whole(updates.cursor, "cursor");
  if (updates.events.length === 0) return [{ origin: "tiehall", text: `No updates after your cursor ${cursor}.` }];
  const lines = updates.events.map(updateLine);
  const last = count(updates.events.at(-1)?.number, "update number");
  const acknowledge =
    surface === "cli"
      ? `Once you have handled them, run tiehall updates --acknowledge ${last}: until then, each run lists them again.`
      : `Once you have handled them, call whats_new with acknowledge ${last}: until then, each call returns them again.`;
  const heading = [
    `${updates.events.length === 1 ? "1 update" : `${updates.events.length} updates`} after your cursor ${cursor}, oldest first.`,
    ...(updates.more ? ["More updates wait after these; acknowledge these to read them."] : []),
    acknowledge,
  ].join(" ");
  const { "requests": requests } = updates;
  return [
    { origin: "tiehall", text: [heading, ...lines].join("\n") },
    ...(requests.length === 0 ? [] : [{ origin: "tiehall" as const, text: "The requests these updates are about:" }, ...requests.flatMap((request) => requestText(request, reader))]),
  ];
}

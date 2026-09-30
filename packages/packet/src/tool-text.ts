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

import type { AgentText, FencedOrigin } from "./render.ts";

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
  untrusted: { title: string };
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
  | { kind: "packet_field"; field: string; part: number; parts: number; untrusted: { text: string } }
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
    lines.push(`${key} waits for a person (needs_human): agents' writes on it are refused until a member posts a message on it in the web UI.`);
  }
  lines.push("Its title:");
  return [
    { origin: "tiehall", text: lines.join("\n") },
    { origin: originOf(request.requester.team, reader), text: request.untrusted.title },
  ];
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
      texts.push({ origin: packetOrigin, text: part.untrusted.text });
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

/** The origin of an install, as TIEHALL_URL gives it: a scheme, a host and a port, and no path. */
const INSTALL_URL = /^https?:\/\/(?:[A-Za-z0-9\.-]+|\[[0-9A-Fa-f:\.]+\])(?::\d{1,5})?$/;

/** Who a connection acts for, as whoami returns it. */
export interface WhoamiJson {
  user: UserJson;
  teams: TeamJson[];
  install: { url: string };
}

/** Who a connection acts for, the teams they belong to, and on which install, in Tiehall's words. */
export function whoamiText(whoami: WhoamiJson): AgentText[] {
  const url = checked(whoami.install.url, INSTALL_URL, "install URL");
  const keys = whoami.teams.map(({ key }) => checked(key, TEAM_KEY, "team key"));
  const teams = keys.length === 0 ? "no team" : `team${keys.length === 1 ? "" : "s"} ${listed(keys)}`;
  return [{ origin: "tiehall", text: `This connection acts for ${person(whoami.user)} on the Tiehall install at ${url}. They belong to ${teams}.` }];
}

/** The install's teams and registered APIs, as directory returns them. */
export interface DirectoryJson {
  teams: { id: string; key: string; untrusted: { name: string } }[];
  apis: { id: string; provider: TeamJson; consumers: TeamJson[]; untrusted: { name: string } }[];
}

/** "FE", "FE and QA", or "BE, FE and QA". */
function listed(keys: readonly string[]): string {
  return keys.length <= 2 ? keys.join(" and ") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1) ?? ""}`;
}

/**
 * The install's teams by their keys, each with its name, fenced as the
 * reader's own team's or another team's, and the registered APIs, each with
 * its provider team and the teams declared as its consumers, and its name,
 * fenced as its provider team's.
 */
export function directoryText(directory: DirectoryJson, reader: Reader): AgentText[] {
  const keys = directory.teams.map(({ key }) => checked(key, TEAM_KEY, "team key"));
  const texts: AgentText[] = [
    { origin: "tiehall", text: keys.length === 0 ? "The install has no team yet." : `The install has ${keys.length} team${keys.length === 1 ? "" : "s"}: ${listed(keys)}.` },
  ];
  for (const team of directory.teams) {
    texts.push({ origin: "tiehall", text: `Team ${checked(team.key, TEAM_KEY, "team key")} is named:` });
    texts.push({ origin: originOf(team, reader), text: team.untrusted.name });
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

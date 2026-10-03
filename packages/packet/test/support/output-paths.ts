import { proposalText, type ProposalJson } from "../../src/proposals.ts";
import type { AgentText, FencedOrigin } from "../../src/render.ts";
import {
  contractDiffFailureText,
  contractDiffText,
  contractReportText,
  directoryText,
  inboxText,
  postedMessageText,
  pullRequestLinkText,
  requestPageText,
  requestText,
  requestWithThreadText,
  revisedPacketText,
  teamIntakeText,
  updatesText,
  whoamiText,
  type ContractDiffFailureJson,
  type ContractDiffJson,
  type ContractReportJson,
  type ReportedChangesJson,
  type DirectoryJson,
  type InboxJson,
  type LinkedPullRequestJson,
  type MessageFactsJson,
  type MessagePostJson,
  type Reader,
  type RequestJson,
  type RequestPageJson,
  type RequestWithThreadJson,
  type RevisedPacketJson,
  type TeamIntakeJson,
  type UpdatesJson,
  type WhoamiJson,
} from "../../src/tool-text.ts";

// The output paths of the renderer (agent-safety: Every string shown to agents
// has an origin; agent-safety: Content Tiehall did not generate is fenced as
// data; design.md, Technical decisions: T14). Every surface that renders for
// agents (the MCP tools' results, the CLI's output, the markdown of request
// URLs and intake pages) turns what an operation returns into texts with
// their origins through one of the builders of tool-text.ts and proposals.ts,
// and the renderer writes them. Each path here is one of those builders, as a
// surface calls it, with a case it renders: the operation's JSON with a text
// people or other systems wrote in each place such a text goes, and the reader
// whose teams decide each text's origin. The fence property tests run every
// path (output-path-fences.test.ts), and the surfaces' own tests check that
// each tool, CLI command and page renders through a path of this table, so a
// path that is missing from the suite fails a test.

/** A text a case puts where people or other systems write, with the origin its reader sees it with. */
export interface FencedText {
  text: string;
  origin: FencedOrigin;
}

/** What a path renders: the operation's JSON and its reader, the texts Tiehall did not write, in the order they render, and texts it states as its own. */
export interface PathCase {
  input: unknown;
  reader: Reader;
  fenced: FencedText[];
  /** Texts the case puts into Tiehall's own text, such as a system message, which stay outside every fence. */
  own: string[];
}

export interface OutputPath {
  /** The export of tool-text.ts or proposals.ts that builds the path's texts. */
  builder: string;
  /** How many texts a case of the path takes. */
  texts: number;
  /** The path's texts for this JSON and reader, as the surfaces call the builder. */
  render(input: unknown, reader: Reader): AgentText[];
  /** A case of the path that holds these texts, as many as `texts` says. */
  build(texts: readonly string[]): PathCase;
  /** A case of the path that puts this text in a value Tiehall states, such as a key or a login, which the builder refuses. */
  misplace(text: string): { input: unknown; reader: Reader };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const FE = { id: uuid(0xfe), key: "FE" };
const QA = { id: uuid(0xa1), key: "QA" };
const SAM = { id: uuid(3), login: "sam-qa", kind: "human", bot: false };
const DANA = { id: uuid(4), login: "dana-fe", kind: "human", bot: false };
/** Dana of team FE reads: QA's text is another team's to them, FE's their own team's. */
const READER: Reader = { teams: ["FE"] };
const AT = "2026-10-01T09:00:00Z";

/** A request QA opened to FE, which Dana claimed, with this title. */
function request(title: string, key = "FE-142"): RequestJson {
  return {
    id: uuid(10),
    key,
    state: "claimed",
    targetTeam: FE,
    requester: { user: SAM, team: QA },
    claimant: DANA,
    createdAt: AT,
    needsHuman: false,
    providerChange: null,
    untrusted: { title },
  };
}

/** What a page states of a message: who posted it, through which surface, for which team. */
function facts(n: number, actorKind: string, surface: string | null, user: typeof SAM | null, team: typeof FE | null): MessageFactsJson {
  return { id: uuid(100 + n), kind: "comment", blocking: false, questionId: null, answered: null, version: 1, postedAt: AT, editedAt: null, provenance: { actorKind, surface, user, team } };
}

/** The texts a case takes, by position; a case is built only with as many as its path says. */
function at(texts: readonly string[], index: number): string {
  const text = texts[index];
  if (text === undefined) throw new Error(`The case takes a text at ${index}.`);
  return text;
}

const other = (text: string): FencedText => ({ text, origin: "other team" });
const same = (text: string): FencedText => ({ text, origin: "same team" });

function requestPage(texts: readonly string[]): RequestPageJson {
  return {
    request: request(at(texts, 0)),
    packet: { revision: 2, kind: "request", dueDate: null, team: QA },
    section: "all",
    page: 1,
    pages: 2,
    next: { section: "thread", page: 2 },
    parts: [
      { kind: "packet_field", field: "need", part: 1, parts: 1, untrusted: { text: at(texts, 1) } },
      { kind: "message", message: facts(1, "web_session", "web", DANA, FE), part: 1, parts: 2, untrusted: { text: at(texts, 2), client: null } },
      { kind: "message", message: facts(2, "integration", "github", null, null), part: 1, parts: 1, untrusted: { text: at(texts, 3), client: null } },
      { kind: "message", message: facts(3, "system", null, null, null), part: 1, parts: 1, untrusted: { text: at(texts, 4), client: null } },
    ],
  };
}

function updates(title: string, key = "FE-142"): UpdatesJson {
  return {
    events: [
      {
        number: 7,
        type: "request.message_posted",
        occurredAt: AT,
        data: { requestId: uuid(10), kind: "comment", messageId: uuid(101) },
        request: { id: uuid(10), key, url: `https://tiehall.example.com/${key}`, targetTeam: FE },
      },
    ],
    "requests": [request(title, key)],
    cursor: 6,
    more: false,
  };
}

function proposal(login: string): ProposalJson {
  return {
    id: uuid(200),
    request: { id: uuid(10), key: "FE-142" },
    kind: "decline",
    state: "pending",
    accountableHuman: { ...DANA, login },
    confirmations: { needed: [{ step: "accountable_human", user: null, rules: [], team: null }], received: [] },
    createdAt: AT,
    expiresAt: "2026-10-08T09:00:00Z",
  };
}

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

/** A diff of tiehall contract diff with this API, these refs, and one change with this id and operation. */
function contractDiff(api: string, baseRef: string, headRef: string, id: string, operation: string, version = "1.32.1"): ContractDiffJson {
  return {
    api,
    base: { ref: baseRef, sha: BASE_SHA },
    head: { ref: headRef, sha: HEAD_SHA },
    engine: { name: "oasdiff", version },
    changes: [{ id, level: "ERR", operation }],
  };
}

/** A diff the engine could not make, with what it wrote on its standard error. */
function contractDiffFailure(stderr: string, version = "1.32.1"): ContractDiffFailureJson {
  return { engine: { name: "oasdiff", version }, base: { sha: BASE_SHA }, head: { sha: HEAD_SHA }, untrusted: { stderr } };
}

function intake(name: string, notes: string): TeamIntakeJson {
  return { id: FE.id, key: "FE", requiredFields: ["acceptance_criteria"], untrusted: { name, intakeNotes: notes } };
}

/** Every output path of the renderer, by name: a builder, and for a builder a surface calls in two ways, each way. */
export const OUTPUT_PATHS: Readonly<Record<string, OutputPath>> = {
  requestText: {
    builder: "requestText",
    texts: 1,
    render: (input, reader) => requestText(input as RequestJson, reader),
    build: (texts) => ({ input: request(at(texts, 0)), reader: READER, fenced: [other(at(texts, 0))], own: [] }),
    misplace: (text) => ({ input: request("A title", text), reader: READER }),
  },
  "requestPageText, for MCP": {
    builder: "requestPageText",
    texts: 5,
    render: (input, reader) => requestPageText(input as RequestPageJson, reader, "mcp"),
    build: (texts) => ({
      input: requestPage(texts),
      reader: READER,
      fenced: [other(at(texts, 0)), other(at(texts, 1)), same(at(texts, 2)), { text: at(texts, 3), origin: "external" }],
      own: [at(texts, 4)],
    }),
    misplace: (text) => ({ input: { ...requestPage(["a", "b", "c", "d", "e"]), section: text }, reader: READER }),
  },
  "requestPageText, for the CLI": {
    builder: "requestPageText",
    texts: 5,
    render: (input, reader) => requestPageText(input as RequestPageJson, reader, "cli"),
    build: (texts) => ({
      input: requestPage(texts),
      reader: READER,
      fenced: [other(at(texts, 0)), other(at(texts, 1)), same(at(texts, 2)), { text: at(texts, 3), origin: "external" }],
      own: [at(texts, 4)],
    }),
    misplace: (text) => ({ input: { ...requestPage(["a", "b", "c", "d", "e"]), packet: { revision: 2, kind: text, dueDate: null, team: QA } }, reader: READER }),
  },
  requestWithThreadText: {
    builder: "requestWithThreadText",
    texts: 5,
    render: (input, reader) => requestWithThreadText(input as RequestWithThreadJson, reader),
    build: (texts) => ({
      input: {
        ...request(at(texts, 0)),
        messages: [
          { ...facts(1, "web_session", "web", DANA, FE), untrusted: { body: at(texts, 1), client: null } },
          { ...facts(2, "agent", "mcp", SAM, QA), untrusted: { body: at(texts, 2), client: "agent-1" } },
        ],
        // A pending proposal is stated in Tiehall's own words; the client that proposed it named itself, and the
        // packet it proposes is its requester side's, QA's.
        pendingProposals: [
          proposal(DANA.login),
          { ...proposal(SAM.login), kind: "scope", untrusted: { client: at(texts, 3), packet: { schema_version: "1-beta", kind: "request", untrusted: { need: at(texts, 4) } } } },
        ],
      } satisfies RequestWithThreadJson,
      reader: READER,
      fenced: [other(at(texts, 0)), same(at(texts, 1)), other(at(texts, 2)), { text: at(texts, 3), origin: "external" }, other(at(texts, 4))],
      own: [],
    }),
    misplace: (text) => ({
      input: { ...request("A title"), messages: [{ ...facts(1, text, "web", DANA, FE), untrusted: { body: "b", client: null } }], pendingProposals: [] },
      reader: READER,
    }),
  },
  postedMessageText: {
    builder: "postedMessageText",
    texts: 2,
    render: (input, reader) => postedMessageText(input as MessagePostJson, reader),
    build: (texts) => ({
      input: { message: { ...facts(1, "agent", "mcp", SAM, QA), untrusted: { body: at(texts, 0), client: "agent-1" } }, request: request(at(texts, 1)) } satisfies MessagePostJson,
      reader: READER,
      fenced: [other(at(texts, 0)), other(at(texts, 1))],
      own: [],
    }),
    misplace: (text) => ({ input: { message: { ...facts(1, "agent", "mcp", { ...SAM, login: text }, QA), untrusted: { body: "b", client: null } }, request: request("A title") }, reader: READER }),
  },
  pullRequestLinkText: {
    builder: "pullRequestLinkText",
    texts: 1,
    render: (input, reader) => pullRequestLinkText(input as LinkedPullRequestJson, reader),
    build: (texts) => ({
      input: {
        request: request(at(texts, 0)),
        pullRequest: { id: uuid(300), repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7", linkedAt: AT, linkedBy: DANA },
      } satisfies LinkedPullRequestJson,
      reader: READER,
      fenced: [other(at(texts, 0))],
      own: [],
    }),
    misplace: (text) => ({
      input: { request: request("A title"), pullRequest: { id: uuid(300), repository: text, number: 7, url: "https://github.com/acme/web/pull/7", linkedAt: AT, linkedBy: DANA } },
      reader: READER,
    }),
  },
  revisedPacketText: {
    builder: "revisedPacketText",
    texts: 1,
    render: (input, reader) => revisedPacketText(input as RevisedPacketJson, reader),
    build: (texts) => ({
      input: { request: request(at(texts, 0)), packet: { request: { id: uuid(10), key: "FE-142" }, revision: 3, createdAt: AT, packet: {} } } satisfies RevisedPacketJson,
      reader: READER,
      fenced: [other(at(texts, 0))],
      own: [],
    }),
    misplace: (text) => ({ input: { request: request("A title"), packet: { request: { id: uuid(10), key: "FE-142" }, revision: 3, createdAt: text, packet: {} } }, reader: READER }),
  },
  whoamiText: {
    builder: "whoamiText",
    texts: 0,
    render: (input) => whoamiText(input as WhoamiJson),
    build: () => ({ input: { user: DANA, teams: [FE], install: { url: "https://tiehall.example.com" } } satisfies WhoamiJson, reader: READER, fenced: [], own: [] }),
    misplace: (text) => ({ input: { user: DANA, teams: [FE], install: { url: text } }, reader: READER }),
  },
  teamIntakeText: {
    builder: "teamIntakeText",
    texts: 2,
    render: (input, reader) => teamIntakeText(input as TeamIntakeJson, reader),
    build: (texts) => ({ input: intake(at(texts, 0), at(texts, 1)), reader: READER, fenced: [same(at(texts, 0)), same(at(texts, 1))], own: [] }),
    misplace: (text) => ({ input: { ...intake("FE", "notes"), key: text }, reader: READER }),
  },
  directoryText: {
    builder: "directoryText",
    texts: 5,
    render: (input, reader) => directoryText(input as DirectoryJson, reader),
    build: (texts) => ({
      input: {
        teams: [
          { id: FE.id, key: "FE", requiredFields: ["due_date"], untrusted: { name: at(texts, 0), intakeNotes: at(texts, 1) } },
          { id: QA.id, key: "QA", untrusted: { name: at(texts, 2), intakeNotes: at(texts, 3) } },
        ],
        apis: [{ id: uuid(400), provider: QA, consumers: [FE], untrusted: { name: at(texts, 4) } }],
      } satisfies DirectoryJson,
      reader: READER,
      fenced: [same(at(texts, 0)), same(at(texts, 1)), other(at(texts, 2)), other(at(texts, 3)), other(at(texts, 4))],
      own: [],
    }),
    misplace: (text) => ({ input: { teams: [{ id: FE.id, key: "FE", requiredFields: [text], untrusted: { name: "FE" } }], apis: [] }, reader: READER }),
  },
  inboxText: {
    builder: "inboxText",
    texts: 2,
    render: (input, reader) => inboxText(input as InboxJson, reader),
    build: (texts) => ({ input: { "requests": [request(at(texts, 0), "FE-143"), request(at(texts, 1))] } satisfies InboxJson, reader: READER, fenced: [other(at(texts, 0)), other(at(texts, 1))], own: [] }),
    misplace: (text) => ({ input: { "requests": [{ ...request("A title"), state: text }] }, reader: READER }),
  },
  "updatesText, for MCP": {
    builder: "updatesText",
    texts: 1,
    render: (input, reader) => updatesText(input as UpdatesJson, reader, "mcp"),
    build: (texts) => ({ input: updates(at(texts, 0)), reader: READER, fenced: [other(at(texts, 0))], own: [] }),
    misplace: (text) => ({ input: { ...updates("A title"), events: updates("A title").events.map((event) => ({ ...event, type: text })) }, reader: READER }),
  },
  "updatesText, for the CLI": {
    builder: "updatesText",
    texts: 1,
    render: (input, reader) => updatesText(input as UpdatesJson, reader, "cli"),
    build: (texts) => ({ input: updates(at(texts, 0)), reader: READER, fenced: [other(at(texts, 0))], own: [] }),
    misplace: (text) => ({ input: { ...updates("A title"), events: updates("A title").events.map((event) => ({ ...event, request: { ...event.request, url: text } })) }, reader: READER }),
  },
  proposalText: {
    builder: "proposalText",
    texts: 0,
    render: (input) => [{ origin: "tiehall", text: proposalText(input as ProposalJson) }],
    build: () => ({ input: proposal(DANA.login), reader: READER, fenced: [], own: [] }),
    misplace: (text) => ({ input: proposal(text), reader: READER }),
  },
  contractDiffText: {
    builder: "contractDiffText",
    texts: 5,
    render: (input) => contractDiffText(input as ContractDiffJson),
    build: (texts) => ({
      input: contractDiff(at(texts, 0), at(texts, 1), at(texts, 2), at(texts, 3), at(texts, 4)),
      reader: READER,
      // The API, the refs and the change are one external text: the section as the developer named it and the document gave it.
      fenced: [
        {
          text: `API: ${at(texts, 0)}\nBase: ${at(texts, 1)}, at ${BASE_SHA.slice(0, 7)}\nHead: ${at(texts, 2)}, at ${HEAD_SHA.slice(0, 7)}\n  ERR  ${at(texts, 3)}  ${at(texts, 4)}`,
          origin: "external",
        },
      ],
      own: [],
    }),
    misplace: (text) => ({ input: contractDiff("payments-api", "main", "change", "endpoint-removed", "GET /payments", text), reader: READER }),
  },
  contractDiffFailureText: {
    builder: "contractDiffFailureText",
    texts: 1,
    render: (input) => contractDiffFailureText(input as ContractDiffFailureJson),
    build: (texts) => ({
      input: contractDiffFailure(at(texts, 0)),
      reader: READER,
      // What the engine wrote, without the white space around it; nothing is fenced when that is all it wrote.
      fenced: at(texts, 0).trim() === "" ? [] : [{ text: at(texts, 0).trim(), origin: "external" }],
      own: [],
    }),
    misplace: (text) => ({ input: contractDiffFailure("it failed", text), reader: READER }),
  },
  contractReportText: {
    builder: "contractReportText",
    texts: 0,
    render: (input) => contractReportText(input as ContractReportJson),
    build: () => ({ input: { id: uuid(500), api: "payments-api" } satisfies ContractReportJson, reader: READER, fenced: [], own: [] }),
    misplace: (text) => ({ input: { id: uuid(500), api: text }, reader: READER }),
  },
  // What `tiehall contract report` prints: the install's answer with what the CLI reported, all of it values of a form
  // Tiehall checks (the API's name, the pull request's number, the install's URL and the counts of each level).
  "contractReportText, with what the CLI reported": {
    builder: "contractReportText",
    texts: 0,
    render: (input) => {
      const { report, reported } = input as { report: ContractReportJson; reported: ReportedChangesJson };
      return contractReportText(report, reported);
    },
    build: () => ({
      input: { report: { id: uuid(501), api: "payments-api" }, reported: { pullRequest: 310, install: "https://tiehall.example.com", changes: { ERR: 2, WARN: 1, INFO: 2 } } },
      reader: READER,
      fenced: [],
      own: [],
    }),
    misplace: (text) => ({
      input: { report: { id: uuid(501), api: "payments-api" }, reported: { pullRequest: 310, install: text, changes: { ERR: 2, WARN: 1, INFO: 2 } } },
      reader: READER,
    }),
  },
};

/**
 * The builders' exports that are no path of their own: each gives a phrase or
 * a line that paths put into Tiehall's own text, from values of a form that
 * holds no text anyone wrote.
 */
export const PHRASE_BUILDERS: Readonly<Record<string, string>> = {
  requiredFieldsText: "the fields a team requires, in Tiehall's words, which teamIntakeText and directoryText state",
};

/** A case of each path with plain texts, for the surfaces' tests that compare a surface's texts with its path's. */
export function plainCase(path: OutputPath): PathCase {
  return path.build(Array.from({ length: path.texts }, (_, index) => `Text ${index + 1} that people wrote.`));
}

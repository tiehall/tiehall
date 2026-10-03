import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentTokenCheck, createRequestUrlRoute, readInstallations, type CiCaller, type RequestUrlRoute } from "../src/index.ts";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { signedInCli, type CliMachine } from "./support/cli.ts";
import { scanUrlAnswer } from "./support/confirm-url-scan.ts";
import { reportOf, runDueUpdates } from "./support/contract.ts";
import { CORPUS, expectFenced, expectStrippedJson, fencesOf, fitted, invisibleIn, unescapeMarkers, visible, type CorpusEntry, type Fence } from "./support/corpus.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, mcpPerson, MODERN, textOf, type McpPerson } from "./support/mcp.ts";
import { openRequestInTheWebUi } from "./support/requests.ts";

// The injection corpus through every path agents read (agent-safety: Every
// string shown to agents has an origin; agent-safety: Content Tiehall did not
// generate is fenced as data; agent-safety: Fenced content cannot close its
// own fence; agent-safety: Invisible characters are stripped from the agent
// view; agent-safety: User text in JSON sits under untrusted objects;
// design.md, Design rules: Agent safety; design.md, Technical decisions: T14
// and T17). Each entry of the corpus the renderer's own tests run is written
// where people and other systems write: as the title, the need and the
// acceptance criteria of a request team QA opens to team FE, as a comment
// each side posts on it, as team FE's intake notes, and as the operation of a
// change a contract report from the provider's CI on GitHub carries. An FE
// member's agent then reads all of it through every path agents read: the MCP
// tools get_request, whats_new, list_inbox and directory, `tiehall get`, the
// markdown and JSON of the request URLs and of team FE's intake page, and the
// contract change list of the request the report opened. In every markdown answer, each entry comes
// back in a fence whose preamble names its origin as the reader sees it (their
// own team's, another team's, or external for what GitHub's CI sent), with
// every marker it holds escaped and every listed invisible character gone, and
// nothing outside the fences' own markers begins a marker. In every JSON
// answer, each entry sits under `untrusted`, without the stripped characters.
//
// A title is one line of at most 200 characters, so a request's title holds
// its entry with its line breaks as spaces, cut to fit; the other fields hold
// each entry whole, but a change's operation, which holds at most 1,000
// characters, holds the longest entry cut to fit.

/** The time the install's execute() tells: real time, moved on past a contract report's burst. */
let shift = 0;
let harness: AgentAccessHarness;
let sam: McpPerson;
let dana: McpPerson;
let ada: McpPerson;
let danaCli: CliMachine;
let mcp: Client;
let urls: RequestUrlRoute;
let feTeam: string;
/** The request each entry was written into, by the entry's index. */
const written: { key: string; title: string }[] = [];
/** The contract-change request the report opened to FE. */
let contractKey: string;

/** An entry as a request's title: one line, cut to fit the title's 200 characters. */
const titleOf = (entry: CorpusEntry) => fitted(entry.text, 200, { oneLine: true });
/** An entry as a change's operation, cut to fit its 1,000 characters. */
const operationOf = (entry: CorpusEntry) => fitted(entry.text, 1000);

beforeAll(async () => {
  harness = await startAgentAccess({ now: () => new Date(Date.now() + shift) });
  ada = await mcpPerson(harness, "ada", { role: "admin" });
  sam = await mcpPerson(harness, "sam-qa", { teams: ["QA"] });
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  const deniz = await mcpPerson(harness, "deniz-pay", { teams: ["PAY"] });
  const teams = await harness.install.owner.query<{ id: string; key: string }>("SELECT id, key FROM teams");
  const teamId = (key: string) => teams.rows.find((team) => team.key === key)?.id ?? "";
  feTeam = teamId("FE");

  // Each entry, written by people: by QA into the request it opens to FE, and by each side into a comment on it.
  // People write in the web UI, so no limit on agents' writes counts these.
  for (const entry of CORPUS) {
    const opened = await openRequestInTheWebUi<{ key: string; untrusted: { title: string } }>(harness.install, sam.userId, {
      targetTeam: "FE",
      requestingTeam: "QA",
      title: titleOf(entry),
      packet: { schema_version: "1-beta", kind: "request", untrusted: { need: entry.text, acceptance_criteria: [entry.text] } },
    });
    for (const person of [dana, sam]) {
      const posted = await harness.install.web(person.session).write("messages.post", { key: opened.key, kind: "comment", body: entry.text }, harness.install.fromThePage(person.session));
      if (!posted.ok) throw new Error(`messages.post answered ${JSON.stringify(posted.problem)}`);
    }
    written.push({ key: opened.key, title: titleOf(entry) });
  }

  // Each entry, sent by GitHub: a report from the provider's CI on GitHub, whose changes' operations hold the entries,
  // opens a contract-change request to FE, which consumes payments-api.
  const repository = harness.stub.addRepo("acme/payments");
  await harness.stub.addMember("acme", "ada", "admin");
  await harness.stub.install(harness.signIn.app, { account: "acme", repositories: ["acme/payments"], by: "ada" });
  harness.install.useGitHub(harness.signIn.github);
  await harness.signIn.connect("acme");
  const app = await harness.signIn.github.app();
  if (app === undefined) throw new Error("The install stores no App.");
  await readInstallations({ database: harness.install.db, app });
  expect((await harness.install.confirm(ada.session, "apis.register", { name: "payments-api", team: teamId("PAY"), repository: "acme/payments" })).status).toBe(200);
  const api = (await harness.install.owner.query<{ id: string }>("SELECT id FROM apis WHERE name = 'payments-api'")).rows[0]?.id ?? "";
  await harness.install.execute("apis.declare_consumer", dana.session, { api, team: feTeam });
  const pullRequest = await harness.stub.openPullRequest("acme/payments", { title: "New payment fields", head: "payment-fields", author: "deniz-pay" });
  const ci: CiCaller = {
    kind: "ci",
    repositoryId: String(repository.id),
    repositoryOwnerId: String(repository.owner.id),
    jobWorkflowRef: "acme/payments/.github/workflows/contract.yml@refs/heads/main",
  };
  const changes = CORPUS.map((entry, index) => ({ id: `probe-change-${index}`, level: "ERR" as const, operation: operationOf(entry) }));
  await harness.install.execute("contract.report", ci, reportOf("payments-api", changes, { pullRequest: pullRequest.number }));
  shift = 3 * 60 * 1000;
  await runDueUpdates(harness.install, new Date(Date.now() + shift));
  const opened = await harness.install.owner.query<{ key: string }>(
    `SELECT t.key || '-' || r.number AS key FROM contract_change_requests c
       JOIN requests r ON r.id = c.request_id JOIN teams t ON t.id = r.target_team_id WHERE t.key = 'FE'`,
  );
  contractKey = opened.rows[0]?.key ?? "";
  expect(contractKey).toMatch(/^FE-\d+$/);
  expect(deniz.userId).not.toBe("");

  mcp = await connectMcp(harness, { token: dana.token, version: MODERN });
  await mcp.listTools();
  danaCli = await signedInCli(harness, dana);
  urls = createRequestUrlRoute({
    execute: harness.install.execute,
    session: async () => undefined,
    authenticate: createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: () => harness.signIn.service.signingKeys(), now: harness.clock.now, database: harness.install.db }),
    url: URL_OF_INSTALL,
  });
}, 300_000);

afterAll(async () => {
  await mcp?.close();
  danaCli?.close();
  await harness?.close();
});

/** get_request's answer for the request, as dana's agent reads it. */
async function getRequest(key: string) {
  const result = await mcp.callTool({ name: "get_request", arguments: { request: key } });
  expect(result.isError ?? false).toBe(false);
  return { markdown: textOf(result), structured: result.structuredContent as Record<string, unknown> };
}

/** A request URL or intake page as this person's agent reads it, with their token: markdown for .md, JSON for .json. */
async function readUrl(person: McpPerson, path: string): Promise<string> {
  const answer = await urls(new Request(`${URL_OF_INSTALL}${path}`, { headers: { authorization: `Bearer ${person.token}` } }));
  if (answer === undefined || !("response" in answer)) throw new Error(`${path} gave no answer of its own.`);
  expect(answer.response.status).toBe(200);
  const body = await answer.response.text();
  scanUrlAnswer(path, answer.response.headers.get("content-type") ?? undefined, body);
  return body;
}

/** Checks a page of a request that holds one entry, as markdown: its title, packet and the two comments, each fenced with its origin for dana. */
function expectRequestPageFenced(fences: readonly Fence[], entry: CorpusEntry, title: string, what: string): void {
  expectFenced(fences, title, "other team", `${what}, its title`);
  expectFenced(fences, entry.text, "other team", `${what}, its need`);
  expectFenced(fences, JSON.stringify([entry.text], null, 2), "other team", `${what}, its acceptance criteria`);
  expectFenced(fences, entry.text, "same team", `${what}, FE's comment`);
  // QA's comment: as other-team text, a second fence beside the need's.
  const others = fences.filter((fence) => fence.origin === "other team" && visible(unescapeMarkers(fence.content)) === visible(unescapeMarkers(entry.text)));
  const titleIsEntry = visible(unescapeMarkers(title)) === visible(unescapeMarkers(entry.text));
  expect(others.length, `${what}: the need and QA's comment are each fenced as another team's`).toBe(titleIsEntry ? 3 : 2);
}

describe.each(CORPUS.map((entry, index) => ({ ...entry, index })))("$name", (entry) => {
  const request = () => written[entry.index] as { key: string; title: string };

  it("arrives fenced, escaped and stripped through get_request, with its JSON under untrusted", async () => {
    const { markdown, structured } = await getRequest(request().key);
    expectRequestPageFenced(fencesOf(markdown), entry, request().title, "get_request");
    expectStrippedJson(structured, "get_request");
    const page = structured as { request: { key: string; untrusted: { title: string } }; parts: { kind: string; untrusted: { text: string } }[] };
    expect(page.request.key).toBe(request().key);
    expect(page.request.untrusted.title).toBe(visible(request().title));
    expect(page.parts.map((part) => part.untrusted.text)).toEqual(
      expect.arrayContaining([visible(entry.text), visible(JSON.stringify([entry.text], null, 2)), visible(entry.text)]),
    );
  });

  it("arrives fenced, escaped and stripped through tiehall get", async () => {
    const run = await danaCli.run(["get", request().key]);
    expect(run.code).toBe(0);
    expectRequestPageFenced(fencesOf(run.stdout), entry, request().title, "tiehall get");
  });

  it("arrives fenced, escaped and stripped through the request URL's markdown", async () => {
    const fences = fencesOf(await readUrl(dana, `/${request().key}.md`));
    expectFenced(fences, request().title, "other team", "the .md URL, its title");
    expectFenced(fences, entry.text, "same team", "the .md URL, FE's comment");
    expectFenced(fences, entry.text, "other team", "the .md URL, QA's comment");
  });

  it("arrives stripped under untrusted through the request URL's JSON", async () => {
    const read = JSON.parse(await readUrl(dana, `/${request().key}.json`)) as { key: string; untrusted: { title: string }; messages: { untrusted: { body: string } }[] };
    expectStrippedJson(read, "the .json URL");
    expect(read.key).toBe(request().key);
    expect(read.untrusted.title).toBe(visible(request().title));
    expect(read.messages.map((message) => message.untrusted.body)).toEqual([visible(entry.text), visible(entry.text)]);
  });

  it("arrives fenced, escaped and stripped through team FE's intake page, in markdown and in JSON, as each reader's origin", async () => {
    const set = await harness.install.web(ada.session).write("teams.set_intake", { teamId: feTeam, notes: entry.text, requiredFields: [] }, harness.install.fromThePage(ada.session));
    expect(set.ok).toBe(true);
    expectFenced(fencesOf(await readUrl(dana, "/FE.md")), entry.text, "same team", "FE's intake page, for FE");
    const directory = await mcp.callTool({ name: "directory", arguments: {} });
    const listed = fencesOf(textOf(directory));
    // Notes made only of stripped characters are empty notes to an agent, which directory leaves out.
    if (visible(entry.text) === "") expect(invisibleIn(textOf(directory))).toEqual([]);
    else expectFenced(listed, entry.text, "same team", "directory, FE's intake notes");
    expectStrippedJson(directory.structuredContent, "directory");
    expectFenced(fencesOf(await readUrl(sam, "/FE.md")), entry.text, "other team", "FE's intake page, for QA");
    const team = JSON.parse(await readUrl(dana, "/FE.json")) as { key: string; untrusted: { intakeNotes: string } };
    expectStrippedJson(team, "FE's intake page as JSON");
    expect(team.key).toBe("FE");
    expect(team.untrusted.intakeNotes).toBe(visible(entry.text));
  });

  it("arrives fenced as external text in the change list of the contract-change request, through get_request and tiehall get", async () => {
    const run = await danaCli.run(["get", contractKey]);
    expect(run.code).toBe(0);
    const { markdown, structured } = await getRequest(contractKey);
    expectStrippedJson(structured, "get_request of the contract-change request");
    // The contract section's JSON as the structured content gives it, which the fence holds escaped.
    const section = (structured as { parts: { kind: string; field?: string; untrusted: { text: string } }[] }).parts.find(
      (part) => part.kind === "packet_field" && part.field === "contract",
    );
    expect(section).toBeDefined();
    for (const [surface, output] of [
      ["get_request", markdown],
      ["tiehall get", run.stdout],
    ] as const) {
      const external = fencesOf(output).filter((fence) => fence.origin === "external");
      // The change list is the contract section's JSON, fenced as what GitHub's CI sent: the entry is its change's operation.
      const lists = external.flatMap((fence) => {
        try {
          return [{ fence, contract: JSON.parse(unescapeMarkers(fence.content)) as { changes?: { id: string; operation: string }[] } }];
        } catch {
          return [];
        }
      });
      const change = lists.flatMap(({ contract }) => contract.changes ?? []).find(({ id }) => id === `probe-change-${entry.index}`);
      expect(change, `${surface}: the change list holds the entry's change, fenced as external`).toBeDefined();
      expect(change?.operation).toBe(unescapeMarkers(visible(operationOf(entry))));
      expectFenced(external, section?.untrusted.text ?? "", "external", `${surface}, the change list`);
    }
  });
});

describe("whats_new", () => {
  it("holds every entry's request title fenced, escaped and stripped, page after page", async () => {
    const titles = new Map<string, string>(written.map(({ key, title }) => [key, title]));
    const seen = new Set<string>();
    let acknowledge: number | undefined;
    for (;;) {
      const result = await mcp.callTool({ name: "whats_new", arguments: { limit: 50, ...(acknowledge === undefined ? {} : { acknowledge }) } });
      expect(result.isError ?? false).toBe(false);
      const page = result.structuredContent as { events: { number: number }[]; "requests": { key: string; untrusted: { title: string } }[] };
      expectStrippedJson(page, "whats_new");
      if (page.events.length === 0) break;
      const fences = fencesOf(textOf(result));
      for (const read of page.requests) {
        const title = titles.get(read.key);
        if (title === undefined) continue;
        expect(read.untrusted.title).toBe(visible(title));
        expectFenced(fences, title, "other team", `whats_new, the title of ${read.key}`);
        seen.add(read.key);
      }
      acknowledge = Math.max(...page.events.map(({ number }) => number));
    }
    expect([...seen].sort()).toEqual([...titles.keys()].sort());
  });
});

describe("list_inbox", () => {
  it("holds the title of every entry's request fenced, escaped and stripped", async () => {
    const result = await mcp.callTool({ name: "list_inbox", arguments: { limit: 50 } });
    expect(result.isError ?? false).toBe(false);
    const inbox = result.structuredContent as { "requests": { key: string; untrusted: { title: string } }[] };
    expectStrippedJson(inbox, "list_inbox");
    const fences = fencesOf(textOf(result));
    for (const { key, title } of written) {
      expect(inbox.requests.find((read) => read.key === key)?.untrusted.title, `list_inbox, the title of ${key}`).toBe(visible(title));
      expectFenced(fences, title, "other team", `list_inbox, the title of ${key}`);
    }
  });
});

describe("text recorded from Jira", () => {
  it.todo("arrives fenced as external text, once the Jira mirror records text from Jira (tasks 25.6 and 25.10)");
});

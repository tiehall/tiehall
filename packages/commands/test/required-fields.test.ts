import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNewRequestRoute, csrfTokenFor, NEW_REQUEST_PATH } from "../src/index.ts";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { signedInCli, type CliMachine } from "./support/cli.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { addTeams, connectMcp, mcpPerson, PROBLEM, problemOf, PROTOCOL_VERSIONS, type McpPerson } from "./support/mcp.ts";
import { packetOf } from "./support/requests.ts";

// Requests that lack a field their target team requires are refused, on every
// path people and agents open requests by (agent-surfaces: Requests missing a
// team's required fields are refused; agent-surfaces: Admins set a team's
// intake notes and required fields; public-api: One error model for Tiehall's
// own refusals; design.md, Decisions this change rests on: D28 #26). FE
// requires the acceptance criteria and a due date. open_request refuses a
// request to FE without them with a validation error that names each; so does
// /api/v1, with 400, which `tiehall open` calls and whose fields it lists; and
// so does the web form, whose refusal lists them. None of them creates
// anything. A request that has every required field is opened, and a team
// that requires nothing takes a request with only its need.

let harness: AgentAccessHarness;
let sam: McpPerson;
let dana: McpPerson;
let samCli: CliMachine;

beforeAll(async () => {
  harness = await startAgentAccess();
  sam = await mcpPerson(harness, "sam-be", { teams: ["BE"] });
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE", "QA"] });
  await addTeams(harness, "MOB", "OPS");
  await harness.install.owner.query("UPDATE teams SET required_fields = ARRAY['acceptance_criteria', 'due_date'] WHERE key = 'FE'");
  await harness.install.owner.query("UPDATE teams SET required_fields = ARRAY['code_refs'] WHERE key = 'MOB'");
  samCli = await signedInCli(harness, sam);
}, 120_000);

afterAll(async () => {
  samCli?.close();
  await harness?.close();
});

async function requestCount(): Promise<number> {
  return Number((await harness.install.owner.query("SELECT count(*) FROM requests")).rows[0].count);
}

/** The paths and messages of a problem's errors. */
function errorsOf(problem: { errors?: unknown }): { path: unknown[]; message: string }[] {
  return (problem.errors ?? []) as { path: unknown[]; message: string }[];
}

describe.each(PROTOCOL_VERSIONS)("open_request, on protocol version %s", (version) => {
  it("refuses a request to FE without the acceptance criteria and the due date FE requires, naming both, and opens nothing", async () => {
    const before = await requestCount();
    const client = await connectMcp(harness, { token: sam.token, version });
    try {
      const result = await client.callTool({ name: "open_request", arguments: { targetTeam: "FE", title: "Add a dark mode", packet: packetOf() } });
      const problem = problemOf(result as never);
      expect(problem).toMatchObject({ type: `${PROBLEM}invalid-input`, status: 400 });
      expect(problem.detail).toContain("the acceptance criteria and a due date");
      expect(errorsOf(problem).map(({ path }) => path.join("."))).toEqual(["packet.untrusted.acceptance_criteria", "packet.due_date"]);
      expect(errorsOf(problem).map(({ message }) => message)).toEqual(["Team FE requires the acceptance criteria.", "Team FE requires a due date."]);
    } finally {
      await client.close();
    }
    expect(await requestCount()).toBe(before);
  });
});

describe("tiehall open", () => {
  it("gets 400 from /api/v1 for a request to FE without the fields FE requires, lists them, and opens nothing", async () => {
    const before = await requestCount();
    const packet = { ...packetOf(), untrusted: { need: "Add a dark mode to the settings page.", acceptance_criteria: ["It follows the system setting."] } };
    const answer = await harness.api("POST", "/api/v1/requests", { authorization: `Bearer ${sam.token}` }, { targetTeam: "FE", title: "Add a dark mode", packet });
    expect(answer.status).toBe(400);
    expect(errorsOf((await answer.json()) as { errors?: unknown }).map(({ path }) => path.join("."))).toEqual(["packet.due_date"]);
    const run = await samCli.run(["open", "FE", "--title", "Add a dark mode", "--packet", JSON.stringify(packetOf())]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("packet.untrusted.acceptance_criteria: Team FE requires the acceptance criteria.");
    expect(run.stderr).toContain("packet.due_date: Team FE requires a due date.");
    expect(await requestCount()).toBe(before);
  });

  it("opens a request to FE that has every field FE requires, and one to QA, which requires nothing, with only its need", async () => {
    const packet = { ...packetOf(), due_date: "2026-12-01", untrusted: { need: "Add a dark mode to the settings page.", acceptance_criteria: ["It follows the system setting."] } };
    const toFe = await samCli.run(["open", "FE", "--title", "Add a dark mode", "--packet", JSON.stringify(packet), "--json"]);
    expect(toFe.code).toBe(0);
    expect(JSON.parse(toFe.stdout)).toMatchObject({ targetTeam: { key: "FE" }, state: "open" });
    const toQa = await samCli.run(["open", "QA", "--title", "Test the export", "--packet", JSON.stringify(packetOf("Test the export.")), "--json"]);
    expect(toQa.code).toBe(0);
  });

  it("counts an empty list of acceptance criteria as none", async () => {
    const packet = { ...packetOf(), due_date: "2026-12-01", untrusted: { need: "Add a dark mode.", acceptance_criteria: [] } };
    const answer = await harness.api("POST", "/api/v1/requests", { authorization: `Bearer ${sam.token}` }, { targetTeam: "FE", title: "Add a dark mode", packet });
    expect(answer.status).toBe(400);
    expect(errorsOf((await answer.json()) as { errors?: unknown }).map(({ path }) => path.join("."))).toEqual(["packet.untrusted.acceptance_criteria"]);
  });
});

describe("the web form that opens a request", () => {
  it("refuses a request to FE without the fields FE requires with 400, names each beside its field, and opens nothing", async () => {
    const before = await requestCount();
    const route = createNewRequestRoute({ execute: harness.install.execute, session: async () => sam.session, url: URL_OF_INSTALL, secret: () => harness.install.authSecret, logger: harness.install.logger });
    const answer = await route(
      new Request(`${URL_OF_INSTALL}${NEW_REQUEST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ csrf: csrfTokenFor(harness.install.authSecret, sam.session.sessionId), targetTeam: "FE", title: "Add a dark mode", need: "Something." }).toString(),
      }),
    );
    expect(answer.status).toBe(400);
    const html = await answer.text();
    // The form comes back, with each refused field's error beside it (web-ui: Pages are accessible).
    expect(html).toContain('<p class="field-error" id="acceptanceCriteria-error">Team FE requires the acceptance criteria.</p>');
    expect(html).toContain('<p class="field-error" id="dueDate-error">Team FE requires a due date.</p>');
    expect(html).toContain(`<form class="panel form-panel" method="post" action="${NEW_REQUEST_PATH}">`);
    expect(await requestCount()).toBe(before);
  });
});

// decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (41). A team's required fields hold when
// a reassignment into it is proposed and when a revision of a request addressed to it is added or proposed: a
// reassignment into a team whose required fields the packet lacks, and a revision that drops a required field the
// current revision has, are refused with 400 listing the missing fields, and create nothing; an empty list counts
// as missing; a revision that lacks a field the current one lacks too is taken. MOB requires code refs.
describe("required fields on reassignment and revisions", () => {
  /** A request Sam opens over /api/v1 to this team, with this packet. */
  async function openTo(team: string, packet: Record<string, unknown>): Promise<{ id: string; key: string }> {
    const answer = await harness.api("POST", "/api/v1/requests", { authorization: `Bearer ${sam.token}` }, { targetTeam: team, title: "Add a dark mode", packet });
    expect(answer.status).toBe(200);
    return (await answer.json()) as { id: string; key: string };
  }

  async function counts(requestId: string): Promise<{ proposals: number; revisions: number }> {
    const { rows } = await harness.install.owner.query<{ proposals: number; revisions: number }>(
      "SELECT (SELECT count(*)::int FROM proposals WHERE request_id = $1) AS proposals, (SELECT count(*)::int FROM packet_revisions WHERE request_id = $1) AS revisions",
      [requestId],
    );
    return rows[0]!;
  }

  const send = (person: McpPerson, path: string, body: unknown, headers: Record<string, string> = {}) =>
    harness.api("POST", path, { authorization: `Bearer ${person.token}`, ...headers }, body);

  const FE_PACKET = { ...packetOf(), due_date: "2026-12-01", untrusted: { need: "Add a dark mode to the settings page.", acceptance_criteria: ["It follows the system setting.", "It remembers the choice."] } };

  it("refuses a reassignment proposal into a team whose required fields the packet lacks, naming them, and proposes nothing", async () => {
    const request = await openTo("QA", packetOf());
    for (const [path, body] of [
      ["/api/v1/proposals", { kind: "reassign", key: request.key, team: "MOB" }],
      [`/api/v1/requests/${request.key}/proposals`, { kind: "reassign", team: "MOB" }],
    ] as const) {
      const answer = await send(dana, path, body);
      expect(answer.status, path).toBe(400);
      const problem = (await answer.json()) as { type: string; detail: string; errors?: unknown };
      expect(problem.type).toBe(`${PROBLEM}invalid-input`);
      expect(problem.detail).toContain("code refs");
      expect(errorsOf(problem).map(({ message }) => message)).toEqual(["Team MOB requires code refs."]);
    }
    const client = await connectMcp(harness, { token: dana.token, version: PROTOCOL_VERSIONS[0] });
    try {
      const result = await client.callTool({ name: "propose", arguments: { kind: "reassign", key: request.key, team: "MOB" } });
      expect(problemOf(result as never)).toMatchObject({ type: `${PROBLEM}invalid-input`, status: 400 });
    } finally {
      await client.close();
    }
    expect(await counts(request.id)).toEqual({ proposals: 0, revisions: 1 });
    // Into FE, whose fields the packet has, the reassignment is proposed.
    const into = await openTo("QA", FE_PACKET);
    expect((await send(dana, "/api/v1/proposals", { kind: "reassign", key: into.key, team: "FE" })).status).toBe(202);
  });

  it("refuses a revision that drops a required field the current revision has, an empty list included, and keeps the current revision", async () => {
    const request = await openTo("FE", FE_PACKET);
    const emptied = await send(sam, `/api/v1/requests/${request.key}/packet/revisions`, { packet: { ...FE_PACKET, untrusted: { ...FE_PACKET.untrusted, acceptance_criteria: [] } } }, { "if-match": '"1"' });
    expect(emptied.status).toBe(400);
    expect(errorsOf((await emptied.json()) as { errors?: unknown }).map(({ message }) => message)).toEqual(["Team FE requires the acceptance criteria."]);
    // A proposed scope change that drops the due date, and a due date proposed away, are refused the same way.
    const { due_date: _due, ...undated } = FE_PACKET;
    const scope = await send(sam, "/api/v1/proposals", { kind: "scope", key: request.key, packet: undated }, { "if-match": '"1"' });
    expect(scope.status).toBe(400);
    expect(errorsOf((await scope.json()) as { errors?: unknown }).map(({ message }) => message)).toEqual(["Team FE requires a due date."]);
    const removed = await send(sam, "/api/v1/proposals", { kind: "due_date", key: request.key, dueDate: null }, { "if-match": '"1"' });
    expect(removed.status).toBe(400);
    expect(await counts(request.id)).toEqual({ proposals: 0, revisions: 1 });
    // A revision that keeps every required field is taken.
    const kept = await send(sam, `/api/v1/requests/${request.key}/packet/revisions`, { packet: { ...FE_PACKET, untrusted: { ...FE_PACKET.untrusted, need: "Add a dark mode, and a high-contrast one." } } }, { "if-match": '"1"' });
    expect(kept.status).toBeLessThan(300);
    expect((await counts(request.id)).revisions).toBe(2);
  });

  it("takes a revision that lacks a field the current revision lacks too", async () => {
    const request = await openTo("OPS", packetOf());
    await harness.install.owner.query("UPDATE teams SET required_fields = ARRAY['links'] WHERE key = 'OPS'");
    try {
      const answer = await send(sam, `/api/v1/requests/${request.key}/packet/revisions`, { packet: packetOf("Rotate the logs every day.") }, { "if-match": '"1"' });
      expect(answer.status).toBeLessThan(300);
      expect((await counts(request.id)).revisions).toBe(2);
    } finally {
      await harness.install.owner.query("UPDATE teams SET required_fields = '{}' WHERE key = 'OPS'");
    }
  });
});

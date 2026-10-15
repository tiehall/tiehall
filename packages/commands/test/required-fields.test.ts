import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNewRequestRoute, csrfTokenFor, NEW_REQUEST_PATH, runRequestPageAction } from "../src/index.ts";
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

// decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (41), as the maintainer answered on
// 2026-10-12. While a reassignment of a request is pending, a packet revision added or proposed is held to the
// required fields of both the team the request is addressed to and the team the reassignment would move it to: one
// that drops a field either team requires, and the current revision has, is refused as a revision that drops a
// required field is, naming the team whose field it drops, on every path a revision is added or proposed by, over
// /api/v1, the MCP tool propose, `tiehall propose` and the web UI's packet change, and the pending reassignment stays
// valid. MOB requires code refs, FE the acceptance criteria and a due date, and QA nothing.
describe("required fields while a reassignment is pending", () => {
  const CODE_REFS = [{ repository: "acme/web", path: "src/settings/theme.ts", ref: "main" }];
  const CODED = { ...packetOf(), untrusted: { need: "Add a dark mode to the settings page.", code_refs: CODE_REFS } };
  const UNCODED = { ...packetOf(), untrusted: { need: "Add a dark mode to the settings and profile pages." } };

  /** A request Sam opens over /api/v1 to this team, with this packet. */
  async function openTo(team: string, packet: Record<string, unknown>): Promise<{ id: string; key: string }> {
    const answer = await harness.api("POST", "/api/v1/requests", { authorization: `Bearer ${sam.token}` }, { targetTeam: team, title: "Add a dark mode", packet });
    expect(answer.status).toBe(200);
    return (await answer.json()) as { id: string; key: string };
  }

  /** Dana, of the target team, proposes to reassign the request to MOB; the proposal waits for its confirmations. */
  async function reassignToMob(key: string): Promise<string> {
    const answer = await harness.api("POST", "/api/v1/proposals", { authorization: `Bearer ${dana.token}` }, { kind: "reassign", key, team: "MOB" });
    expect(answer.status).toBe(202);
    return ((await answer.json()) as { proposal: { id: string } }).proposal.id;
  }

  async function stateOf(requestId: string): Promise<{ revisions: number; proposals: { kind: string; state: string }[] }> {
    const { rows: revisions } = await harness.install.owner.query<{ count: number }>("SELECT count(*)::int AS count FROM packet_revisions WHERE request_id = $1", [requestId]);
    const { rows: proposals } = await harness.install.owner.query<{ kind: string; state: string }>("SELECT kind, state FROM proposals WHERE request_id = $1 ORDER BY created_at", [requestId]);
    return { revisions: revisions[0]?.count ?? 0, proposals };
  }

  const addRevision = (key: string, packet: unknown, revision = 1) =>
    harness.api("POST", `/api/v1/requests/${key}/packet/revisions`, { authorization: `Bearer ${sam.token}`, "if-match": `"${revision}"` }, { packet });

  it("refuses a revision that drops a field the team of a pending reassignment requires, on every path, and keeps the reassignment pending", async () => {
    const request = await openTo("QA", CODED);
    await reassignToMob(request.key);
    const before = await stateOf(request.id);
    expect(before).toEqual({ revisions: 1, proposals: [{ kind: "reassign", state: "pending" }] });

    // Over /api/v1.
    const added = await addRevision(request.key, UNCODED);
    expect(added.status).toBe(400);
    const problem = (await added.json()) as { type: string; detail: string; errors?: unknown };
    expect(problem.type).toBe(`${PROBLEM}invalid-input`);
    expect(problem.detail).toBe(
      "Team MOB, to which a pending proposal would reassign this request, requires code refs, which the packet's current revision has and this revision drops, so nothing was added or proposed.",
    );
    expect(errorsOf(problem)).toEqual([{ path: ["packet", "untrusted", "code_refs"], message: "Team MOB requires code refs." }]);
    const proposed = await harness.api("POST", "/api/v1/proposals", { authorization: `Bearer ${sam.token}`, "if-match": '"1"' }, { kind: "scope", key: request.key, packet: UNCODED });
    expect(proposed.status).toBe(400);
    expect(errorsOf((await proposed.json()) as { errors?: unknown }).map(({ message }) => message)).toEqual(["Team MOB requires code refs."]);

    // Through the MCP tool propose.
    const client = await connectMcp(harness, { token: sam.token, version: PROTOCOL_VERSIONS[0] });
    try {
      const result = await client.callTool({ name: "propose", arguments: { kind: "scope", key: request.key, packet: UNCODED, expectedRevision: 1 } });
      const refused = problemOf(result as never);
      expect(refused).toMatchObject({ type: `${PROBLEM}invalid-input`, status: 400 });
      expect(errorsOf(refused).map(({ message }) => message)).toEqual(["Team MOB requires code refs."]);
    } finally {
      await client.close();
    }

    // Through `tiehall propose`.
    const run = await samCli.run(["propose", "scope", request.key, "--packet", JSON.stringify(UNCODED), "--if-match", "1"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("packet.untrusted.code_refs: Team MOB requires code refs.");

    // Through the web UI's packet change.
    const web = harness.install.web(sam.session);
    const changed = await runRequestPageAction(
      new URLSearchParams({ action: "change_packet", key: request.key, revision: "1", need: "Add a dark mode to the settings and profile pages.", codeRefs: "" }),
      { read: (commandId, input) => web.read(commandId, input), write: (commandId, input) => web.write(commandId, input, harness.install.fromThePage(sam.session)) },
    );
    expect(changed).toMatchObject({ ok: false, action: "change_packet", problem: { status: 400 } });
    expect(errorsOf((changed as { problem: { errors?: unknown } }).problem).map(({ message }) => message)).toEqual(["Team MOB requires code refs."]);

    // Nothing was added or proposed, and the reassignment still waits for its confirmations.
    expect(await stateOf(request.id)).toEqual(before);
    // A revision that keeps the code refs is taken, and the reassignment stays pending.
    expect((await addRevision(request.key, { ...CODED, untrusted: { ...CODED.untrusted, need: "Add a dark mode everywhere." } })).status).toBe(200);
    expect(await stateOf(request.id)).toEqual({ revisions: 2, proposals: [{ kind: "reassign", state: "pending" }] });
  });

  it("names each team whose required field a revision drops: the one the request is addressed to and the one it would move to", async () => {
    const both = { ...packetOf(), due_date: "2026-12-01", untrusted: { need: "Add a dark mode.", acceptance_criteria: ["It follows the system setting."], code_refs: CODE_REFS } };
    const request = await openTo("FE", both);
    await reassignToMob(request.key);
    const answer = await addRevision(request.key, { ...both, untrusted: { need: "Add a dark mode." } });
    expect(answer.status).toBe(400);
    const problem = (await answer.json()) as { detail: string; errors?: unknown };
    expect(problem.detail).toBe(
      "Team FE requires the acceptance criteria, and team MOB, to which a pending proposal would reassign this request, requires code refs, which the packet's current revision has and this revision drops, so nothing was added or proposed.",
    );
    expect(errorsOf(problem).map(({ message }) => message)).toEqual(["Team FE requires the acceptance criteria.", "Team MOB requires code refs."]);
    expect((await stateOf(request.id)).revisions).toBe(1);
  });

  it("takes a revision that lacks a field the team it would move to requires when the current revision lacks it too", async () => {
    const request = await openTo("QA", CODED);
    await reassignToMob(request.key);
    // MOB comes to require links after the reassignment was proposed; the packet has none.
    await harness.install.owner.query("UPDATE teams SET required_fields = ARRAY['code_refs', 'links'] WHERE key = 'MOB'");
    try {
      expect((await addRevision(request.key, { ...CODED, untrusted: { ...CODED.untrusted, need: "Add a dark mode everywhere." } })).status).toBe(200);
    } finally {
      await harness.install.owner.query("UPDATE teams SET required_fields = ARRAY['code_refs'] WHERE key = 'MOB'");
    }
  });

  it("holds a revision to the fields of the team it would move to only while the reassignment is pending", async () => {
    // Withdrawn by its proposer, the reassignment holds nothing.
    const withdrawn = await openTo("QA", CODED);
    const proposal = await reassignToMob(withdrawn.key);
    const ended = await harness.api("POST", "/api/v1/proposals", { authorization: `Bearer ${dana.token}` }, { kind: "withdraw_proposal", proposal });
    expect(ended.status).toBe(200);
    expect((await addRevision(withdrawn.key, UNCODED)).status).toBe(200);
    // Nor does a reassignment whose 7 days are over, which no confirmation can take any more, even before the job that
    // marks it expired has run: a proposal never changes what it proposes, so the test stores one made 8 days ago, and
    // the one made now is withdrawn.
    const lapsed = await openTo("QA", CODED);
    const made = await reassignToMob(lapsed.key);
    await harness.install.owner.query(
      `INSERT INTO proposals (org_id, request_id, kind, second_confirmation, accountable_user_id, accountable_side, actor_kind, client, surface, team_id, change, base_revision, state, created_at, expires_at)
       SELECT org_id, request_id, kind, second_confirmation, accountable_user_id, accountable_side, actor_kind, client, surface, team_id, change, base_revision, 'pending', now() - interval '8 days', now() - interval '1 day'
       FROM proposals WHERE id = $1`,
      [made],
    );
    expect((await harness.api("POST", "/api/v1/proposals", { authorization: `Bearer ${dana.token}` }, { kind: "withdraw_proposal", proposal: made })).status).toBe(200);
    expect((await stateOf(lapsed.id)).proposals).toEqual([
      { kind: "reassign", state: "pending" },
      { kind: "reassign", state: "withdrawn" },
    ]);
    expect((await addRevision(lapsed.key, UNCODED)).status).toBe(200);
  });
});

// decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (41), as the maintainer answered on
// 2026-10-12. An undo of a packet change within the undo window, which proposals.undo makes only in the web UI, with
// the confirmation step, restores the packet the change replaced as the next revision, so it is held as a revision
// is: to the required fields of the team the request is addressed to and, while a reassignment of the request is
// pending, of the team it would move to. One that would restore a packet without a field either team requires, and
// the current revision has, is refused with 400 and the problem type invalid-input, whose detail names the team and
// the field and whose error names the proposal; nothing is undone, and the reassignment stays pending. QA requires
// nothing and REL a due date.
describe("an undo while a reassignment is pending", () => {
  beforeAll(async () => {
    await addTeams(harness, "REL");
    await harness.install.owner.query("UPDATE teams SET required_fields = ARRAY['due_date'] WHERE key = 'REL'");
  });

  const api = (person: McpPerson, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    harness.api(method, path, { authorization: `Bearer ${person.token}`, ...headers }, body);
  const confirm = (person: McpPerson, proposal: string) => harness.install.confirm(person.session, "proposals.confirm", { proposal });
  const undo = (person: McpPerson, proposal: string, headers: Record<string, string> = {}) => harness.install.confirm(person.session, "proposals.undo", { proposal }, headers);

  async function stateOf(requestId: string): Promise<{ revisions: number; team: string; proposals: { kind: string; state: string }[] }> {
    const { rows: revisions } = await harness.install.owner.query<{ count: number }>("SELECT count(*)::int AS count FROM packet_revisions WHERE request_id = $1", [requestId]);
    const { rows: team } = await harness.install.owner.query<{ key: string }>("SELECT t.key FROM requests r JOIN teams t ON t.id = r.target_team_id WHERE r.id = $1", [requestId]);
    const { rows: proposals } = await harness.install.owner.query<{ kind: string; state: string }>("SELECT kind, state FROM proposals WHERE request_id = $1 ORDER BY created_at", [requestId]);
    return { revisions: revisions[0]?.count ?? 0, team: team[0]?.key ?? "", proposals };
  }

  /**
   * A request Sam opens to QA without a due date, whose due date Sam proposes and Sam and Dana, of QA, confirm; then
   * Dana proposes to reassign it to REL, which its packet now allows.
   */
  async function datedThenReassigned(): Promise<{ id: string; key: string; dueDate: string; reassign: string }> {
    const opened = await api(sam, "POST", "/api/v1/requests", { targetTeam: "QA", title: "Add a dark mode", packet: packetOf() });
    expect(opened.status).toBe(200);
    const request = (await opened.json()) as { id: string; key: string };
    const proposed = await api(sam, "POST", "/api/v1/proposals", { kind: "due_date", key: request.key, dueDate: "2026-12-01" }, { "if-match": '"1"' });
    expect(proposed.status).toBe(202);
    const dueDate = ((await proposed.json()) as { proposal: { id: string } }).proposal.id;
    expect((await confirm(sam, dueDate)).status).toBe(200);
    expect((await confirm(dana, dueDate)).status).toBe(200);
    const reassigned = await api(dana, "POST", "/api/v1/proposals", { kind: "reassign", key: request.key, team: "REL" });
    expect(reassigned.status).toBe(202);
    const reassign = ((await reassigned.json()) as { proposal: { id: string } }).proposal.id;
    return { ...request, dueDate, reassign };
  }

  it("refuses an undo that would drop a field the team it would move to requires, naming the team, and keeps the reassignment pending", async () => {
    const request = await datedThenReassigned();
    const before = await stateOf(request.id);
    expect(before).toEqual({ revisions: 2, team: "QA", proposals: [{ kind: "due_date", state: "applied" }, { kind: "reassign", state: "pending" }] });
    const refused = await undo(sam, request.dueDate);
    expect(refused.status).toBe(400);
    const problem = (await refused.json()) as { type: string; detail: string; errors?: unknown };
    expect(problem.type).toBe(`${PROBLEM}invalid-input`);
    expect(problem.detail).toBe(
      "Team REL, to which a pending proposal would reassign this request, requires a due date, which the packet's current revision has and the revision this undo would restore lacks, so nothing was undone.",
    );
    expect(errorsOf(problem)).toEqual([{ path: ["proposal"], message: "Team REL requires a due date." }]);
    expect(await stateOf(request.id)).toEqual(before);
    // A browser gets the refusal as a page.
    const page = await undo(sam, request.dueDate, { accept: "text/html" });
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("Team REL, to which a pending proposal would reassign this request, requires a due date");
    expect(await stateOf(request.id)).toEqual(before);
    // Withdrawn by its proposer, the reassignment holds nothing, and the undo is taken.
    expect((await api(dana, "POST", "/api/v1/proposals", { kind: "withdraw_proposal", proposal: request.reassign })).status).toBe(200);
    expect((await undo(sam, request.dueDate)).status).toBe(200);
    expect((await stateOf(request.id)).revisions).toBe(3);
  });

  it("refuses an undo that would drop a field of the team a confirmed reassignment moved the request to, as a revision is held", async () => {
    const request = await datedThenReassigned();
    expect((await confirm(dana, request.reassign)).status).toBe(200);
    const before = await stateOf(request.id);
    expect(before).toMatchObject({ revisions: 2, team: "REL" });
    const refused = await undo(sam, request.dueDate);
    expect(refused.status).toBe(400);
    const problem = (await refused.json()) as { type: string; detail: string; errors?: unknown };
    expect(problem.type).toBe(`${PROBLEM}invalid-input`);
    expect(problem.detail).toBe("Team REL requires a due date, which the packet's current revision has and the revision this undo would restore lacks, so nothing was undone.");
    expect(await stateOf(request.id)).toEqual(before);
  });
});

// decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (41), as the maintainer answered on
// 2026-10-12. A reassignment cannot be proposed while a pending packet change of the request, a due date or a scope
// change waiting for its confirmations, would drop a field that the team it would move to requires: the proposal is
// refused as a reassignment into a team whose required fields the packet lacks is, with 400 and the problem type
// invalid-input, whose detail and error name the pending packet change, by its proposal's id, and the field, on every
// path a reassignment is proposed by, over /api/v1, the MCP tool propose, `tiehall propose` and the web UI's
// reassignment, and nothing is proposed. A packet change whose 7 days are over holds nothing. MOB requires code refs,
// SHIP a due date, and QA nothing.
describe("a reassignment while a packet change is pending", () => {
  const CODE_REFS = [{ repository: "acme/web", path: "src/settings/theme.ts", ref: "main" }];
  const CODED = { ...packetOf(), untrusted: { need: "Add a dark mode to the settings page.", code_refs: CODE_REFS } };
  const UNCODED = { ...packetOf(), untrusted: { need: "Add a dark mode to the settings and profile pages." } };
  let danaCli: CliMachine;

  beforeAll(async () => {
    await addTeams(harness, "SHIP");
    await harness.install.owner.query("UPDATE teams SET required_fields = ARRAY['due_date'] WHERE key = 'SHIP'");
    danaCli = await signedInCli(harness, dana);
  });

  afterAll(() => danaCli?.close());

  const api = (person: McpPerson, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    harness.api(method, path, { authorization: `Bearer ${person.token}`, ...headers }, body);

  /** A request Sam opens over /api/v1 to QA, with this packet. */
  async function openToQa(packet: Record<string, unknown>): Promise<{ id: string; key: string }> {
    const answer = await api(sam, "POST", "/api/v1/requests", { targetTeam: "QA", title: "Add a dark mode", packet });
    expect(answer.status).toBe(200);
    return (await answer.json()) as { id: string; key: string };
  }

  /** Sam proposes this packet change of the request, at its first revision; the proposal waits for its confirmations. */
  async function proposeChange(key: string, change: Record<string, unknown>): Promise<string> {
    const answer = await api(sam, "POST", "/api/v1/proposals", { key, ...change }, { "if-match": '"1"' });
    expect(answer.status).toBe(202);
    return ((await answer.json()) as { proposal: { id: string } }).proposal.id;
  }

  async function stateOf(requestId: string): Promise<{ revisions: number; proposals: { kind: string; state: string }[] }> {
    const { rows: revisions } = await harness.install.owner.query<{ count: number }>("SELECT count(*)::int AS count FROM packet_revisions WHERE request_id = $1", [requestId]);
    const { rows: proposals } = await harness.install.owner.query<{ kind: string; state: string }>("SELECT kind, state FROM proposals WHERE request_id = $1 ORDER BY created_at", [requestId]);
    return { revisions: revisions[0]?.count ?? 0, proposals };
  }

  const reassign = (key: string, team: string) => api(dana, "POST", "/api/v1/proposals", { kind: "reassign", key, team });

  it("refuses a reassignment while a pending scope change would drop a field the team requires, naming the change and the field, on every path", async () => {
    const request = await openToQa(CODED);
    // Claimed, the request's scope changes only through a proposal.
    expect((await api(dana, "POST", `/api/v1/requests/${request.key}/claim`)).status).toBe(200);
    const scope = await proposeChange(request.key, { kind: "scope", packet: UNCODED });
    const before = await stateOf(request.id);
    expect(before).toEqual({ revisions: 1, proposals: [{ kind: "scope", state: "pending" }] });
    const detail = `The pending scope change ${scope} of this request would drop code refs, which team MOB requires of the requests reassigned to it, so nothing was proposed.`;
    const error = { path: ["team"], message: `Team MOB requires code refs, which the pending scope change ${scope} would drop.` };

    // Over /api/v1, by both of its operations.
    for (const [path, body] of [
      ["/api/v1/proposals", { kind: "reassign", key: request.key, team: "MOB" }],
      [`/api/v1/requests/${request.key}/proposals`, { kind: "reassign", team: "MOB" }],
    ] as const) {
      const answer = await api(dana, "POST", path, body);
      expect(answer.status, path).toBe(400);
      const problem = (await answer.json()) as { type: string; detail: string; errors?: unknown };
      expect(problem.type).toBe(`${PROBLEM}invalid-input`);
      expect(problem.detail).toBe(detail);
      expect(errorsOf(problem)).toEqual([error]);
    }

    // Through the MCP tool propose.
    const client = await connectMcp(harness, { token: dana.token, version: PROTOCOL_VERSIONS[0] });
    try {
      const refused = problemOf((await client.callTool({ name: "propose", arguments: { kind: "reassign", key: request.key, team: "MOB" } })) as never);
      expect(refused).toMatchObject({ type: `${PROBLEM}invalid-input`, status: 400, detail });
      expect(errorsOf(refused)).toEqual([error]);
    } finally {
      await client.close();
    }

    // Through `tiehall propose`.
    const run = await danaCli.run(["propose", "reassign", request.key, "--team", "MOB"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`team: Team MOB requires code refs, which the pending scope change ${scope} would drop.`);

    // Through the web UI's reassignment.
    const web = harness.install.web(dana.session);
    const page = await runRequestPageAction(new URLSearchParams({ action: "reassign", key: request.key, team: "MOB" }), {
      read: (commandId, input) => web.read(commandId, input),
      write: (commandId, input) => web.write(commandId, input, harness.install.fromThePage(dana.session)),
    });
    expect(page).toMatchObject({ ok: false, action: "reassign", problem: { status: 400, detail } });

    // Nothing was proposed, and the scope change still waits for its confirmations.
    expect(await stateOf(request.id)).toEqual(before);
    // Once the scope change has ended, withdrawn by Sam, the reassignment is proposed.
    expect((await api(sam, "POST", "/api/v1/proposals", { kind: "withdraw_proposal", proposal: scope })).status).toBe(200);
    expect((await reassign(request.key, "MOB")).status).toBe(202);
  });

  it("refuses a reassignment while a pending due date change would remove the due date the team requires", async () => {
    const request = await openToQa({ ...packetOf(), due_date: "2026-12-01" });
    const removal = await proposeChange(request.key, { kind: "due_date", dueDate: null });
    const answer = await reassign(request.key, "SHIP");
    expect(answer.status).toBe(400);
    const problem = (await answer.json()) as { type: string; detail: string; errors?: unknown };
    expect(problem.detail).toBe(
      `The pending due date change ${removal} of this request would drop a due date, which team SHIP requires of the requests reassigned to it, so nothing was proposed.`,
    );
    expect(errorsOf(problem)).toEqual([{ path: ["team"], message: `Team SHIP requires a due date, which the pending due date change ${removal} would drop.` }]);
    expect((await stateOf(request.id)).proposals).toEqual([{ kind: "due_date", state: "pending" }]);
  });

  it("proposes a reassignment while a pending packet change keeps every field the team requires", async () => {
    const request = await openToQa(CODED);
    expect((await api(dana, "POST", `/api/v1/requests/${request.key}/claim`)).status).toBe(200);
    await proposeChange(request.key, { kind: "scope", packet: { ...CODED, untrusted: { ...CODED.untrusted, need: "Add a dark mode everywhere." } } });
    expect((await reassign(request.key, "MOB")).status).toBe(202);
    expect((await stateOf(request.id)).proposals).toEqual([
      { kind: "scope", state: "pending" },
      { kind: "reassign", state: "pending" },
    ]);
  });

  it("holds a reassignment to no packet change whose 7 days are over", async () => {
    // A proposal never changes what it proposes, so the test stores a copy of the pending scope change made 8 days ago,
    // which no confirmation can take any more, even before the job that marks it expired has run, and Sam withdraws the
    // one made now.
    const request = await openToQa(CODED);
    expect((await api(dana, "POST", `/api/v1/requests/${request.key}/claim`)).status).toBe(200);
    const made = await proposeChange(request.key, { kind: "scope", packet: UNCODED });
    await harness.install.owner.query(
      `INSERT INTO proposals (org_id, request_id, kind, second_confirmation, accountable_user_id, accountable_side, actor_kind, client, surface, team_id, change, base_revision, state, created_at, expires_at)
       SELECT org_id, request_id, kind, second_confirmation, accountable_user_id, accountable_side, actor_kind, client, surface, team_id, change, base_revision, 'pending', now() - interval '8 days', now() - interval '1 day'
       FROM proposals WHERE id = $1`,
      [made],
    );
    expect((await api(sam, "POST", "/api/v1/proposals", { kind: "withdraw_proposal", proposal: made })).status).toBe(200);
    expect((await stateOf(request.id)).proposals).toEqual([
      { kind: "scope", state: "pending" },
      { kind: "scope", state: "withdrawn" },
    ]);
    expect((await reassign(request.key, "MOB")).status).toBe(202);
  });
});

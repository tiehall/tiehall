import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNewRequestRoute, csrfTokenFor, NEW_REQUEST_PATH } from "../src/index.ts";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { signedInCli, type CliMachine } from "./support/cli.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, mcpPerson, PROBLEM, problemOf, PROTOCOL_VERSIONS, type McpPerson } from "./support/mcp.ts";
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
let samCli: CliMachine;

beforeAll(async () => {
  harness = await startAgentAccess();
  sam = await mcpPerson(harness, "sam-be", { teams: ["BE"] });
  await mcpPerson(harness, "dana-fe", { teams: ["FE", "QA"] });
  await harness.install.owner.query("UPDATE teams SET required_fields = ARRAY['acceptance_criteria', 'due_date'] WHERE key = 'FE'");
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

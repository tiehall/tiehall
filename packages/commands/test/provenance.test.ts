import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { messagePosted } from "@tiehall/core";
import { createExecute, type Caller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Provenance is stamped by the server (requests: Provenance is stamped by the
// server; design.md, Decisions this change rests on: D28 #19; D30 (3);
// design.md, Design rules: Requests and events; design.md, Self-hosting
// decisions: S7). Every change records who caused it: the accountable human,
// the actor kind, the client, the surface and the team. execute() stamps all
// of it from the caller's token or session, never from the payload, whose
// claims are dropped with every other key the schema does not know. A call
// with an OAuth token or a personal access token is an agent's, a direct
// /api/v1 call is on the surface api, and a web action is a web session's.
// Nothing is ever recorded with the actor kind human.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;
let key: string;

/** What a payload claims about who sent it, which the server must ignore. */
const FORGED = {
  actorKind: "human",
  surface: "web",
  client: "https://forged.example/client.json",
  userId: "7a1f0c56-6ad1-4a3e-9b1c-3f0d8f2f2b11",
  teamId: "7a1f0c56-6ad1-4a3e-9b1c-3f0d8f2f2b12",
  provenance: { actorKind: "human", surface: "web" },
};

/** An MCP client's id, as its Client ID Metadata Document names it. */
const MCP_CLIENT = "https://agent.example/client-metadata.json";
/** The CLI's registered OAuth client. */
const CLI_CLIENT = "tiehall-cli";

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE"]) team[name] = await addTeam(install.owner, name);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, bob, team["FE"] ?? "");
  key = (await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key;
});

afterAll(async () => {
  await install.close();
});

/** The provenance stored with a message, and with the event that records its posting. */
async function provenanceOfMessage(messageId: string) {
  const message = await install.owner.query(
    "SELECT actor_kind, actor_user_id, client, surface, team_id FROM messages WHERE id = $1",
    [messageId],
  );
  const event = await install.owner.query(
    "SELECT actor_kind, actor_user_id, client, surface, team_id FROM events WHERE type = 'request.message_posted' AND data->>'messageId' = $1",
    [messageId],
  );
  return { message: message.rows[0], event: event.rows[0] };
}

describe("execute(), for every surface", () => {
  // A probe operation offered on REST and MCP, whose handler records what it was given and the event of its change.
  const seen: unknown[] = [];
  const catalog = defineCatalog([
    defineCommand({
      id: "probes.post",
      summary: "Post a probe message.",
      input: z.object({ body: z.string() }),
      output: z.object({ number: z.number() }),
      method: "POST",
      path: "/api/v1/probes",
      scopes: ["requests:write"],
      commitment: false,
      confirm: false,
      surfaces: ["rest", "mcp"],
      tool: "post_probe",
      stability: "alpha",
    }),
  ]);
  let execute: ReturnType<typeof createExecute>;

  beforeAll(() => {
    execute = createExecute({
      catalog,
      handlers: {
        "probes.post": async (input, context) => {
          seen.push(input);
          return context.write(async (writer) => {
            const { number } = await writer.record(messagePosted, { requestId: randomUUID(), messageId: randomUUID() });
            return { number };
          });
        },
      },
      store: { database: install.db, jobs: { send: async () => {} } },
    });
  });

  async function recorded(caller: Caller) {
    const { number } = (await execute("probes.post", caller, { body: "Hello.", ...FORGED })) as { number: number };
    const { rows } = await install.owner.query("SELECT actor_kind, actor_user_id, client, surface FROM events WHERE number = $1", [number]);
    return rows[0];
  }

  it("records an MCP client's call as an agent's on mcp, with the token's client and user, ignoring what the payload claims", async () => {
    expect(await recorded(oauthTokenOf(bob, MCP_CLIENT, "mcp"))).toEqual({ actor_kind: "agent", actor_user_id: bob, client: MCP_CLIENT, surface: "mcp" });
    // The handler never saw the payload's claims: the schema dropped them.
    expect(seen.at(-1)).toEqual({ body: "Hello." });
  });

  it("records the CLI's call as an agent's on cli, with the CLI as its client", async () => {
    expect(await recorded(oauthTokenOf(bob, CLI_CLIENT, "cli"))).toEqual({ actor_kind: "agent", actor_user_id: bob, client: CLI_CLIENT, surface: "cli" });
  });

  it("records a personal access token's direct /api/v1 call as an agent's on api", async () => {
    expect(await recorded(tokenOf(bob, "api"))).toEqual({ actor_kind: "agent", actor_user_id: bob, client: null, surface: "api" });
  });

  it("records a web action as a web session's on web", async () => {
    expect(await recorded(sessionOf(bob))).toEqual({ actor_kind: "web_session", actor_user_id: bob, client: null, surface: "web" });
  });
});

describe("a message", () => {
  it("posted by an agent whose payload claims web and human is recorded as the agent's, with its client, user and team", async () => {
    const answer = await callApi(install, oauthTokenOf(bob, CLI_CLIENT, "cli"), "POST", `/api/v1/requests/${key}/messages`, {
      kind: "comment",
      body: "Posted through the CLI.",
      ...FORGED,
    });
    expect(answer.status).toBe(200);
    const stamped = { actor_kind: "agent", actor_user_id: bob, client: CLI_CLIENT, surface: "cli", team_id: team["FE"] };
    expect(await provenanceOfMessage(answer.body.message.id)).toEqual({ message: stamped, event: stamped });
    expect(answer.body.message.provenance).toEqual({
      actorKind: "agent",
      surface: "cli",
      user: { id: bob, login: "bob", kind: "human", bot: false },
      team: { id: team["FE"], key: "FE" },
    });
    expect(answer.body.message.untrusted.client).toBe(CLI_CLIENT);
  });

  it("posted by a script through /api/v1 with a personal access token is recorded with the surface api", async () => {
    const answer = await callApi(install, tokenOf(alice, "api"), "POST", `/api/v1/requests/${key}/messages`, { kind: "comment", body: "From a script." });
    const stamped = { actor_kind: "agent", actor_user_id: alice, client: null, surface: "api", team_id: team["BE"] };
    expect(await provenanceOfMessage(answer.body.message.id)).toEqual({ message: stamped, event: stamped });
  });

  it("posted in the web UI is recorded as the web session's, with Bob as its accountable human", async () => {
    const caller = sessionOf(bob);
    const result = await install.web(caller).write("messages.post", { key, kind: "comment", body: "From the page.", ...FORGED }, install.fromThePage(caller));
    if (!result.ok) throw new Error(JSON.stringify(result.problem));
    const { message } = result.output as { message: { id: string } };
    const stamped = { actor_kind: "web_session", actor_user_id: bob, client: null, surface: "web", team_id: team["FE"] };
    expect(await provenanceOfMessage(message.id)).toEqual({ message: stamped, event: stamped });
  });
});

describe("the other request changes", () => {
  it("record the team the user acted for: the requesting team for an opening, the target team for a claim", async () => {
    const opened = await openRequest(install, oauthTokenOf(alice, MCP_CLIENT, "api"), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${opened.key}/claim`);
    const { rows } = await install.owner.query(
      "SELECT type, actor_kind, actor_user_id, client, surface, team_id FROM events WHERE data->>'requestId' = $1 ORDER BY number",
      [opened.id],
    );
    expect(rows).toEqual([
      { type: "request.opened", actor_kind: "agent", actor_user_id: alice, client: MCP_CLIENT, surface: "api", team_id: team["BE"] },
      { type: "request.claimed", actor_kind: "agent", actor_user_id: bob, client: null, surface: "api", team_id: team["FE"] },
    ]);
  });

  it("never record the actor kind human, in the events or the thread", async () => {
    const { rows } = await install.owner.query(
      "SELECT (SELECT count(*) FROM events WHERE actor_kind = 'human') + (SELECT count(*) FROM messages WHERE actor_kind = 'human') AS human",
    );
    expect(rows[0]).toEqual({ human: "0" });
  });
});

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestNeedsHumanCleared, requestProviderChangeShipped, requestTrackerChanged } from "@tiehall/core";
import { appendEvent } from "../src/append-event.ts";
import { actorWords, clientWords } from "../src/event-lines.ts";
import { requestActivityQueries } from "../src/request-activity.ts";
import { withOrg, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequestInTheWebUi, sessionOf, tokenOf } from "./support/requests.ts";

// The request page's activity (web-ui: The request page shows who works on it
// and what happened; web-ui: What the live hall shows of the people and agents
// at work; design.md, Design: The request page's activity; design.md, Design:
// The live hall; D57 (13), (15)). requests.activity reads, from a request's
// own domain events, who wrote on it last as an agent or in the web UI, and
// when; whether their agent is at work on it, which it is only while the
// request is in_progress and that write is an agent's under 10 minutes old;
// and its 20 latest domain events, newest first, in Tiehall's words, with who
// caused each, when, and the state it left the request in. A client is named
// as the live hall names it, and nothing the read returns holds a message's or
// a packet's text. The clock is the test's own; each event's time is set to
// the moment the test says it happened.

/** Text seeded in the packet and the thread, which no answer of the read may hold. */
const MARKER = "MARKER-5f2c9a: text people wrote";
const METADATA_DOCUMENT = "https://client.example.com/tiehall.json";
const T0 = Date.parse("2026-10-11T12:00:00.000Z");
const MINUTE = 60_000;

let install: TestInstall;
let clock = new Date(T0);
let selin: string;
let mert: string;
let deniz: string;
let reader: WebSessionCaller;
/** The number of the last event the test has given a time. */
let stamped = 0;

interface Actor {
  kind: string;
  user: { id: string; login: string; kind: "human"; bot: boolean } | null;
  client: { kind: string; host: string | null; version: string | null; unverified: boolean; untrusted: { name: string | null } } | null;
}

interface Activity {
  now: string;
  request: { id: string; key: string; state: string };
  lastWrite: { at: string; actor: Actor } | null;
  agentAtWork: boolean;
  events: { number: number; type: string; at: string; state: string; line: string; actor: Actor }[];
  authors: { messageId: string; actor: Actor }[];
}

/** Gives every event appended since the last call this time, as the owner, past the append-only trigger. */
async function happenedAt(at: number): Promise<void> {
  await install.owner.query("BEGIN; SET LOCAL session_replication_role = replica");
  const { rows } = await install.owner.query<{ number: string }>("UPDATE events SET occurred_at = $1 WHERE number > $2 RETURNING number", [new Date(at), stamped]);
  await install.owner.query("COMMIT");
  stamped = Math.max(stamped, ...rows.map(({ number }) => Number(number)));
}

async function activity(key: string, caller: WebSessionCaller = reader): Promise<Activity> {
  const answer = (await install.execute("requests.activity", caller, { key }, { readOnly: true })) as Activity;
  expect(JSON.stringify(answer)).not.toContain("MARKER-5f2c9a");
  return answer;
}

/** Runs a write as the user in the web UI, from one of its pages; fails the test on a refusal. */
async function inTheWebUi(userId: string, commandId: string, input: unknown): Promise<void> {
  const session = sessionOf(userId);
  const result = await install.web(session).write(commandId, input, install.fromThePage(session));
  expect(result, commandId).toMatchObject({ ok: true });
}

/** Posts a comment as the caller through /api/v1. */
async function comment(caller: Parameters<typeof callApi>[1], key: string): Promise<void> {
  expect((await callApi(install, caller, "POST", `/api/v1/requests/${key}/messages`, { kind: "comment", body: MARKER })).status).toBe(200);
}

/** Adds an agent client, as the authorization server stores one: by its metadata document, or registered with or without a name. */
async function addClient(clientId: string, name: string | null, metadataDocument: boolean): Promise<void> {
  await install.owner.query(
    "INSERT INTO oauth_clients (org_id, client_id, name, client_discovery_id, redirect_uris) SELECT id, $1, $2, $3, ARRAY['https://client.example.com/callback'] FROM orgs",
    [clientId, name, metadataDocument ? "cimd" : null],
  );
}

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  selin = await addUser(install.owner, { login: "selin" });
  mert = await addUser(install.owner, { login: "mert" });
  deniz = await addUser(install.owner, { login: "deniz" });
  reader = sessionOf(await addUser(install.owner, { login: "carol" }));
  await joinTeams(install.owner, selin, be);
  await joinTeams(install.owner, mert, fe);
  await joinTeams(install.owner, deniz, fe);
  await addClient(METADATA_DOCUMENT, "Example Agent", true);
}, 120_000);

afterAll(async () => {
  await install?.close();
});

describe("requests.activity", () => {
  it("lists the request's domain events, newest first, in Tiehall's words, with who caused each, when and the state it left the request in", async () => {
    const agent = oauthTokenOf(mert, METADATA_DOCUMENT, "mcp");
    // FE-1 is opened in the web UI, claimed by Mert's agent, which asks a blocking question that Selin answers, and then starts work.
    await openRequestInTheWebUi(install, selin, {
      targetTeam: "FE",
      title: "Add a forgot password link",
      packet: { schema_version: "1-beta", kind: "request", untrusted: { need: MARKER, acceptance_criteria: [MARKER] } },
    });
    await happenedAt(T0);
    expect((await callApi(install, agent, "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
    await happenedAt(T0 + MINUTE);
    const question = await callApi(install, agent, "POST", "/api/v1/requests/FE-1/messages", { kind: "question", body: MARKER, blocking: true });
    expect(question.status).toBe(200);
    await happenedAt(T0 + 2 * MINUTE);
    await inTheWebUi(selin, "messages.post", { key: "FE-1", kind: "answer", body: MARKER, questionId: question.body.message.id });
    await happenedAt(T0 + 3 * MINUTE);
    expect((await callApi(install, agent, "POST", "/api/v1/requests/FE-1/status", { state: "in_progress" })).status).toBe(200);
    await happenedAt(T0 + 4 * MINUTE);
    clock = new Date(T0 + 4 * MINUTE + 40_000);

    const read = await activity("FE-1");
    expect(read.now).toBe(clock.toISOString());
    expect(read.request).toMatchObject({ key: "FE-1", state: "in_progress" });
    expect(read.events.map(({ type, state }) => [type, state])).toEqual([
      ["request.started", "in_progress"],
      ["request.state_changed", "claimed"],
      ["request.message_posted", "needs_info"],
      ["request.state_changed", "needs_info"],
      ["request.message_posted", "claimed"],
      ["request.claimed", "claimed"],
      ["request.opened", "open"],
    ]);
    expect(read.events.map(({ line }) => line)).toEqual([
      "Work on it started",
      "It moved from needs info to claimed",
      "An answer was posted",
      "It moved from claimed to needs info",
      "A blocking question was posted",
      "It was claimed",
      "It was opened",
    ]);
    expect(read.events.map(({ actor }) => actorWords(actor as never))).toEqual(["mert's agent", "selin", "selin", "mert's agent", "mert's agent", "mert's agent", "selin"]);
    expect(read.events.map(({ at }) => at)).toEqual([4, 3, 3, 2, 2, 1, 0].map((minutes) => new Date(T0 + minutes * MINUTE).toISOString()));
    const numbers = read.events.map(({ number }) => number);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
  });

  it("names the latest writer, an agent or a web session, with the login, the bot mark, the actor kind and the client, and says the agent is at work", async () => {
    clock = new Date(T0 + 4 * MINUTE + 40_000);
    const read = await activity("FE-1");
    expect(read.lastWrite).toEqual({
      at: new Date(T0 + 4 * MINUTE).toISOString(),
      actor: {
        kind: "agent",
        user: { id: mert, login: "mert", kind: "human", bot: false },
        client: { kind: "metadata_document", host: "client.example.com", version: null, unverified: false, untrusted: { name: "Example Agent" } },
      },
    });
    expect(read.agentAtWork).toBe(true);
    expect(clientWords(read.lastWrite?.actor.client as never)).toBe("Example Agent (client.example.com)");
    await install.owner.query("UPDATE users SET bot = true WHERE id = $1", [mert]);
    const marked = await activity("FE-1");
    expect(marked.lastWrite?.actor.user).toMatchObject({ login: "mert", bot: true });
    expect(actorWords(marked.lastWrite?.actor as never)).toBe("mert (bot)'s agent");
    await install.owner.query("UPDATE users SET bot = false WHERE id = $1", [mert]);
  });

  it("says an agent is at work only while its write is under 10 minutes old", async () => {
    clock = new Date(T0 + 14 * MINUTE - 1000);
    expect((await activity("FE-1")).agentAtWork).toBe(true);
    clock = new Date(T0 + 14 * MINUTE + 1000);
    const read = await activity("FE-1");
    expect(read.agentAtWork).toBe(false);
    expect(read.lastWrite?.at).toBe(new Date(T0 + 4 * MINUTE).toISOString());
  });

  it("says no agent is at work while the request is not in_progress, nor when its last write came from the web UI", async () => {
    // FE-2: claimed by Mert's agent a moment ago, and not started.
    await openRequestInTheWebUi(install, selin, { targetTeam: "FE", title: "Claimed only" });
    expect((await callApi(install, oauthTokenOf(mert, METADATA_DOCUMENT, "mcp"), "POST", "/api/v1/requests/FE-2/claim")).status).toBe(200);
    await happenedAt(T0 + 20 * MINUTE);
    // FE-3: claimed and started by Deniz in the web UI.
    await openRequestInTheWebUi(install, selin, { targetTeam: "FE", title: "Started in the web UI" });
    await inTheWebUi(deniz, "requests.claim", { key: "FE-3" });
    await inTheWebUi(deniz, "requests.set_status", { key: "FE-3", state: "in_progress" });
    await happenedAt(T0 + 20 * MINUTE);
    clock = new Date(T0 + 21 * MINUTE);
    const claimed = await activity("FE-2");
    expect(claimed.lastWrite?.actor.kind).toBe("agent");
    expect(claimed.agentAtWork).toBe(false);
    const started = await activity("FE-3");
    expect(started.request.state).toBe("in_progress");
    expect(started.lastWrite).toEqual({ at: new Date(T0 + 20 * MINUTE).toISOString(), actor: { kind: "web", user: { id: deniz, login: "deniz", kind: "human", bot: false }, client: null } });
    expect(started.agentAtWork).toBe(false);
  });

  it("names who posted each message of the thread, as the timeline names them", async () => {
    clock = new Date(T0 + 4 * MINUTE + 40_000);
    const read = await activity("FE-1");
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM messages WHERE request_id = $1 ORDER BY number", [read.request.id]);
    expect(read.authors.map(({ messageId }) => messageId)).toEqual(rows.map(({ id }) => id));
    expect(read.authors.map(({ actor }) => actor)).toEqual([
      {
        kind: "agent",
        user: { id: mert, login: "mert", kind: "human", bot: false },
        client: { kind: "metadata_document", host: "client.example.com", version: null, unverified: false, untrusted: { name: "Example Agent" } },
      },
      { kind: "web", user: { id: selin, login: "selin", kind: "human", bot: false }, client: null },
    ]);
  });

  it("names each kind of client as the live hall does, cutting a name to 40 characters", async () => {
    await openRequestInTheWebUi(install, selin, { targetTeam: "FE", title: "Many clients" });
    const registered = randomUUID();
    const unnamed = randomUUID();
    const long = randomUUID();
    await addClient(registered, "Claude Code", false);
    await addClient(unnamed, null, false);
    await addClient(long, "An agent client whose name runs on far past forty characters", false);
    const cli = { ...oauthTokenOf(deniz, "tiehall-cli", "cli"), cliVersion: "0.4.0" };
    const cases: [Parameters<typeof callApi>[1], unknown, string][] = [
      [oauthTokenOf(deniz, registered, "mcp"), { kind: "registered", host: null, version: null, unverified: true, untrusted: { name: "Claude Code" } }, "Claude Code (unverified)"],
      [oauthTokenOf(deniz, unnamed, "mcp"), { kind: "registered", host: null, version: null, unverified: true, untrusted: { name: null } }, "unnamed client (unverified)"],
      [cli, { kind: "cli", host: null, version: "0.4.0", unverified: false, untrusted: { name: null } }, "tiehall CLI 0.4.0"],
      [oauthTokenOf(deniz, "tiehall-cli", "cli"), { kind: "cli", host: null, version: null, unverified: false, untrusted: { name: null } }, "tiehall CLI"],
      [tokenOf(deniz), { kind: "personal_access_token", host: null, version: null, unverified: false, untrusted: { name: null } }, "personal access token"],
    ];
    for (const [caller, client, words] of cases) {
      await comment(caller, "FE-4");
      const read = await activity("FE-4");
      expect(read.lastWrite?.actor).toMatchObject({ kind: "agent", user: { login: "deniz" }, client });
      expect(clientWords(read.lastWrite?.actor.client as never), words).toBe(words);
    }
    await comment(oauthTokenOf(deniz, long, "mcp"), "FE-4");
    const name = (await activity("FE-4")).lastWrite?.actor.client?.untrusted.name ?? "";
    expect(name.length).toBe(40);
    expect(name.startsWith("An agent client whose name runs on far")).toBe(true);
  });

  it("names a system action as Tiehall's, an integration's as GitHub's or Jira's, and an operator's as the operator's, none of them as the last writer", async () => {
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM requests WHERE number = 4");
    const requestId = rows[0]?.id ?? "";
    const before = (await activity("FE-4")).lastWrite;
    await withOrg(install.db, async (context) => {
      await appendEvent(context, requestProviderChangeShipped, { requestId }, { actorKind: "system", surface: "github" });
      const change = { requestId, mirrorId: randomUUID(), trackerChangeId: randomUUID(), change: "reopened" } as const;
      await appendEvent(context, requestTrackerChanged, change, { actorKind: "integration", surface: "github" });
      await appendEvent(context, requestTrackerChanged, change, { actorKind: "integration", surface: "jira" });
      await appendEvent(context, requestNeedsHumanCleared, { requestId }, { actorKind: "operator", command: "setup reopen" });
    });
    const read = await activity("FE-4");
    expect(read.events.slice(0, 4).map(({ actor }) => [actor.kind, actorWords(actor as never), actor.user, actor.client])).toEqual([
      ["operator", "the operator", null, null],
      ["jira", "Jira", null, null],
      ["github", "GitHub", null, null],
      ["tiehall", "Tiehall", null, null],
    ]);
    expect(read.lastWrite).toEqual(before);
  });

  it("lists only the 20 latest events, newest first", async () => {
    await openRequestInTheWebUi(install, selin, { targetTeam: "FE", title: "A busy request" });
    for (let index = 0; index < 25; index += 1) await inTheWebUi(deniz, "messages.post", { key: "FE-5", kind: "comment", body: MARKER });
    const { rows } = await install.owner.query<{ number: string }>("SELECT number FROM events WHERE data->>'requestId' = (SELECT id::text FROM requests WHERE number = 5) ORDER BY number DESC LIMIT 20");
    const read = await activity("FE-5");
    expect(read.events.map(({ number }) => number)).toEqual(rows.map(({ number }) => Number(number)));
    expect(read.events.every(({ type, state }) => type === "request.message_posted" && state === "open")).toBe(true);
  });

  it("holds no text of the thread or the packet", async () => {
    for (const key of ["FE-1", "FE-2", "FE-3", "FE-4", "FE-5"]) expect(JSON.stringify(await activity(key))).not.toContain("MARKER-5f2c9a");
  });

  it("refuses a removed member with 403 and a key that names no request with 404", async () => {
    const removed = sessionOf(await addUser(install.owner, { login: "lee", role: null }));
    await expect(install.execute("requests.activity", removed, { key: "FE-1" }, { readOnly: true })).rejects.toMatchObject({ reason: "removed-member" });
    await expect(install.execute("requests.activity", reader, { key: "FE-99" }, { readOnly: true })).rejects.toMatchObject({ reason: "record-not-found" });
  });

  it("drops the characters that hide or reverse text from a client's name, so the name cannot disguise the mark or the host beside it", async () => {
    // A request of its own, since a run of agent writes on one request would flag it needs_human.
    await openRequestInTheWebUi(install, selin, { targetTeam: "FE", title: "Disguised clients" });
    const reversed = randomUUID();
    const invisible = randomUUID();
    const spoofed = "https://moc.tfosorcim.ai/tiehall.json";
    // U+202E reverses what follows it, the mark included; U+2066 to U+2069 isolate, U+200B to U+200F and U+FEFF hide.
    await addClient(reversed, "‮edoc edualC", false);
    await addClient(invisible, "​⁦﻿⁩", false);
    await addClient(spoofed, "⁧tolipoc⁩‏", true);
    const cases: [string, string | null, string][] = [
      [reversed, "edoc edualC", "edoc edualC (unverified)"],
      [invisible, null, "unnamed client (unverified)"],
      [spoofed, "tolipoc", "tolipoc (moc.tfosorcim.ai)"],
    ];
    for (const [clientId, name, words] of cases) {
      await comment(oauthTokenOf(deniz, clientId, "mcp"), "FE-6");
      const read = await activity("FE-6");
      expect(read.lastWrite?.actor.client?.untrusted.name, words).toBe(name);
      expect(clientWords(read.lastWrite?.actor.client as never)).toBe(words);
      expect(JSON.stringify(read)).not.toMatch(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/u);
    }
  });

  it("is offered by no agent surface: neither the OpenAPI document nor the MCP tools name it", () => {
    for (const file of ["../../../openapi/v1.json", "../../../mcp/tools.json"]) {
      expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"), file).not.toMatch(/requests\.activity|requestActivity/);
    }
  });
});

describe("the read's query plan", () => {
  it("reads a request's latest events through events_request_number on a log of 10,000 events", async () => {
    const { rows } = await install.owner.query<{ id: string; org_id: string }>("SELECT id, org_id FROM requests WHERE number = 1");
    const { id: requestId, org_id: orgId } = rows[0] ?? { id: "", org_id: "" };
    // 10,000 events about 500 other requests, after the ones the tests made.
    await install.owner.query(
      `INSERT INTO events (org_id, number, class, type, data, actor_kind)
       SELECT $1, (SELECT max(number) FROM events) + n, 'domain', 'request.provider_change_shipped',
              jsonb_build_object('requestId', md5((n % 500)::text)::uuid::text), 'system'
         FROM generate_series(1, 10000) AS n`,
      [orgId],
    );
    await install.owner.query("ANALYZE events");
    for (const query of requestActivityQueries(install.db, orgId, requestId)) {
      const { sql, params } = query.toSQL();
      const plan = await install.owner.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      expect(JSON.stringify(plan.rows[0]?.["QUERY PLAN"]), sql).toContain("events_request_number");
    }
  });
});

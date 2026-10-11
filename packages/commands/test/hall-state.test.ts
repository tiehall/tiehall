import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inviteCreated, requestNeedsHumanCleared, requestStateChanged, requestTrackerChanged } from "@tiehall/core";
import { appendEvent } from "../src/append-event.ts";
import { actorWords, clientWords } from "../src/event-lines.ts";
import { hallQueries } from "../src/hall.ts";
import { withOrg, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, openRequestInTheWebUi, sessionOf, tokenOf } from "./support/requests.ts";

// The live hall's state (web-ui: The live hall; web-ui: What the live hall
// shows of the people and agents at work; activity-log: Security events are
// shown to admins only; design.md, Design: The live hall; D57 (11), (13)).
// hall.state answers the server's time and every team with its live requests
// by state and those done within the last 24 hours; one line per ordered pair
// of teams with live requests between them; the 200 most recently changed
// live requests; the people and agents at work within the last 10 minutes,
// from events recorded as agent or web_session only, one entry per user,
// actor kind and client, the 12 most recent marked for the map; and the 50
// latest domain events about requests in Tiehall's words, with the cursor.
// `team` and `agents` narrow it. No security event reaches it, for an admin
// either, and no text of a message or a packet. The clock is the test's own;
// each event's time is set to the moment the test says it happened.

/** Text seeded in the packets and the threads, which no answer may hold. */
const MARKER = "MARKER-8d41e7: text people wrote";
const EXAMPLE_AGENT = "https://client.example.com/tiehall.json";
const CLAUDE_CODE = randomUUID();
const T0 = Date.parse("2026-10-11T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let install: TestInstall;
let clock = new Date(T0);
const team: Record<string, string> = {};
const person: Record<string, string> = {};
/** The number of the last event the test has given a time. */
let stamped = 0;

interface Ref {
  id: string;
  key: string;
}

interface Actor {
  kind: string;
  user: { id: string; login: string; kind: "human"; bot: boolean } | null;
  client: { kind: string; host: string | null; version: string | null; unverified: boolean; untrusted: { name: string | null } } | null;
}

interface RequestRef {
  id: string;
  key: string;
  state: string;
  from: Ref;
  to: Ref;
  needsHuman: boolean;
  untrusted: { title: string };
}

interface Hall {
  now: string;
  cursor: number;
  teams: { id: string; key: string; counts: Record<string, number>; doneLastDay: number; untrusted: { name: string } }[];
  lines: { from: Ref; to: Ref; counts: Record<string, number> }[];
  requestLines: (RequestRef & { claimant: { login: string } | null; changedAt: string })[];
  atWork: { actor: Actor; at: string; type: string; line: string; team: Ref | null; request: RequestRef; waiting: boolean; onMap: boolean }[];
  feed: { seq: number; at: string; type: string; line: string; actor: Actor; team: Ref | null; request: RequestRef }[];
}

function id(login: string): string {
  const found = person[login];
  if (found === undefined) throw new Error(`No person ${login}.`);
  return found;
}

/** Gives every event appended since the last call this time, as the owner, past the append-only trigger. */
async function happenedAt(at: number): Promise<void> {
  await install.owner.query("BEGIN; SET LOCAL session_replication_role = replica");
  const { rows } = await install.owner.query<{ number: string }>("UPDATE events SET occurred_at = $1 WHERE number > $2 RETURNING number", [new Date(at), stamped]);
  await install.owner.query("COMMIT");
  stamped = Math.max(stamped, ...rows.map(({ number }) => Number(number)));
}

/** The live hall's state as this member reads it, narrowed as asked; no answer may hold the text people wrote. */
async function hall(input: { team?: string; agents?: boolean } = {}, caller: WebSessionCaller = sessionOf(id("carol"))): Promise<Hall> {
  const answer = (await install.execute("hall.state", caller, input, { readOnly: true })) as Hall;
  expect(JSON.stringify(answer)).not.toContain("MARKER-8d41e7");
  return answer;
}

/** Runs a write as the user in the web UI, from one of its pages; fails the test on a refusal. */
async function inTheWebUi(login: string, commandId: string, input: unknown): Promise<void> {
  const session = sessionOf(id(login));
  const result = await install.web(session).write(commandId, input, install.fromThePage(session));
  expect(result, commandId).toMatchObject({ ok: true });
}

/** Moves a request to done as a system action, as close on merge does. */
async function closeOnMerge(key: string): Promise<void> {
  const [teamKey, number] = key.split("-");
  const { rows } = await install.owner.query<{ id: string; state: string }>(
    "UPDATE requests SET state = 'done' FROM teams WHERE teams.id = requests.target_team_id AND teams.key = $1 AND requests.number = $2 RETURNING requests.id, requests.state",
    [teamKey, Number(number)],
  );
  const requestId = rows[0]?.id ?? "";
  await withOrg(install.db, (context) => appendEvent(context, requestStateChanged, { requestId, state: "done", previousState: "claimed" }, { actorKind: "system", surface: "github" }));
}

async function requestIdOf(key: string): Promise<string> {
  const [teamKey, number] = key.split("-");
  const { rows } = await install.owner.query<{ id: string }>("SELECT requests.id FROM requests JOIN teams ON teams.id = requests.target_team_id WHERE teams.key = $1 AND requests.number = $2", [teamKey, Number(number)]);
  return rows[0]?.id ?? "";
}

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  for (const [key, name] of [
    ["BE", "Backend"],
    ["FE", "Frontend"],
    ["OPS", "Operations"],
    ["PAY", "Payments"],
  ] as const) {
    team[key] = await addTeam(install.owner, key);
    await install.owner.query("UPDATE teams SET name = $2 WHERE id = $1", [team[key], name]);
  }
  for (const [login, teamKey, role] of [
    ["selin", "BE", "member"],
    ["mert", "FE", "member"],
    ["deniz", "FE", "member"],
    ["ayse", "PAY", "member"],
    ["carol", "OPS", "member"],
    ["pia", "FE", "admin"],
    ["lee", "OPS", "member"],
  ] as const) {
    person[login] = await addUser(install.owner, { login, role });
    await joinTeams(install.owner, id(login), team[teamKey] ?? "");
  }
  await install.owner.query(
    "INSERT INTO oauth_clients (org_id, client_id, name, client_discovery_id, redirect_uris) SELECT id, $1, 'Example Agent', 'cimd', ARRAY['https://client.example.com/callback'] FROM orgs",
    [EXAMPLE_AGENT],
  );
  await install.owner.query("INSERT INTO oauth_clients (org_id, client_id, name, redirect_uris) SELECT id, $1, 'Claude Code', ARRAY['http://127.0.0.1/callback'] FROM orgs", [CLAUDE_CODE]);
  const packet = { schema_version: "1-beta", kind: "request", untrusted: { need: MARKER, acceptance_criteria: [MARKER] } };

  // BE-1 and BE-2, which team FE opened: BE-1 closed on merge 30 hours ago, BE-2 2 hours ago.
  await openRequest(install, tokenOf(id("mert")), { targetTeam: "BE", title: "Rotate the signing keys", packet });
  await happenedAt(T0 - 50 * HOUR);
  await closeOnMerge("BE-1");
  await happenedAt(T0 - 30 * HOUR);
  await openRequest(install, tokenOf(id("mert")), { targetTeam: "BE", title: "Add a health check", packet });
  await happenedAt(T0 - 26 * HOUR);
  await closeOnMerge("BE-2");
  await happenedAt(T0 - 2 * HOUR);
  // FE-1, opened by Selin in the web UI, claimed by Mert's agent, which started work on it 3 minutes ago.
  await openRequestInTheWebUi(install, id("selin"), { targetTeam: "FE", title: "Add a forgot password link", packet });
  await happenedAt(T0 - 30 * MINUTE);
  const mertsAgent = oauthTokenOf(id("mert"), EXAMPLE_AGENT, "mcp");
  expect((await callApi(install, mertsAgent, "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
  await happenedAt(T0 - 20 * MINUTE);
  // FE-2, which Selin's token opened, and on which Deniz's token commented 11 minutes ago.
  await openRequest(install, tokenOf(id("selin")), { targetTeam: "FE", title: "Move the banner", packet });
  await happenedAt(T0 - 25 * MINUTE);
  expect((await callApi(install, tokenOf(id("deniz")), "POST", "/api/v1/requests/FE-2/messages", { kind: "comment", body: MARKER })).status).toBe(200);
  await happenedAt(T0 - 11 * MINUTE);
  // PAY-1, which Deniz opened in the web UI, claimed by Ayşe's agent, which asked a blocking question 2 minutes ago.
  await openRequestInTheWebUi(install, id("deniz"), { targetTeam: "PAY", title: "Send a refund webhook", packet });
  await happenedAt(T0 - 15 * MINUTE);
  const aysesAgent = oauthTokenOf(id("ayse"), CLAUDE_CODE, "mcp");
  expect((await callApi(install, aysesAgent, "POST", "/api/v1/requests/PAY-1/claim")).status).toBe(200);
  await happenedAt(T0 - 8 * MINUTE);
  expect((await callApi(install, mertsAgent, "POST", "/api/v1/requests/FE-1/status", { state: "in_progress" })).status).toBe(200);
  await happenedAt(T0 - 3 * MINUTE);
  expect((await callApi(install, aysesAgent, "POST", "/api/v1/requests/PAY-1/messages", { kind: "question", body: MARKER, blocking: true })).status).toBe(200);
  await happenedAt(T0 - 2 * MINUTE);
  // GitHub, Jira and the operator act on FE-1, and none of them is at work.
  const fe1 = await requestIdOf("FE-1");
  await withOrg(install.db, async (context) => {
    const change = { requestId: fe1, mirrorId: randomUUID(), trackerChangeId: randomUUID(), change: "reopened" } as const;
    await appendEvent(context, requestTrackerChanged, change, { actorKind: "integration", surface: "github" });
    await appendEvent(context, requestTrackerChanged, change, { actorKind: "integration", surface: "jira" });
    await appendEvent(context, requestNeedsHumanCleared, { requestId: fe1 }, { actorKind: "operator", command: "setup reopen" });
  });
  await happenedAt(T0 - 90_000);
  // Deniz comments on PAY-1 in the web UI a minute ago.
  await inTheWebUi("deniz", "messages.post", { key: "PAY-1", kind: "comment", body: MARKER });
  await happenedAt(T0 - MINUTE);
  // Security events: Pia makes Lee an admin, invites someone and removes Lee.
  const pia = sessionOf(id("pia"));
  expect((await install.confirm(pia, "members.change_role", { userId: id("lee"), role: "admin" })).status).toBe(200);
  await withOrg(install.db, (context) => appendEvent(context, inviteCreated, { inviteId: randomUUID(), role: "member" }, { actorKind: "web_session", userId: id("pia"), surface: "web" }));
  expect((await install.confirm(pia, "members.remove", { userId: id("lee") })).status).toBe(200);
  await happenedAt(T0 - 30_000);
}, 120_000);

afterAll(async () => {
  await install?.close();
});

describe("hall.state", () => {
  it("answers the server's time, and the cursor: the number of the newest domain event about a request", async () => {
    const state = await hall();
    expect(state.now).toBe(clock.toISOString());
    const { rows } = await install.owner.query<{ number: string }>("SELECT max(number) AS number FROM events WHERE class = 'domain' AND data ? 'requestId'");
    expect(state.cursor).toBe(Number(rows[0]?.number));
    const { rows: newest } = await install.owner.query<{ class: string }>("SELECT class FROM events ORDER BY number DESC LIMIT 1");
    expect(newest[0]?.class).toBe("security");
  });

  it("lists every team, by key, with its live requests by state and those done within the last 24 hours", async () => {
    const { teams } = await hall();
    expect(teams.map(({ key, untrusted, counts, doneLastDay }) => [key, untrusted.name, counts, doneLastDay])).toEqual([
      ["BE", "Backend", { open: 0, claimed: 0, in_progress: 0, needs_info: 0 }, 1],
      ["FE", "Frontend", { open: 1, claimed: 0, in_progress: 1, needs_info: 0 }, 0],
      ["OPS", "Operations", { open: 0, claimed: 0, in_progress: 0, needs_info: 0 }, 0],
      ["PAY", "Payments", { open: 0, claimed: 0, in_progress: 0, needs_info: 1 }, 0],
    ]);
    expect(teams.map(({ id }) => id)).toEqual([team["BE"], team["FE"], team["OPS"], team["PAY"]]);
  });

  it("counts a request done within the last 24 hours only while that is less than 24 hours ago", async () => {
    clock = new Date(T0 + 22 * HOUR - MINUTE);
    expect((await hall()).teams.find(({ key }) => key === "BE")?.doneLastDay).toBe(1);
    clock = new Date(T0 + 22 * HOUR + MINUTE);
    expect((await hall()).teams.find(({ key }) => key === "BE")?.doneLastDay).toBe(0);
    clock = new Date(T0);
  });

  it("has one line per ordered pair of teams with live requests between them, from the requesting team to the target team, with counts by state", async () => {
    const { lines } = await hall();
    const shown = lines.map(({ from, to, counts }) => [from.key, to.key, counts]).sort((a, b) => String(a).localeCompare(String(b)));
    expect(shown).toEqual([
      ["BE", "FE", { open: 1, claimed: 0, in_progress: 1, needs_info: 0 }],
      ["FE", "PAY", { open: 0, claimed: 0, in_progress: 0, needs_info: 1 }],
    ]);
    expect(lines.find(({ to }) => to.key === "PAY")?.from.id).toBe(team["FE"]);
  });

  it("lists the live requests, the most recently changed first, with id, key, title, state, teams, claimant and needsHuman", async () => {
    const { requestLines } = await hall();
    expect(requestLines.map(({ key }) => key)).toEqual(["PAY-1", "FE-1", "FE-2"]);
    const [pay1, fe1, fe2] = requestLines;
    expect(pay1).toEqual({
      id: await requestIdOf("PAY-1"),
      key: "PAY-1",
      state: "needs_info",
      from: { id: team["FE"], key: "FE" },
      to: { id: team["PAY"], key: "PAY" },
      claimant: { id: id("ayse"), login: "ayse", kind: "human", bot: false },
      needsHuman: false,
      changedAt: new Date(T0 - MINUTE).toISOString(),
      untrusted: { title: "Send a refund webhook" },
    });
    expect(fe1).toMatchObject({ state: "in_progress", claimant: { login: "mert" }, changedAt: new Date(T0 - 90_000).toISOString() });
    expect(fe2).toMatchObject({ state: "open", claimant: null, changedAt: new Date(T0 - 11 * MINUTE).toISOString(), untrusted: { title: "Move the banner" } });
  });

  it("names the people and agents at work within the last 10 minutes, from agent and web_session events only, one per user, kind and client, the most recent first", async () => {
    const { atWork } = await hall();
    expect(atWork.map(({ actor, request, line, at }) => [actorWords(actor as never), actor.client === null ? null : clientWords(actor.client as never), request.key, line, at])).toEqual([
      ["deniz", null, "PAY-1", "A comment was posted", new Date(T0 - MINUTE).toISOString()],
      ["ayse's agent", "Claude Code (unverified)", "PAY-1", "A blocking question was posted", new Date(T0 - 2 * MINUTE).toISOString()],
      ["mert's agent", "Example Agent (client.example.com)", "FE-1", "Work on it started", new Date(T0 - 3 * MINUTE).toISOString()],
    ]);
    expect(atWork.map(({ actor }) => actor.kind)).toEqual(["web", "agent", "agent"]);
    expect(atWork[1]?.request).toMatchObject({ state: "needs_info", from: { key: "FE" }, to: { key: "PAY" }, untrusted: { title: "Send a refund webhook" } });
    expect(atWork.map(({ team }) => team?.key)).toEqual(["FE", "PAY", "FE"]);
    expect(atWork.every(({ onMap }) => onMap)).toBe(true);
    // Ayşe's agent asked the blocking question that PAY-1 still waits on.
    expect(atWork.map(({ waiting }) => waiting)).toEqual([false, true, false]);
  });

  it("drops a person or an agent 10 minutes after their latest event", async () => {
    clock = new Date(T0 + 7 * MINUTE - 1000);
    expect((await hall()).atWork.map(({ request }) => request.key)).toEqual(["PAY-1", "PAY-1", "FE-1"]);
    clock = new Date(T0 + 7 * MINUTE + 1000);
    expect((await hall()).atWork.map(({ actor }) => actorWords(actor as never))).toEqual(["deniz", "ayse's agent"]);
    clock = new Date(T0);
  });

  it("lists the latest domain events about requests, newest first, in Tiehall's words, with who acted, the team they acted for, and the request", async () => {
    const { feed, cursor } = await hall();
    expect(feed[0]?.seq).toBe(cursor);
    expect(feed.map(({ seq }) => seq)).toEqual([...feed.map(({ seq }) => seq)].sort((a, b) => b - a));
    expect(feed.slice(0, 7).map(({ type, line, actor, request }) => [request.key, type, line, actorWords(actor as never)])).toEqual([
      ["PAY-1", "request.message_posted", "A comment was posted", "deniz"],
      ["FE-1", "request.needs_human_cleared", expect.any(String), "the operator"],
      ["FE-1", "request.tracker_changed", expect.any(String), "Jira"],
      ["FE-1", "request.tracker_changed", expect.any(String), "GitHub"],
      ["PAY-1", "request.state_changed", "It moved from claimed to needs info", "ayse's agent"],
      ["PAY-1", "request.message_posted", "A blocking question was posted", "ayse's agent"],
      ["FE-1", "request.started", "Work on it started", "mert's agent"],
    ]);
    expect(feed[6]).toMatchObject({ at: new Date(T0 - 3 * MINUTE).toISOString(), team: { id: team["FE"], key: "FE" }, request: { id: await requestIdOf("FE-1"), state: "in_progress" } });
    expect(feed[1]?.team).toBeNull();
    const done = feed.filter(({ type, request }) => type === "request.state_changed" && request.state === "done");
    expect(done.map(({ request, actor }) => [request.key, actorWords(actor as never)])).toEqual([
      ["BE-2", "Tiehall"],
      ["BE-1", "Tiehall"],
    ]);
  });

  it("narrows to one team: its lines, and the requests, people, agents and events on them, with every team still listed", async () => {
    const fe = await hall({ team: "FE" });
    expect(fe.teams.map(({ key }) => key)).toEqual(["BE", "FE", "OPS", "PAY"]);
    expect(fe.lines.map(({ from, to }) => `${from.key}>${to.key}`).sort()).toEqual(["BE>FE", "FE>PAY"]);
    expect(fe.requestLines.map(({ key }) => key)).toEqual(["PAY-1", "FE-1", "FE-2"]);
    expect(fe.atWork.map(({ request }) => request.key)).toEqual(["PAY-1", "PAY-1", "FE-1"]);
    const be = await hall({ team: "BE" });
    expect(be.lines.map(({ from, to }) => `${from.key}>${to.key}`)).toEqual(["BE>FE"]);
    expect(be.requestLines.map(({ key }) => key)).toEqual(["FE-1", "FE-2"]);
    expect(be.atWork.map(({ request }) => request.key)).toEqual(["FE-1"]);
    expect(new Set(be.feed.map(({ request }) => request.key))).toEqual(new Set(["FE-1", "FE-2", "BE-1", "BE-2"]));
    const ops = await hall({ team: "OPS" });
    expect([ops.lines, ops.requestLines, ops.atWork, ops.feed]).toEqual([[], [], [], []]);
    expect(ops.teams).toHaveLength(4);
  });

  it("narrows the people at work and the feed to what agents did", async () => {
    const agents = await hall({ agents: true });
    expect(agents.atWork.map(({ actor }) => actorWords(actor as never))).toEqual(["ayse's agent", "mert's agent"]);
    expect(agents.feed.length).toBeGreaterThan(0);
    expect(agents.feed.every(({ actor }) => actor.kind === "agent")).toBe(true);
    expect(agents.lines).toEqual((await hall()).lines);
  });

  it("refuses a team that does not exist with 404", async () => {
    await expect(install.execute("hall.state", sessionOf(id("carol")), { team: "NOPE" }, { readOnly: true })).rejects.toMatchObject({ reason: "record-not-found" });
  });

  it("shows no security event to any member, an admin included, after a role change, an invite and a removal", async () => {
    for (const reader of ["carol", "pia"]) {
      const state = await hall({}, sessionOf(id(reader)));
      expect(state.feed.filter(({ type }) => !type.startsWith("request.") && !type.startsWith("proposal."))).toEqual([]);
      expect(JSON.stringify(state)).not.toMatch(/member\.|invite\.|"lee"/);
    }
  });

  it("marks the 12 most recent people and agents at work for the map, and lists every one", async () => {
    for (let index = 0; index < 11; index += 1) {
      person[`helper-${index}`] = await addUser(install.owner, { login: `helper-${index}` });
      await joinTeams(install.owner, id(`helper-${index}`), team["FE"] ?? "");
      await inTheWebUi(`helper-${index}`, "messages.post", { key: "FE-2", kind: "comment", body: MARKER });
      await happenedAt(T0 - 20_000 + index * 1000);
    }
    const { atWork } = await hall();
    expect(atWork).toHaveLength(14);
    expect(atWork.slice(0, 3).map(({ actor }) => actor.user?.login)).toEqual(["helper-10", "helper-9", "helper-8"]);
    expect(atWork.map(({ onMap }) => onMap)).toEqual([...Array(12).fill(true), false, false]);
    expect(atWork.slice(0, 11).every(({ actor }) => actor.kind === "web")).toBe(true);
  });

  it("lists at most the 50 latest events", async () => {
    for (let index = 0; index < 30; index += 1) await inTheWebUi("deniz", "messages.post", { key: "PAY-1", kind: "comment", body: MARKER });
    await happenedAt(T0 - 5_000);
    const { feed } = await hall();
    const { rows } = await install.owner.query<{ number: string }>("SELECT number FROM events WHERE class = 'domain' AND data ? 'requestId' ORDER BY number DESC LIMIT 50");
    expect(feed.map(({ seq }) => seq)).toEqual(rows.map(({ number }) => Number(number)));
  });

  it("holds no text of a thread or a packet", async () => {
    for (const input of [{}, { team: "FE" }, { agents: true }]) expect(JSON.stringify(await hall(input))).not.toContain("MARKER-8d41e7");
  });

  it("refuses a removed member with 403", async () => {
    await expect(install.execute("hall.state", sessionOf(id("lee")), {}, { readOnly: true })).rejects.toMatchObject({ reason: "removed-member" });
  });

  it("is offered by no agent surface: neither the OpenAPI document nor the MCP tools name it", () => {
    for (const file of ["../../../openapi/v1.json", "../../../mcp/tools.json"]) {
      expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"), file).not.toMatch(/\bhall\.(state|wait)\b|readHall|waitForHall/);
    }
  });
});

describe("the read's query plans", () => {
  it("read the events by time through events_domain_occurred_at and each request's last change through events_request_number, on a log of 10,000 events", async () => {
    const { rows } = await install.owner.query<{ org_id: string }>("SELECT id AS org_id FROM orgs");
    const orgId = rows[0]?.org_id ?? "";
    // 10,000 events about 500 other requests, after the ones the tests made, one every 4 minutes back from now.
    await install.owner.query(
      `INSERT INTO events (org_id, number, occurred_at, class, type, data, actor_kind)
       SELECT $1, (SELECT max(number) FROM events) + n, $2::timestamptz - n * interval '4 minutes', 'domain', 'request.provider_change_shipped',
              jsonb_build_object('requestId', md5((n % 500)::text)::uuid::text), 'system'
         FROM generate_series(1, 10000) AS n`,
      [orgId, clock],
    );
    await install.owner.query("ANALYZE events");
    const plans: Record<string, string> = {};
    for (const [name, query] of Object.entries(hallQueries(orgId, clock, { teamId: undefined, agents: false }))) {
      const plan = await install.db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
      plans[name] = JSON.stringify(plan.rows);
    }
    expect(plans["atWork"]).toContain('"Index Name":"events_domain_occurred_at"');
    expect(plans["requestLines"]).toContain('"Index Name":"events_request_number"');
    // The requests done within the last 24 hours, through either index, as the planner finds the fewer rows.
    expect(plans["done"]).toMatch(/"Index Name":"events_(domain_occurred_at|request_number)"/);
    // No read of the event log scans it whole.
    for (const [name, plan] of Object.entries(plans)) expect(plan, name).not.toMatch(/"Node Type":"Seq Scan"[^}]*"Relation Name":"events"/);
  });
});

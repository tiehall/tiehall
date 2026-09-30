import { CATALOG, toolReadsOnly } from "@tiehall/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storePacketRevision, write, type Store } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Runaway agent loops flag the request needs_human (agent-safety: Runaway
// agent loops flag the request needs_human; public-api: One error model for
// Tiehall's own refusals; design.md, Decisions this change rests on: D28 #50,
// D30 (1), (4); design.md, Self-hosting decisions: S7). Tiehall counts the
// agent writes on each request since the last human action on it, meaning
// writes made with an OAuth token or a personal access token. The write that
// makes 7 within 10 minutes, or the thirtieth in total, is accepted and flags
// the request; until a person posts a message on it in the web UI, every agent
// write to it gets 409 needs-human and is not counted. Writes by the system, an
// integration or a web session are neither counted nor refused, nor are
// acknowledgements and reads. The count is decided in the writing transaction,
// so two writes at once cannot both pass the limit. The flag is checked last,
// after the caller's side, the request's state and If-Match, and a message
// edited from a web session is no human action: it leaves the flag and the
// counts as they are (design.md, Decisions: D46 (6), (7)).

let clock = new Date("2026-10-01T08:59:00Z");
/** Sets the clock to a time of 2026-10-01 (UTC), such as 09:04:30. */
const at = (time: string) => {
  clock = new Date(`2026-10-01T${time}Z`);
};
/** count times from start, step seconds apart, such as 09:00:00, 09:00:40, … */
function times(start: string, count: number, stepSeconds: number): string[] {
  const first = new Date(`2026-10-01T${start}Z`).getTime();
  return Array.from({ length: count }, (_, index) => new Date(first + index * stepSeconds * 1000).toISOString().slice(11, 19));
}

let install: TestInstall;
let store: Store;
let alice: string;
let bob: string;
let carol: string;
let erin: string;
/** The request each test acts on, which Alice of team BE opens to team FE before it. */
let key: string;
let requestId: string;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  store = { database: install.db, jobs: { send: async () => {} } };
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const ops = await addTeam(install.owner, "OPS");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  carol = await addUser(install.owner, { login: "carol" });
  erin = await addUser(install.owner, { login: "erin" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, carol, ops);
  await joinTeams(install.owner, erin, fe);
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  at("08:59:00");
  const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  key = opened.key;
  requestId = opened.id;
});

const comment = (user: string, on = key) =>
  callApi(install, tokenOf(user), "POST", `/api/v1/requests/${on}/messages`, { kind: "comment", body: "Any news on this?" });

/** Agents of Alice and Bob, taking turns, each post a comment at each of these times; returns the answers' statuses. */
async function agentWrites(at_: readonly string[], on = key): Promise<number[]> {
  const statuses: number[] = [];
  for (const [index, time] of at_.entries()) {
    at(time);
    statuses.push((await comment(index % 2 === 0 ? alice : bob, on)).status);
  }
  return statuses;
}

async function flagged(id = requestId): Promise<boolean> {
  const { rows } = await install.owner.query<{ needs_human: boolean }>("SELECT needs_human FROM requests WHERE id = $1", [id]);
  return rows[0]?.needs_human ?? false;
}

async function messages(id = requestId): Promise<number> {
  const { rows } = await install.owner.query<{ count: string }>("SELECT count(*) FROM messages WHERE request_id = $1", [id]);
  return Number(rows[0]?.count);
}

/** Flags the request with 7 agent writes between 09:00:00 and 09:04:00. */
async function flag(): Promise<void> {
  expect(await agentWrites(times("09:00:00", 7, 40))).toEqual([200, 200, 200, 200, 200, 200, 200]);
  expect(await flagged()).toBe(true);
}

const NEEDS_HUMAN = "https://tiehall.com/problems/needs-human";

describe("counting agent writes", () => {
  it("lets an ordinary exchange over an hour through, never more than 4 within 10 minutes", async () => {
    for (const time of times("09:00:00", 10, 360)) {
      at(time);
      const asked = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/messages`, { kind: "question", body: "Which browsers?" });
      expect(asked.status).toBe(200);
      at(new Date(new Date(`2026-10-01T${time}Z`).getTime() + 180_000).toISOString().slice(11, 19));
      const answered = await callApi(install, tokenOf(alice), "POST", `/api/v1/requests/${key}/messages`, {
        kind: "answer",
        body: "The last two versions of each.",
        questionId: asked.body.message.id,
      });
      expect(answered.status).toBe(200);
    }
    expect(await messages()).toBe(20);
    expect(await flagged()).toBe(false);
  });

  it("accepts the seventh write within 10 minutes and flags the request with it; the next agent write gets 409 needs-human", async () => {
    await flag();
    at("09:04:30");
    const refused = await comment(alice);
    expect(refused).toMatchObject({ status: 409, body: { type: NEEDS_HUMAN, status: 409 } });
    expect(await messages()).toBe(7);
  });

  it("does not flag six writes within 10 minutes and a seventh at 09:12", async () => {
    expect(await agentWrites([...times("09:00:00", 6, 60), "09:12:00"])).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(await flagged()).toBe(false);
  });

  it("counts a write exactly 10 minutes after the first within its window, and one a second later outside it", async () => {
    expect(await agentWrites(["09:00:00", ...times("09:05:00", 5, 0), "09:10:00"])).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(await flagged()).toBe(true);
    const other = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect(await agentWrites(["09:00:00", ...times("09:05:00", 5, 0), "09:10:01"], other.key)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(await flagged(other.id)).toBe(false);
  });

  it("accepts the thirtieth write in total and flags the request with it; the thirty-first gets 409", async () => {
    const statuses = await agentWrites(times("09:00:00", 29, 600));
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(await flagged()).toBe(false);
    expect(await agentWrites(["13:50:00"])).toEqual([200]);
    expect(await flagged()).toBe(true);
    at("13:55:00");
    expect((await comment(bob)).body.type).toBe(NEEDS_HUMAN);
  });

  it("lets exactly one of two writes at the same moment through when they would pass the limit", async () => {
    expect(await agentWrites(times("09:00:00", 6, 30))).toEqual([200, 200, 200, 200, 200, 200]);
    at("09:03:00");
    const answers = await Promise.all([comment(alice), comment(bob)]);
    expect(answers.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(answers.find(({ status }) => status === 409)?.body.type).toBe(NEEDS_HUMAN);
    expect(await messages()).toBe(7);
    expect(await flagged()).toBe(true);
  });

  it("counts only the writes on the same request", async () => {
    const other = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    for (const time of times("09:00:00", 6, 40)) {
      expect(await agentWrites([time])).toEqual([200]);
      expect(await agentWrites([time], other.key)).toEqual([200]);
    }
    expect([await flagged(), await flagged(other.id)]).toEqual([false, false]);
  });

  it("counts no read or acknowledgement: after six writes, reads and an acknowledgement, only the seventh write flags the request", async () => {
    expect(await agentWrites(times("09:00:00", 6, 30))).toEqual([200, 200, 200, 200, 200, 200]);
    at("09:03:00");
    const token = tokenOf(bob);
    for (const path of [`/api/v1/requests/${key}`, `/api/v1/requests/${key}/packet`, "/api/v1/requests"]) {
      expect((await callApi(install, token, "GET", path)).status, path).toBe(200);
    }
    const read = await callApi(install, token, "GET", "/api/v1/events?limit=500");
    expect(await callApi(install, token, "POST", "/api/v1/events/acknowledge", { upTo: read.body.events.at(-1).number })).toMatchObject({ status: 200 });
    expect(await flagged()).toBe(false);
    expect(await agentWrites(["09:04:00"])).toEqual([200]);
    expect(await flagged()).toBe(true);
  });

  it("counts no refused write", async () => {
    at("09:00:00");
    for (let attempt = 0; attempt < 10; attempt++) expect((await comment(carol)).status).toBe(403);
    expect((await callApi(install, tokenOf(alice), "POST", `/api/v1/requests/${key}/claim`)).status).toBe(403);
    expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/status`, { state: "in_progress" })).status).toBe(409);
    expect(await agentWrites(times("09:01:00", 6, 30))).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await flagged()).toBe(false);
  });
});

describe("a flagged request", () => {
  it("refuses every agent write on it with 409 needs-human, and changes nothing", async () => {
    at("09:00:00");
    expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/claim`)).status).toBe(200);
    at("09:00:10");
    const bobs = await comment(bob);
    expect(await agentWrites(times("09:00:20", 5, 30))).toEqual([200, 200, 200, 200, 200]);
    expect(await flagged()).toBe(true);
    // An unclaimed request, flagged too, for the claim, which a claimed one refuses as a state conflict first.
    const unclaimed = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect(await agentWrites(times("09:00:00", 7, 30), unclaimed.key)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    at("09:05:00");
    const writes = {
      "messages.post": () => comment(alice),
      "messages.edit": () => callApi(install, tokenOf(bob), "POST", `/api/v1/messages/${bobs.body.message.id}/versions`, { body: "Edited." }),
      "requests.claim": () => callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${unclaimed.key}/claim`),
      "requests.set_status": () => callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/status`, { state: "in_progress" }),
      "requests.propose": () => callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/proposals`, { kind: "reassign", team: "BE" }),
      "requests.link_pr": () => callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/pull-requests`, { url: "https://github.com/acme/web/pull/88" }),
      "packets.add_revision": () =>
        sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${key}/packet/revisions`, {
          // A new link only, which changes no scope, so it would be no commitment on the claimed request.
          body: { packet: { ...packetOf(), untrusted: { ...(packetOf()["untrusted"] as object), links: [{ url: "https://design.example.com/dark" }] } } },
          headers: { "if-match": '"1"' },
        }),
    };
    // Every write an agent surface offers is here, or is one that writes on no existing request.
    const writesOnNoRequest = {
      "requests.create": "opens a request, which the caps on opened requests limit instead",
      "events.acknowledge": "moves a read cursor, which is no write on a request",
    };
    // An operation that only reads, such as get_request, which MCP alone offers, is no write.
    const agentWrites_ = CATALOG.commands
      .filter((definition) => definition.surfaces.length > 0 && !toolReadsOnly(definition))
      .map(({ id }) => id)
      .sort();
    expect([...Object.keys(writes), ...Object.keys(writesOnNoRequest)].sort()).toEqual(agentWrites_);
    for (const [operation, send] of Object.entries(writes)) {
      const answer = await send();
      expect({ operation, status: answer.status, type: answer.body.type }).toEqual({ operation, status: 409, type: NEEDS_HUMAN });
    }
    const { rows } = await install.owner.query<{ state: string; revisions: string; versions: string }>(
      `SELECT r.state, (SELECT count(*) FROM packet_revisions WHERE request_id = r.id) AS revisions,
              (SELECT count(*) FROM message_versions WHERE message_id = $2) AS versions FROM requests r WHERE r.id = $1`,
      [requestId, bobs.body.message.id],
    );
    expect(rows[0]).toEqual({ state: "claimed", revisions: "1", versions: "1" });
    expect(await messages()).toBe(6);
    expect((await callApi(install, tokenOf(carol), "GET", `/api/v1/requests/${unclaimed.key}`)).body).toMatchObject({ state: "open", claimant: null });
  });

  it("is cleared by a message a member posts in the web UI, which restarts both counts", async () => {
    expect((await agentWrites(times("09:00:00", 30, 600))).every((status) => status === 200)).toBe(true);
    expect(await flagged()).toBe(true);
    at("14:00:00");
    const session = sessionOf(alice);
    const posted = await install.web(session).write("messages.post", { key, kind: "comment", body: "Let us talk first." }, install.fromThePage(session));
    expect(posted.ok).toBe(true);
    expect(await flagged()).toBe(false);
    expect(await agentWrites(times("14:01:00", 6, 60))).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await flagged()).toBe(false);
    expect(await agentWrites(["14:07:00"])).toEqual([200]);
    expect(await flagged()).toBe(true);
  });

  it("stays flagged when a member edits their message in the web UI, which adds its version and changes neither count", async () => {
    at("09:00:00");
    const bobs = await comment(bob);
    expect(bobs.status).toBe(200);
    expect(await agentWrites(times("09:00:30", 6, 30))).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await flagged()).toBe(true);
    const counts = async () =>
      (await install.owner.query("SELECT agent_write_times::text AS writes, needs_human FROM requests WHERE id = $1", [requestId])).rows[0];
    const before = await counts();
    at("09:05:00");
    const session = sessionOf(bob);
    const edited = await install.web(session).write(
      "messages.edit",
      { messageId: bobs.body.message.id, body: "Any news on this? Asked again." },
      install.fromThePage(session),
    );
    expect(edited).toMatchObject({ ok: true, output: { id: bobs.body.message.id, version: 2 } });
    expect(await counts()).toEqual(before);
    expect(await comment(alice)).toMatchObject({ status: 409, body: { type: NEEDS_HUMAN } });
    const posted = await install.web(session).write("messages.post", { key, kind: "comment", body: "Let us talk first." }, install.fromThePage(session));
    expect(posted.ok).toBe(true);
    expect(await flagged()).toBe(false);
  });

  it("stays flagged when a claim and a state change made in the web UI are applied", async () => {
    await flag();
    at("09:05:00");
    const session = sessionOf(bob);
    expect((await install.web(session).write("requests.claim", { key }, install.fromThePage(session))).ok).toBe(true);
    expect((await install.web(session).write("requests.set_status", { key, state: "in_progress" }, install.fromThePage(session))).ok).toBe(true);
    expect((await callApi(install, tokenOf(carol), "GET", `/api/v1/requests/${key}`)).body.state).toBe("in_progress");
    expect(await flagged()).toBe(true);
  });

  it("takes system and integration writes, which are neither counted nor refused", async () => {
    await flag();
    const packet = packetOf("A revision from a contract report.") as never;
    await write(store, { actorKind: "system", surface: "github" }, (writer) => storePacketRevision(writer, requestId, packet));
    await write(store, { actorKind: "integration", surface: "jira" }, (writer) => storePacketRevision(writer, requestId, packet));
    expect(await flagged()).toBe(true);

    const other = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect(await agentWrites(times("09:00:00", 6, 30), other.key)).toEqual([200, 200, 200, 200, 200, 200]);
    await write(store, { actorKind: "system", surface: "github" }, (writer) => storePacketRevision(writer, other.id, packet));
    await write(store, { actorKind: "integration", surface: "jira" }, (writer) => storePacketRevision(writer, other.id, packet));
    expect(await flagged(other.id)).toBe(false);
    expect(await agentWrites(["09:04:00"], other.key)).toEqual([200]);
    expect(await flagged(other.id)).toBe(true);
  });

  it("refuses a write for the flag only after its side, the request's state and If-Match allow it, and counts none of the refusals", async () => {
    at("09:00:00");
    expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/claim`)).status).toBe(200);
    // A new link only, which changes no scope, so the claimed request takes it as revision 2 at once.
    const revision = (ifMatch: string) =>
      sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${key}/packet/revisions`, {
        body: { packet: { ...packetOf(), untrusted: { ...(packetOf()["untrusted"] as object), links: [{ url: "https://design.example.com/dark" }] } } },
        headers: { "if-match": ifMatch },
      });
    at("09:00:20");
    expect((await revision('"1"')).status).toBe(200);
    expect(await agentWrites(times("09:00:40", 5, 30))).toEqual([200, 200, 200, 200, 200]);
    expect(await flagged()).toBe(true);
    const everything = async () =>
      (
        await install.owner.query(
          `SELECT r.claimant_user_id AS claimant, r.agent_write_times::text AS "agentWrites",
                  (SELECT count(*) FROM messages WHERE request_id = r.id) AS messages,
                  (SELECT count(*) FROM packet_revisions WHERE request_id = r.id) AS revisions,
                  (SELECT coalesce(sum(writes), 0) FROM agent_write_days) AS "budgetSpent"
             FROM requests r WHERE r.id = $1`,
          [requestId],
        )
      ).rows[0];
    at("09:05:00");
    const before = await everything();
    expect(await comment(carol)).toMatchObject({ status: 403, body: { type: "https://tiehall.com/problems/forbidden" } });
    const erins = await callApi(install, tokenOf(erin), "POST", `/api/v1/requests/${key}/claim`);
    expect(erins).toMatchObject({ status: 409, body: { type: "https://tiehall.com/problems/conflict" } });
    expect(await revision('"1"')).toMatchObject({ status: 412, body: { type: "https://tiehall.com/problems/precondition-failed" } });
    expect(await comment(bob)).toMatchObject({ status: 409, body: { type: NEEDS_HUMAN } });
    expect(await everything()).toEqual(before);
    expect(before).toMatchObject({ claimant: bob, messages: "5", revisions: "2" });
  });

  it("still lets agents read it and acknowledge its events", async () => {
    await flag();
    at("09:05:00");
    for (const path of [`/api/v1/requests/${key}`, `/api/v1/requests/${key}/packet`, "/api/v1/requests", "/api/v1/events"]) {
      expect((await callApi(install, tokenOf(bob), "GET", path)).status).toBe(200);
    }
    const token = tokenOf(bob);
    const read = await callApi(install, token, "GET", "/api/v1/events?limit=500");
    const last = read.body.events.at(-1).number;
    expect(await callApi(install, token, "POST", "/api/v1/events/acknowledge", { upTo: last })).toMatchObject({ status: 200, body: { cursor: last } });
  });
});

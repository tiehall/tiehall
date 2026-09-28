import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storePacketRevision, write } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, packetOf, sessionOf, tokenOf } from "./support/requests.ts";

// Agent writes are limited per token and budgeted per install (agent-safety:
// Agent writes are limited per token and budgeted per install; activity-log:
// Which actions are security events; public-api: One error model for
// Tiehall's own refusals; design.md, Decisions this change rests on: D28 #49;
// design.md, Readings to confirm with the founder: R15). One token makes at
// most 60 writes within any 60 seconds, and the install's agents at most 5,000
// writes per UTC day unless an admin changes the budget in the web UI with the
// confirmation step. A write beyond either gets 429 with Retry-After and writes
// nothing. Both are counted in Postgres, in the writing transaction. Writes of
// web sessions and the system, acknowledgements and reads are not counted.

let clock = new Date("2026-10-01T08:00:00Z");
const at = (time: string) => {
  clock = new Date(time.includes("T") ? time : `2026-10-01T${time}Z`);
};
/** A time step seconds after start, on 2026-10-01 (UTC). */
const after = (start: string, seconds: number) => new Date(new Date(`2026-10-01T${start}Z`).getTime() + seconds * 1000).toISOString();

let install: TestInstall;
let alice: string;
let bob: string;
let pia: string;
let lee: string;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
  lee = await addUser(install.owner, { login: "lee" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
});

afterAll(async () => {
  await install.close();
});

/** Opens requests from Alice's web session, which no agent limit counts; returns their keys and ids. */
async function openRequests(count: number): Promise<{ key: string; id: string }[]> {
  const opened: { key: string; id: string }[] = [];
  for (let index = 0; index < count; index++) {
    const session = sessionOf(alice);
    const result = await install.web(session).write<{ key: string; id: string }>(
      "requests.create",
      { targetTeam: "FE", title: "Add a dark mode", packet: packetOf() },
      install.fromThePage(session),
    );
    if (!result.ok) throw new Error(`requests.create answered ${result.problem.status}`);
    opened.push(result.output);
  }
  return opened;
}

const comment = (caller: ReturnType<typeof tokenOf>, key: string) =>
  install.api(caller)(
    new Request(`${URL_OF_INSTALL}/api/v1/requests/${key}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "comment", body: "Any news?" }),
    }),
  );

async function messagesOn(id: string): Promise<number> {
  const { rows } = await install.owner.query<{ count: string }>("SELECT count(*) FROM messages WHERE request_id = $1", [id]);
  return Number(rows[0]?.count);
}

/** Sets how many agent writes the install has made on a UTC day. */
async function spent(day: string, writes: number): Promise<void> {
  await install.owner.query(
    `INSERT INTO agent_write_days (org_id, day, writes) SELECT id, $1, $2 FROM orgs
     ON CONFLICT (org_id, day) DO UPDATE SET writes = excluded.writes`,
    [day, writes],
  );
}

async function spentOn(day: string): Promise<number> {
  const { rows } = await install.owner.query<{ writes: number }>("SELECT writes FROM agent_write_days WHERE day = $1", [day]);
  return rows[0]?.writes ?? 0;
}

const RATE_LIMITED = "https://tiehall.com/problems/rate-limited";

describe("the limit per token", () => {
  it("accepts the 60th write in 60 seconds from one token and refuses the 61st with 429 and Retry-After", async () => {
    at("09:00:00Z");
    const requests = await openRequests(11);
    const token = tokenOf(bob);
    for (let index = 0; index < 60; index++) {
      at(after("09:00:00", index));
      // Six writes a request, which the loop limit lets through.
      expect((await comment(token, requests[Math.floor(index / 6)]?.key ?? "")).status, `write ${index + 1}`).toBe(200);
    }
    at(after("09:00:00", 59.5));
    const last = requests[10] ?? { key: "", id: "" };
    const refused = await comment(token, last.key);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(await refused.json()).toMatchObject({ type: RATE_LIMITED, status: 429, retryAfter: 1 });
    expect(await messagesOn(last.id)).toBe(0);
    // Another token of the same user has its own limit.
    expect((await comment(tokenOf(bob), last.key)).status).toBe(200);
    at(after("09:00:00", 60.5));
    expect((await comment(token, last.key)).status).toBe(200);
  });

  it("counts any 60 seconds: 40 writes, then 20 more a second later, and the 21st is the 61st within 60 seconds", async () => {
    at("10:00:00Z");
    const requests = await openRequests(12);
    const token = tokenOf(bob);
    const target = (index: number) => requests[Math.floor(index / 6)]?.key ?? "";
    for (let index = 0; index < 40; index++) {
      at(after("10:00:30", index * 0.7));
      expect((await comment(token, target(index))).status, `write ${index + 1}`).toBe(200);
    }
    const statuses: number[] = [];
    for (let index = 0; index < 21; index++) {
      at(after("10:01:00", index * 0.7));
      statuses.push((await comment(token, target(40 + index))).status);
    }
    expect(statuses).toEqual([...Array.from({ length: 20 }, () => 200), 429]);
  });

  it("counts no read or acknowledgement: after 59 writes, reads and an acknowledgement, the token's 60th write is accepted", async () => {
    at("11:00:00Z");
    const requests = await openRequests(11);
    const token = tokenOf(bob);
    for (let index = 0; index < 59; index++) {
      at(after("11:00:00", index * 0.5));
      expect((await comment(token, requests[Math.floor(index / 6)]?.key ?? "")).status, `write ${index + 1}`).toBe(200);
    }
    at(after("11:00:00", 30));
    for (const path of [`/api/v1/requests/${requests[0]?.key ?? ""}`, "/api/v1/requests", "/api/v1/events?limit=500"]) {
      expect((await callApi(install, token, "GET", path)).status, path).toBe(200);
    }
    const events = await callApi(install, token, "GET", "/api/v1/events?limit=500");
    expect((await callApi(install, token, "POST", "/api/v1/events/acknowledge", { upTo: events.body.events.at(-1).number })).status).toBe(200);
    const last = requests[10]?.key ?? "";
    expect((await comment(token, last)).status).toBe(200);
    expect((await comment(token, last)).status).toBe(429);
  });
});

describe("the install's daily budget", () => {
  it("accepts the 5,000th agent write of a UTC day and refuses the next with 429 until the day ends", async () => {
    at("2026-10-03T09:00:00Z");
    const [request] = await openRequests(1);
    const key = request?.key ?? "";
    await spent("2026-10-03", 4_999);
    expect((await comment(tokenOf(bob), key)).status).toBe(200);
    expect(await spentOn("2026-10-03")).toBe(5_000);
    const refused = await comment(tokenOf(alice), key);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(15 * 3600));
    expect(await messagesOn(request?.id ?? "")).toBe(1);
    expect(await spentOn("2026-10-03")).toBe(5_000);
  });

  it("counts no write of a web session or of the system, and no acknowledgement or read, which still go through", async () => {
    at("2026-10-04T09:00:00Z");
    const [request] = await openRequests(1);
    const key = request?.key ?? "";
    await spent("2026-10-04", 5_000);
    const session = sessionOf(bob);
    expect((await install.web(session).write("messages.post", { key, kind: "comment", body: "On it." }, install.fromThePage(session))).ok).toBe(true);
    await write({ database: install.db, jobs: { send: async () => {} } }, { actorKind: "system", surface: "github" }, (writer) =>
      storePacketRevision(writer, request?.id ?? "", packetOf("From a contract report.") as never),
    );
    const token = tokenOf(bob);
    expect((await callApi(install, token, "GET", `/api/v1/requests/${key}`)).status).toBe(200);
    const events = await callApi(install, token, "GET", "/api/v1/events?limit=500");
    expect((await callApi(install, token, "POST", "/api/v1/events/acknowledge", { upTo: events.body.events.at(-1).number })).status).toBe(200);
    expect(await spentOn("2026-10-04")).toBe(5_000);
  });

  it("starts again each UTC day", async () => {
    at("2026-10-05T23:00:00Z");
    const [request] = await openRequests(1);
    await spent("2026-10-05", 5_000);
    expect((await comment(tokenOf(bob), request?.key ?? "")).status).toBe(429);
    at("2026-10-06T00:01:00Z");
    expect((await comment(tokenOf(bob), request?.key ?? "")).status).toBe(200);
    expect(await spentOn("2026-10-06")).toBe(1);
  });
});

describe("changing the budget", () => {
  it("is an admin's action with the confirmation step: a confirmed change to 8,000 applies and is a security event", async () => {
    at("2026-10-07T09:00:00Z");
    const [request] = await openRequests(1);
    const key = request?.key ?? "";
    await spent("2026-10-07", 5_000);
    expect((await comment(tokenOf(bob), key)).status).toBe(429);

    const page = await install.confirmRoute(sessionOf(pia))(
      new Request(`${URL_OF_INSTALL}/confirm/settings.set_write_budget?input=${encodeURIComponent(JSON.stringify({ dailyWriteBudget: 8_000 }))}`),
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Change the install&#39;s daily budget of agent writes from 5,000 to 8,000.");

    expect((await install.confirm(sessionOf(pia), "settings.set_write_budget", { dailyWriteBudget: 8_000 })).status).toBe(200);
    expect((await comment(tokenOf(bob), key)).status).toBe(200);
    await spent("2026-10-07", 7_999);
    expect((await comment(tokenOf(bob), key)).status).toBe(200);
    expect((await comment(tokenOf(bob), key)).status).toBe(429);

    const { rows } = await install.owner.query<{ class: string; data: unknown; actor_kind: string; actor_user_id: string }>(
      "SELECT class, data, actor_kind, actor_user_id FROM events WHERE type = 'settings.write_budget_changed'",
    );
    expect(rows).toEqual([{ class: "security", data: { budget: 8_000, previousBudget: 5_000 }, actor_kind: "web_session", actor_user_id: pia }]);
  });

  it("is refused to a member, and offered on no agent surface", async () => {
    const answer = await install.confirm(sessionOf(lee), "settings.set_write_budget", { dailyWriteBudget: 100 });
    expect(answer.status).toBe(403);
    const onRest = await callApi(install, tokenOf(pia), "POST", "/api/v1/settings/write-budget", { dailyWriteBudget: 100 });
    expect(onRest.status).toBe(404);
    const { rows } = await install.owner.query("SELECT daily_write_budget FROM install_settings");
    expect(rows).toEqual([{ daily_write_budget: 8_000 }]);
  });

  it("takes a budget of 1 to 1,000,000 writes a day", async () => {
    for (const dailyWriteBudget of [0, 1_000_001, 2.5]) {
      expect((await install.confirm(sessionOf(pia), "settings.set_write_budget", { dailyWriteBudget })).status).toBe(400);
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// The needs_human flag is visible and reaches the people on the request
// (agent-safety: The needs_human flag is visible and reaches the people on the
// request; requests: The event log; design.md, Decisions this change rests on:
// D28 #50, D30 (4)). Setting the flag and clearing it each append a domain
// event on the request, in the transaction of the write that does it, which
// the pull readers carry to the people on the request; every read of the
// request states whether it is flagged.

let clock = new Date("2026-10-01T08:59:00Z");
const at = (time: string) => {
  clock = new Date(`2026-10-01T${time}Z`);
};

let install: TestInstall;
let alice: string;
let bob: string;
let key: string;
let requestId: string;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
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

const comment = (user: string) => callApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/messages`, { kind: "comment", body: "Any news?" });

/** Seven agent writes between 09:00 and 09:04, which flag the request. */
async function flag(): Promise<void> {
  for (let index = 0; index < 7; index++) {
    at(`09:0${Math.floor((index * 40) / 60)}:${String((index * 40) % 60).padStart(2, "0")}`);
    expect((await comment(index % 2 === 0 ? bob : alice)).status).toBe(200);
  }
}

async function eventsOfTheRequest(): Promise<{ number: number; type: string; actor_kind: string }[]> {
  const { rows } = await install.owner.query<{ number: string; type: string; actor_kind: string }>(
    "SELECT number, type, actor_kind FROM events WHERE data->>'requestId' = $1 ORDER BY number",
    [requestId],
  );
  return rows.map((row) => ({ ...row, number: Number(row.number) }));
}

/** Posts a message from Alice's web session. */
async function webMessage(): Promise<void> {
  const session = sessionOf(alice);
  const posted = await install.web(session).write("messages.post", { key, kind: "comment", body: "Let us talk." }, install.fromThePage(session));
  expect(posted.ok).toBe(true);
}

describe("setting the flag", () => {
  it("appends a domain event on the request in the transaction of the write that sets it", async () => {
    await flag();
    const events = await eventsOfTheRequest();
    const flagged = events.filter(({ type }) => type === "request.needs_human_flagged");
    expect(flagged).toHaveLength(1);
    // The seventh message's event is the next in the same transaction, and nothing else came between.
    const next = events.find(({ number }) => number === (flagged[0]?.number ?? 0) + 1);
    expect(next?.type).toBe("request.message_posted");
    const { rows } = await install.owner.query<{ class: string }>("SELECT class FROM events WHERE type = 'request.needs_human_flagged'");
    expect(rows.every(({ class: kind }) => kind === "domain")).toBe(true);
  });

  it("reaches the requester's pull reader", async () => {
    await flag();
    const read = await callApi(install, oauthTokenOf(alice, "tiehall-cli", "cli"), "GET", "/api/v1/events?limit=500");
    expect(read.status).toBe(200);
    expect(read.body.events).toContainEqual(expect.objectContaining({ type: "request.needs_human_flagged", data: { requestId } }));
  });

  it("is stated by every read of the request, for agents and in the web UI", async () => {
    expect((await callApi(install, tokenOf(bob), "GET", `/api/v1/requests/${key}`)).body.needsHuman).toBe(false);
    await flag();
    expect((await callApi(install, tokenOf(bob), "GET", `/api/v1/requests/${key}`)).body.needsHuman).toBe(true);
    const listed = (await callApi(install, tokenOf(bob), "GET", "/api/v1/requests?limit=200")).body.requests.find(({ id }: { id: string }) => id === requestId);
    expect(listed.needsHuman).toBe(true);
    const inTheWebUi = await install.web(sessionOf(bob)).read<{ needsHuman: boolean }>("requests.get", { key });
    expect(inTheWebUi).toMatchObject({ ok: true, output: { needsHuman: true } });
  });
});

describe("clearing the flag", () => {
  it("appends a domain event when a member's message in the web UI clears it, and reads state it", async () => {
    await flag();
    at("09:10:00");
    await webMessage();
    const types = (await eventsOfTheRequest()).map(({ type }) => type);
    expect(types.filter((type) => type === "request.needs_human_cleared")).toHaveLength(1);
    expect(types.at(-1)).toBe("request.needs_human_cleared");
    expect((await callApi(install, tokenOf(bob), "GET", `/api/v1/requests/${key}`)).body.needsHuman).toBe(false);
  });

  it("appends none when the request was not flagged", async () => {
    await webMessage();
    expect((await eventsOfTheRequest()).map(({ type }) => type)).not.toContain("request.needs_human_cleared");
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// A request flips between needs_info and in_progress at most 3 times a day
// (agent-safety: A request flips between needs_info and in_progress at most 3
// times a day; design.md, Decisions this change rests on: D28 #51; design.md,
// Readings to confirm with the founder: R15). A flip is a round trip from
// in_progress to needs_info and back. It counts when its blocking question was
// posted by an agent, whoever answers it, on the UTC day the question was
// posted. An agent's blocking question that would start a fourth counted flip
// that day, on a request that is in_progress, is posted as non-blocking, and
// Tiehall adds a notice. Blocking questions posted from a web session start no
// counted flip, and one on an open or claimed request is no flip.

let clock = new Date("2026-10-01T08:00:00Z");
/** Sets the clock to a time on 2026-10-01 (UTC), or on another day given as YYYY-MM-DDTHH:MM. */
const at = (time: string) => {
  clock = new Date(time.includes("T") ? `${time}:00Z` : `2026-10-01T${time}:00Z`);
};
const later = (time: string, minutes: number) => {
  const next = new Date(new Date(time.includes("T") ? `${time}:00Z` : `2026-10-01T${time}:00Z`).getTime() + minutes * 60_000);
  return next.toISOString().slice(0, 16);
};

let install: TestInstall;
let alice: string;
let bob: string;
let key: string;

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

/** FE-n, opened by Alice to FE, claimed by Bob, who started work on it. */
beforeEach(async () => {
  at("2026-09-30T08:00");
  key = (await openRequest(install, tokenOf(alice), { targetTeam: "FE" })).key;
  expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/claim`)).status).toBe(200);
  expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/status`, { state: "in_progress" })).status).toBe(200);
});

type Poster = "agent" | "web";

async function post(user: string, by: Poster, message: Record<string, unknown>) {
  if (by === "agent") {
    const answer = await callApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/messages`, message);
    expect(answer.status).toBe(200);
    return answer.body;
  }
  const session = sessionOf(user);
  const result = await install.web(session).write<{ message: { id: string; blocking: boolean }; request: { state: string } }>(
    "messages.post",
    { key, ...message },
    install.fromThePage(session),
  );
  if (!result.ok) throw new Error(`messages.post answered ${result.problem.status}`);
  return result.output;
}

/** Bob asks a blocking question at a time, and Alice answers it a minute later; returns the state after each. */
async function flip(time: string, asker: Poster = "agent", answerer: Poster = "agent"): Promise<[string, string]> {
  at(time);
  const asked = await post(bob, asker, { kind: "question", body: "Which browsers must it support?", blocking: true });
  at(later(time, 1));
  const answered = await post(alice, answerer, { kind: "answer", body: "The last two versions.", questionId: asked.message.id });
  return [asked.request.state, answered.request.state];
}

async function state(): Promise<string> {
  return (await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}`)).body.state;
}

describe("counted flips", () => {
  it("post an agent's fourth blocking question of the day as non-blocking, with a notice from Tiehall", async () => {
    for (const time of ["09:00", "10:00", "11:00"]) expect(await flip(time)).toEqual(["needs_info", "in_progress"]);
    at("12:00");
    const asked = await post(bob, "agent", { kind: "question", body: "And tablets?", blocking: true });
    expect(asked.message).toMatchObject({ kind: "question", blocking: false });
    expect(asked.request.state).toBe("in_progress");
    const thread = (await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}`)).body.messages;
    const notice = thread.at(-1);
    expect(notice).toMatchObject({ kind: "comment", provenance: { actorKind: "system", user: null, team: null, surface: null } });
    expect(notice.untrusted.body).toBe(
      `Tiehall posted the question above as non-blocking: agents have already moved ${key} from in_progress to needs_info and back 3 times today (UTC). A blocking question posted from the web UI still moves it to needs_info.`,
    );
    expect(thread.at(-2)).toMatchObject({ id: asked.message.id, blocking: false });
  });

  it("start again each UTC day, counting a flip on the day its question was posted", async () => {
    expect(await flip("2026-10-01T21:00")).toEqual(["needs_info", "in_progress"]);
    expect(await flip("2026-10-01T22:00")).toEqual(["needs_info", "in_progress"]);
    // Asked at 23:59 on 2026-10-01 and answered at 00:00 on 2026-10-02: the third flip of 2026-10-01.
    expect(await flip("2026-10-01T23:59")).toEqual(["needs_info", "in_progress"]);
    at("2026-10-02T00:05");
    const asked = await post(bob, "agent", { kind: "question", body: "One more thing.", blocking: true });
    expect(asked.message.blocking).toBe(true);
    expect(await state()).toBe("needs_info");
  });

  it("leave out flips that people start in the web UI", async () => {
    for (const time of ["09:00", "10:00", "11:00"]) expect(await flip(time, "web", "agent")).toEqual(["needs_info", "in_progress"]);
    at("12:00");
    const asked = await post(bob, "agent", { kind: "question", body: "And tablets?", blocking: true });
    expect(asked.message.blocking).toBe(true);
    expect(await state()).toBe("needs_info");
  });

  it("count an agent's question that a person answers in the web UI", async () => {
    for (const time of ["09:00", "10:00", "11:00"]) expect(await flip(time, "agent", "web")).toEqual(["needs_info", "in_progress"]);
    at("12:00");
    const asked = await post(bob, "agent", { kind: "question", body: "And tablets?", blocking: true });
    expect(asked.message.blocking).toBe(false);
    expect(await state()).toBe("in_progress");
  });

  it("leave a question on a claimed request alone, which is no flip", async () => {
    for (const time of ["09:00", "10:00", "11:00"]) await flip(time);
    at("11:30");
    expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/status`, { state: "open" })).status).toBe(200);
    expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/claim`)).status).toBe(200);
    at("12:00");
    const asked = await post(bob, "agent", { kind: "question", body: "Still there?", blocking: true });
    expect(asked.message.blocking).toBe(true);
    expect(asked.request.state).toBe("needs_info");
  });

  it("count one flip for two blocking questions of the same round trip", async () => {
    at("09:00");
    const first = await post(bob, "agent", { kind: "question", body: "Which browsers?", blocking: true });
    at("09:01");
    const second = await post(bob, "agent", { kind: "question", body: "Which devices?", blocking: true });
    expect(second.message.blocking).toBe(true);
    at("09:02");
    await post(alice, "agent", { kind: "answer", body: "Two versions.", questionId: first.message.id });
    at("09:03");
    await post(alice, "agent", { kind: "answer", body: "Phones too.", questionId: second.message.id });
    expect(await state()).toBe("in_progress");
    expect(await flip("10:00")).toEqual(["needs_info", "in_progress"]);
    expect(await flip("11:00")).toEqual(["needs_info", "in_progress"]);
  });
});

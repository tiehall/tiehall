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
// request states whether it is flagged. Tiehall sets the flag, so its event is
// recorded as the system's, and reaches the requester even when the
// requester's own agent made the write that set it, which the readers leave
// out as the requester's own (requester-loop: What whats_new covers).

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

/** Seven agent writes between 09:00 and 09:04, by Bob's and Alice's agents in turn, which flag the request; the seventh is by this user's agent. */
async function flag(seventh = bob): Promise<void> {
  const other = seventh === bob ? alice : bob;
  for (let index = 0; index < 7; index++) {
    at(`09:0${Math.floor((index * 40) / 60)}:${String((index * 40) % 60).padStart(2, "0")}`);
    expect((await comment(index % 2 === 0 ? seventh : other)).status).toBe(200);
  }
}

interface Update {
  number: number;
  type: string;
  data: Record<string, unknown>;
}

/** Every update a reader holds after its cursor, page after page, each acknowledged so the next follows it. */
async function readToTheEnd(page: (acknowledge: number | undefined) => Promise<{ events: Update[]; more: boolean }>): Promise<Update[]> {
  const read: Update[] = [];
  for (let acknowledge: number | undefined; ; ) {
    const { events, more } = await page(acknowledge);
    read.push(...events);
    if (!more) return read;
    acknowledge = events.at(-1)?.number;
  }
}

/** Every update of Alice's whats_new, as Alice's CLI reads it. */
function alicesWhatsNew(): Promise<Update[]> {
  const reader = oauthTokenOf(alice, "tiehall-cli", "cli");
  return readToTheEnd(async (acknowledge) => {
    const page = await callApi(install, reader, "POST", "/api/v1/updates", { ...(acknowledge === undefined ? {} : { acknowledge }), limit: 50 });
    expect(page.status).toBe(200);
    return page.body;
  });
}

/** Every update of Alice's web inbox feed, as the web UI reads it for Alice. */
function alicesWebInboxFeed(): Promise<Update[]> {
  const session = sessionOf(alice);
  return readToTheEnd(async (acknowledge) => {
    const page =
      acknowledge === undefined
        ? await install.web(session).read<{ events: Update[]; more: boolean }>("inbox.updates", { limit: 50 })
        : await install.web(session).write<{ events: Update[]; more: boolean }>("inbox.updates", { acknowledge, limit: 50 }, install.fromThePage(session));
    if (!page.ok) throw new Error(`inbox.updates answered ${JSON.stringify(page.problem)}`);
    return page.output;
  });
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
    expect(await alicesWhatsNew()).toContainEqual(expect.objectContaining({ type: "request.needs_human_flagged", data: { requestId } }));
  });

  // agent-safety: The needs_human flag is visible and reaches the people on the request, "The requester learns that a
  // request needs a human", whichever agent made the seventh write.
  it("is recorded as the system's, and reaches the requester's readers when the requester's own agent set it", async () => {
    await flag(alice);
    // The agents' reader and the reader people read, each of which leaves out Alice's own events: here, the opening
    // and Alice's agent's four messages.
    const flagged = expect.objectContaining({ type: "request.needs_human_flagged", data: { requestId } });
    const whatsNew = await alicesWhatsNew();
    expect(whatsNew.filter(({ data }) => data["requestId"] === requestId).map(({ type }) => type)).toEqual([
      "request.message_posted",
      "request.message_posted",
      "request.message_posted",
      "request.needs_human_flagged",
    ]);
    expect(await alicesWebInboxFeed()).toContainEqual(flagged);
    const { rows } = await install.owner.query<{ actor_kind: string; actor_user_id: string | null }>(
      "SELECT actor_kind, actor_user_id FROM events WHERE type = 'request.needs_human_flagged' AND data->>'requestId' = $1",
      [requestId],
    );
    expect(rows).toEqual([{ actor_kind: "system", actor_user_id: null }]);
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

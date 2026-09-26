import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, packetOf, sessionOf, tokenOf } from "./support/requests.ts";

// Agent-opened requests are capped (agent-safety: Agent-opened requests are
// capped; public-api: One error model for Tiehall's own refusals; design.md,
// Decisions this change rests on: D28 #49). Agents acting for one user open at
// most 20 requests within any hour, and agents open at most 50 requests from
// one team to another per UTC day, so that loops spanning several requests
// stop. A request beyond either cap is not opened, and the call gets 429 with
// Retry-After. Requests people open in the web UI are not counted.

let clock = new Date("2026-10-01T08:00:00Z");
const at = (time: string) => {
  clock = new Date(time);
};
/** A time minutes after start. */
const plus = (start: string, minutes: number) => new Date(new Date(start).getTime() + minutes * 60_000).toISOString();

let install: TestInstall;
let alice: string;
let sam: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const mob = await addTeam(install.owner, "MOB");
  alice = await addUser(install.owner, { login: "alice" });
  sam = await addUser(install.owner, { login: "sam" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, sam, be);
  await joinTeams(install.owner, bob, fe);
  void mob;
});

afterAll(async () => {
  await install.close();
});

/** An agent of the user opens a request to a team through /api/v1; returns the answer. */
async function agentOpens(user: string, targetTeam: string) {
  const response = await install.api(tokenOf(user))(
    new Request(`${URL_OF_INSTALL}/api/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetTeam, title: "Add a dark mode", packet: packetOf() }),
    }),
  );
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: (await response.json()) as { type?: string } };
}

async function opened(): Promise<number> {
  const { rows } = await install.owner.query<{ count: string }>("SELECT count(*) FROM requests");
  return Number(rows[0]?.count);
}

describe("the cap per user", () => {
  it("lets a user's agents open 20 requests within an hour and refuses the 21st with 429, opening nothing", async () => {
    const start = "2026-10-01T09:00:00Z";
    for (let index = 0; index < 20; index++) {
      at(plus(start, index * 2.5));
      expect((await agentOpens(alice, index % 2 === 0 ? "FE" : "MOB")).status, `request ${index + 1}`).toBe(200);
    }
    const before = await opened();
    at(plus(start, 55));
    const refused = await agentOpens(alice, "FE");
    expect(refused).toMatchObject({ status: 429, retryAfter: "300", body: { type: "https://tiehall.com/problems/rate-limited" } });
    expect(await opened()).toBe(before);
    // Another user's agents, and Alice in the web UI, still open requests.
    expect((await agentOpens(sam, "FE")).status).toBe(200);
    const session = sessionOf(alice);
    const inTheWebUi = await install.web(session).write("requests.create", { targetTeam: "FE", title: "From the web", packet: packetOf() }, install.fromThePage(session));
    expect(inTheWebUi.ok).toBe(true);
    // Once the first of the 20 is an hour old, the next one opens.
    at(plus(start, 60.01));
    expect((await agentOpens(alice, "FE")).status).toBe(200);
  });

  it("lets only one of two requests opened at the same moment through at the cap", async () => {
    const start = "2026-10-02T09:00:00Z";
    for (let index = 0; index < 19; index++) {
      at(plus(start, index));
      expect((await agentOpens(sam, "MOB")).status).toBe(200);
    }
    at(plus(start, 30));
    const answers = await Promise.all([agentOpens(sam, "FE"), agentOpens(sam, "MOB")]);
    expect(answers.map(({ status }) => status).sort()).toEqual([200, 429]);
  });
});

describe("the cap per pair of teams", () => {
  it("lets agents open 50 requests from BE to FE in a UTC day and refuses the 51st with 429 until the day ends", async () => {
    const day = "2026-10-03T";
    // Alice's and Sam's agents take turns, 25 each, within the cap per user.
    for (let index = 0; index < 50; index++) {
      at(plus(`${day}01:00:00Z`, index * 5));
      expect((await agentOpens(index % 2 === 0 ? alice : sam, "FE")).status, `request ${index + 1}`).toBe(200);
    }
    const before = await opened();
    at(`${day}20:00:00Z`);
    const refused = await agentOpens(alice, "FE");
    expect(refused).toMatchObject({ status: 429, retryAfter: String(4 * 3600) });
    expect(await opened()).toBe(before);
    // Another pair, the other direction among them, still opens.
    expect((await agentOpens(alice, "MOB")).status).toBe(200);
    expect((await agentOpens(bob, "BE")).status).toBe(200);
    at("2026-10-04T00:01:00Z");
    expect((await agentOpens(alice, "FE")).status).toBe(200);
  });

  it("counts no request people open in the web UI", async () => {
    const day = "2026-10-05T";
    at(`${day}01:00:00Z`);
    for (let index = 0; index < 50; index++) {
      const session = sessionOf(index % 2 === 0 ? alice : sam);
      const result = await install.web(session).write("requests.create", { targetTeam: "FE", title: "From the web", packet: packetOf() }, install.fromThePage(session));
      expect(result.ok).toBe(true);
    }
    expect((await agentOpens(alice, "FE")).status).toBe(200);
  });
});

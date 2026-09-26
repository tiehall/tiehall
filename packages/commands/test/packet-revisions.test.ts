import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPacketRevision, write, type Store } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, tokenOf } from "./support/requests.ts";

// Immutable, numbered revisions (handoff-packet: Immutable, numbered
// revisions; requests: The event log; requests: Events carry ids, not bodies;
// design.md, Design rules: Handoff packet). A request's packet is kept as
// numbered revisions: the packet it was opened with is revision 1, and each
// change adds the next one. A revision never changes once it is created, which
// the database also refuses, even to its owner; every earlier revision stays
// readable by its number. Adding a revision appends a domain event that names
// the request and the revision's number, never the packet. The operation that
// adds a revision comes with task 12.8; these tests add revisions through the
// same storage path it uses.

let install: TestInstall;
let alice: string;
let store: Store;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  await joinTeams(install.owner, alice, be);
  store = { database: install.db, jobs: { send: async () => {} } };
});

afterAll(async () => {
  await install.close();
});

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../packet/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

/** Adds the next revision of the request's packet, as Alice's agent's change. */
async function addRevision(requestId: string, packet: unknown): Promise<number> {
  return write(store, { actorKind: "agent", userId: alice, surface: "api" }, (writer) => addPacketRevision(writer, requestId, packet as never));
}

const readRevision = (key: string, revision: number | string) => callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}/packet/revisions/${revision}`);

describe("a request's packet revisions", () => {
  it("start with revision 1, the packet the request was opened with, readable by its number", async () => {
    const sent = fixture("valid/request-packet.json");
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: sent });
    expect(await readRevision(opened.key, 1)).toEqual({
      status: 200,
      body: { request: { id: opened.id, key: opened.key }, revision: 1, createdAt: expect.any(String), packet: sent },
    });
  });

  it("keep revision 1 exactly as it read before, once revision 2 is added, and read each by its number", async () => {
    const first = fixture("valid/request-packet.json");
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: first });
    const before = await readRevision(opened.key, 1);
    const second = { ...first, untrusted: { ...(first["untrusted"] as object), acceptance_criteria: ["Only one criterion now."] } };
    expect(await addRevision(opened.id, second)).toBe(2);
    expect(await readRevision(opened.key, 1)).toEqual(before);
    expect(await readRevision(opened.key, 2)).toEqual({
      status: 200,
      body: { request: { id: opened.id, key: opened.key }, revision: 2, createdAt: expect.any(String), packet: second },
    });
    const current = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet`);
    expect(current.body).toEqual((await readRevision(opened.key, 2)).body);
  });

  it("take the next number each, one after another, also when added at once", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const numbers = await Promise.all([2, 3, 4, 5, 6].map((n) => addRevision(opened.id, packetOf(`Revision ${n}.`))));
    expect([...numbers].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
    for (const number of numbers) {
      const read = await readRevision(opened.key, number);
      expect(read.body.revision).toBe(number);
    }
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet`)).body.revision).toBe(6);
  });

  it("answer 404 for a revision the request does not have, and 400 for one that is not a number from 1", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect(await readRevision(opened.key, 2)).toEqual({ status: 404, body: expect.objectContaining({ type: "https://tiehall.com/problems/record-not-found" }) });
    for (const revision of ["0", "-1", "one", "1.5"]) expect((await readRevision(opened.key, revision)).status, revision).toBe(400);
    expect((await callApi(install, tokenOf(alice), "GET", "/api/v1/requests/FE-9999/packet/revisions/1")).status).toBe(404);
  });

  it("append a domain event for each added revision, which names the request and the number and not the packet", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await addRevision(opened.id, packetOf("canary-4Rt9 in the need"));
    const { rows } = await install.owner.query("SELECT class, type, data FROM events WHERE data->>'requestId' = $1 ORDER BY number", [opened.id]);
    expect(rows.at(-1)).toEqual({ class: "domain", type: "request.packet_revised", data: { requestId: opened.id, revision: 2 } });
    expect(JSON.stringify(rows)).not.toContain("canary-4Rt9");
  });
});

describe("the stored revisions", () => {
  /** The error a statement fails with, or undefined when it succeeds. */
  async function failureOf(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
      return undefined;
    } catch (error) {
      return String((error as { cause?: Error }).cause?.message ?? (error as Error).message);
    }
  }

  it("cannot be rewritten or deleted by the app role, which may only insert and read them", async () => {
    expect(await failureOf(() => install.db.execute("UPDATE packet_revisions SET number = number"))).toMatch(/permission denied/);
    expect(await failureOf(() => install.db.execute("DELETE FROM packet_revisions"))).toMatch(/permission denied/);
    expect(await failureOf(() => install.db.execute("TRUNCATE packet_revisions"))).toMatch(/permission denied/);
  });

  it("refuse every update and delete, even from the database owner", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: packetOf("Kept as it was.") });
    for (const statement of [
      "UPDATE packet_revisions SET packet = '{}'::json",
      "DELETE FROM packet_revisions",
      "TRUNCATE packet_revisions",
    ]) {
      expect(await failureOf(() => install.owner.query(statement)), statement).toMatch(/Packet revisions are immutable/);
    }
    expect((await readRevision(opened.key, 1)).body.packet).toEqual(packetOf("Kept as it was."));
  });
});

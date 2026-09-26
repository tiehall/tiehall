import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packetValidator } from "@tiehall/packet";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, tokenOf } from "./support/requests.ts";

// Open objects, strict server (handoff-packet: Open objects, strict server;
// handoff-packet: Packet fields; handoff-packet: Immutable, numbered
// revisions; public-api: Input and output follow the published schemas). The
// packet schema forbids no additional property, so a packet with a key the
// schema does not define still validates against it. The server parses every
// incoming packet strictly all the same: a known field with a value of the
// wrong type is refused with 400 and nothing is stored, and a key it does not
// know is dropped, so it is neither stored nor returned. A request is opened
// with its packet, which becomes its revision 1.

let install: TestInstall;
let alice: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  await joinTeams(install.owner, alice, be);
});

afterAll(async () => {
  await install.close();
});

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../packet/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

/** What a refused call must leave as it was: the requests, their revisions, the teams' counts and the event log. */
async function everything(): Promise<unknown> {
  const { rows } = await install.owner.query(
    `SELECT (SELECT count(*) FROM requests) AS requests,
            (SELECT count(*) FROM packet_revisions) AS revisions,
            (SELECT coalesce(json_agg(c ORDER BY c.team_id), '[]') FROM request_counters c) AS counters,
            (SELECT count(*) FROM events) AS events`,
  );
  return rows[0];
}

describe("opening a request with its packet", () => {
  it("stores the packet as revision 1, which reads back as it was sent", async () => {
    const sent = fixture("valid/request-packet.json");
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: sent });
    const read = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet`);
    expect(read).toEqual({
      status: 200,
      body: { request: { id: opened.id, key: opened.key }, revision: 1, createdAt: expect.any(String), packet: sent },
    });
  });

  it("gets 400 for a packet without a need, and creates nothing", async () => {
    const before = await everything();
    const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", {
      targetTeam: "FE",
      title: "No need",
      packet: fixture("invalid/no-need.json"),
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/invalid-input", status: 400 });
    expect(await everything()).toEqual(before);
  });

  it("gets 400 without a packet, and creates nothing", async () => {
    const before = await everything();
    const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", { targetTeam: "FE", title: "No packet" });
    expect(answer.status).toBe(400);
    expect(await everything()).toEqual(before);
  });
});

describe("a known field with the wrong type", () => {
  it.each([
    ["acceptance criteria that are not a list", { acceptance_criteria: "It follows the operating system's setting." }, ["acceptance_criteria"]],
    ["a need that is a number", { need: 42 }, ["need"]],
    ["a link whose url is a number", { links: [{ url: 42 }] }, ["links", 0, "url"]],
  ])("gets 400 for %s, names where the packet fails, and stores nothing", async (_name, change, where) => {
    const sent = fixture("valid/request-packet.json");
    const before = await everything();
    const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", {
      targetTeam: "FE",
      title: "Wrong type",
      packet: { ...sent, untrusted: { ...(sent["untrusted"] as object), ...change } },
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/invalid-input" });
    expect(JSON.stringify(answer.body.errors)).toContain(JSON.stringify(["packet", "untrusted", ...where]).slice(1, -1));
    expect(await everything()).toEqual(before);
  });

  it("gets 400 for a due date that is not a date, and stores nothing", async () => {
    const before = await everything();
    const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", {
      targetTeam: "FE",
      title: "Wrong type",
      packet: fixture("invalid/due-date-not-a-date.json"),
    });
    expect(answer.status).toBe(400);
    expect(await everything()).toEqual(before);
  });
});

describe("a key the server does not know", () => {
  const sent = fixture("valid/unknown-keys.json");

  it("is valid against the packet schema", () => {
    expect(packetValidator()(sent)).toBe(true);
  });

  it("is dropped, so reading the revision back never returns it and it is not stored", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: sent });
    const read = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet`);
    expect(read.status).toBe(200);
    expect(read.body.packet).toEqual({
      schema_version: "1-beta",
      kind: "request",
      untrusted: {
        need: "Add an export button to the reports page.",
        links: [{ url: "https://wiki.example.com/reports", title: "Reports" }],
      },
    });
    const stored = await install.owner.query<{ packet: string }>(
      "SELECT r.packet::text AS packet FROM packet_revisions r WHERE r.request_id = $1",
      [opened.id],
    );
    expect(stored.rows).toHaveLength(1);
    for (const unknown of ["priority", "estimate", "rel", "background", "2 days"]) expect(stored.rows[0]?.packet).not.toContain(unknown);
  });
});

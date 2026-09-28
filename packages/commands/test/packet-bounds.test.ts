import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, tokenOf } from "./support/requests.ts";

// The bounds of the packet's text fields (handoff-packet: Packet fields;
// design.md, Decisions: D45 (2)). Every text field of the packet is bounded.
// A packet with a field outside its bound fails the schema: opening a request
// with it, or adding it as a revision, gets 400 through /api/v1 and stores
// nothing, while a packet whose fields sit at their bounds passes. The refused
// packets are conformance fixtures of the Apache-2.0 schema directory, so the
// published packet schema refuses them too.

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

function addRevision(key: string, packet: unknown, ifMatch: string) {
  return sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${key}/packet/revisions`, { body: { packet }, headers: { "if-match": ifMatch } });
}

const OUTSIDE_THEIR_BOUNDS = [
  ["a need of 20,001 characters", "invalid/need-too-long.json"],
  ["101 acceptance criteria", "invalid/acceptance-criteria-too-many.json"],
  ["an acceptance criterion of 2,001 characters", "invalid/acceptance-criterion-too-long.json"],
  ["a link URL of 2,049 characters", "invalid/link-url-too-long.json"],
  ["101 links", "invalid/links-too-many.json"],
] as const;

describe("a packet with a field outside its bound", () => {
  it.each(OUTSIDE_THEIR_BOUNDS)("with %s gets 400 on opening a request, which is not created", async (_name, name) => {
    const before = await everything();
    const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", { targetTeam: "FE", title: "Too much", packet: fixture(name) });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/invalid-input", status: 400 });
    expect(await everything()).toEqual(before);
  });

  it.each(OUTSIDE_THEIR_BOUNDS)("with %s gets 400 as a revision, which is not added", async (_name, name) => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const before = await everything();
    const answer = await addRevision(opened.key, fixture(name), '"1"');
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/invalid-input", status: 400 });
    expect(await everything()).toEqual(before);
  });
});

describe("a packet whose fields sit at their bounds", () => {
  it("opens a request with a need of 20,000 characters and 100 criteria of 2,000 characters, and is added as a revision", async () => {
    const atTheBounds = (letter: string) => {
      const packet = packetOf(letter.repeat(20000));
      return { ...packet, untrusted: { ...(packet["untrusted"] as object), acceptance_criteria: Array.from({ length: 100 }, () => letter.repeat(2000)) } };
    };
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: atTheBounds("a") });
    const added = await addRevision(opened.key, atTheBounds("b"), '"1"');
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ revision: 2, packet: atTheBounds("b") });
    const first = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet/revisions/1`);
    expect(first.body).toMatchObject({ revision: 1, packet: atTheBounds("a") });
  });
});

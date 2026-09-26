import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Readers get only domain events they may see (requests: Readers get only
// domain events they may see; activity-log: Security events are shown to
// admins only; design.md, Decisions this change rests on: D28 #58; design.md,
// Self-hosting decisions: S14). Event reads and read cursors serve only domain
// events, the changes to requests, and every member may see every request.
// Security events, such as a role change, reach no reader, not even an admin's:
// the activity log shows them to admins. Someone who is no longer a member
// reads nothing.

let install: TestInstall;
const team: Record<string, string> = {};
let pia: string;
let bob: string;
let lee: string;
let dana: string;

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE"]) team[name] = await addTeam(install.owner, name);
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
  bob = await addUser(install.owner, { login: "bob" });
  lee = await addUser(install.owner, { login: "lee" });
  dana = await addUser(install.owner, { login: "dana" });
  await joinTeams(install.owner, bob, team["FE"] ?? "");
  await joinTeams(install.owner, dana, team["BE"] ?? "");
  // A domain event, a role change that Pia confirms, and another domain event.
  await openRequest(install, tokenOf(dana), { targetTeam: "FE", title: "Before the role change" });
  expect((await install.confirm(sessionOf(pia), "members.change_role", { userId: lee, role: "admin" })).status).toBe(200);
  await openRequest(install, tokenOf(dana), { targetTeam: "FE", title: "After the role change" });
});

afterAll(async () => {
  await install.close();
});

async function typesReadBy(caller: Caller): Promise<string[]> {
  const answer = await callApi(install, caller, "GET", "/api/v1/events");
  expect(answer.status).toBe(200);
  return answer.body.events.map(({ type }: { type: string }) => type);
}

describe("a role change", () => {
  it("is in the log as a security event", async () => {
    const { rows } = await install.owner.query("SELECT class FROM events WHERE type = 'member.role_changed'");
    expect(rows).toEqual([{ class: "security" }]);
  });

  it.each([
    ["Pia's agent, an admin's", () => tokenOf(pia)],
    ["Bob's agent", () => tokenOf(bob)],
    ["Lee's agent, the member whose role changed", () => oauthTokenOf(lee, "tiehall-cli", "cli")],
  ])("never appears in %s events, which hold the requests' domain events", async (_name, caller) => {
    expect(await typesReadBy(caller())).toEqual(["request.opened", "request.opened"]);
  });

  it("never appears in the web UI's events either", async () => {
    const result = await install.web(sessionOf(pia)).read("events.read", {});
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect((result.output as { events: { type: string }[] }).events.map(({ type }) => type)).toEqual(["request.opened", "request.opened"]);
  });

  it("is passed over by a reader that acknowledges past it, whose next read starts after it", async () => {
    const reader = tokenOf(bob);
    const { events } = (await callApi(install, reader, "GET", "/api/v1/events")).body as { events: { number: number }[] };
    await callApi(install, reader, "POST", "/api/v1/events/acknowledge", { upTo: events.at(-1)?.number });
    expect(await typesReadBy(reader)).toEqual([]);
  });
});

describe("a removed member", () => {
  it("reads no events: 403, with a token they approved before the removal", async () => {
    const token = tokenOf(dana);
    expect(await typesReadBy(token)).toEqual(["request.opened", "request.opened"]);
    expect((await install.confirm(sessionOf(pia), "members.remove", { userId: dana })).status).toBe(200);
    const answer = await callApi(install, token, "GET", "/api/v1/events");
    expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/removed-member" }) });
    expect(answer.body).not.toHaveProperty("events");
    expect((await callApi(install, token, "POST", "/api/v1/events/acknowledge", { upTo: 1 })).status).toBe(403);
  });
});

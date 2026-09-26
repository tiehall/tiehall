import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Changes to a proposal and to its request take their locks in one order
// (requests: A confirmed commitment applies only if the request still allows
// it; requests: How a proposal ends without taking effect). A confirmation,
// a rejection, a withdrawal and an undo lock the request first and then the
// proposal, as a change to the request that cancels its proposals does, so two
// of them at once take turns instead of waiting on each other: neither fails,
// and the one that comes second sees what the first did.

let install: TestInstall;
let alice: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall();
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

describe("a confirmation and a new revision at once", () => {
  it("take turns: neither fails, and a confirmation after the revision finds the proposal stale", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 15; round += 1) {
      const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
      await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
      const proposal = (
        await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
          body: { packet: { ...packetOf(), untrusted: { need: "A scope change." } } },
          headers: { "if-match": '"1"' },
        })
      ).body.proposal.id;
      const link = { ...packetOf(), untrusted: { ...(packetOf()["untrusted"] as object), links: [{ url: `https://wiki.example.com/${round}` }] } };
      const [confirmed, revised] = await Promise.all([
        install.confirm(sessionOf(alice), "proposals.confirm", { proposal }),
        sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, { body: { packet: link }, headers: { "if-match": '"1"' } }),
      ]);
      expect([200, 409]).toContain(confirmed.status);
      expect(revised.status).toBe(200);
      outcomes.add(String(confirmed.status));
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });
});

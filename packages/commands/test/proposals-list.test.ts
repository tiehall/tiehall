import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// A request's proposals, as the web UI's page of the request lists them
// (requests: What a proposal records and shows; requests: Every member sees
// every request; agent-surfaces: Negotiated request URLs). Every member reads
// every proposal of every request, newest first, each as proposals.get
// returns it, pending or ended; the read is the web UI's, offered on no agent
// surface, where get_request and the proposal's own read already serve agents.

let install: TestInstall;
let alice: string;
let bob: string;
let carol: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const qa = await addTeam(install.owner, "QA");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  carol = await addUser(install.owner, { login: "carol" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, carol, qa);
});

afterAll(async () => {
  await install?.close();
});

describe("a request's proposals", () => {
  it("are listed newest first to any member, each as proposals.get returns it, pending or ended", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const decline = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    const bobs = sessionOf(bob);
    expect(await install.web(bobs).write("proposals.withdraw", { proposal: decline.body.proposal.id }, install.fromThePage(bobs))).toMatchObject({ ok: true });
    const withdraw = await callApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/proposals`, { kind: "withdraw" });
    expect(withdraw.status).toBe(202);

    const result = await install.web(sessionOf(carol)).read<{ proposals: { id: string; kind: string; state: string }[] }>("proposals.list", { key: request.key });
    expect(result.ok).toBe(true);
    const listed = result.ok ? result.output.proposals : [];
    expect(listed.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: withdraw.body.proposal.id, kind: "withdraw" },
      { id: decline.body.proposal.id, kind: "decline" },
    ]);
    for (const proposal of listed) {
      expect(proposal).toEqual((await callApi(install, tokenOf(carol), "GET", `/api/v1/proposals/${proposal.id}`)).body);
    }
  });

  it("are none for a request nobody proposed anything on, and 404 for a key that names no request", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect(await install.web(sessionOf(carol)).read("proposals.list", { key: request.key })).toEqual({ ok: true, output: { proposals: [] } });
    expect(await install.web(sessionOf(carol)).read("proposals.list", { key: "FE-999" })).toMatchObject({ ok: false, problem: { status: 404 } });
  });

  it("are read on no agent surface", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await expect(install.execute("proposals.list", tokenOf(carol), { key: request.key })).rejects.toMatchObject({ status: 404 });
  });
});

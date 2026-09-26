import { proposalText } from "@tiehall/packet/proposals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, tokenOf } from "./support/requests.ts";

// Commitments over the API answer 202 with a proposal (public-api:
// Commitments over the API answer 202 with a proposal; agent-safety: The
// confirm URL never reaches the model; design.md, Decisions this change rests
// on: D23, D28 #16, #36). The 202 body carries the proposal: the
// confirmations it needs, the accountable human's and, for a due date or a
// scope change while the request is claimed, then the other side's; those it
// has received; and when it expires, 7 days after it was created. Neither the
// body, which agents read as structured content, nor the proposal's text that
// the tools and the CLI print holds a confirm URL, or any /confirm/ path.

let install: TestInstall;
let alice: string;
let bob: string;
const team: Record<string, string> = {};

beforeAll(async () => {
  install = await startTestInstall();
  team["BE"] = await addTeam(install.owner, "BE");
  team["FE"] = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, team["BE"]);
  await joinTeams(install.owner, bob, team["FE"]);
});

afterAll(async () => {
  await install.close();
});

function packetWith(untrusted: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> {
  const packet = packetOf();
  return { ...packet, ...top, untrusted: { ...(packet["untrusted"] as object), ...untrusted } };
}

const addRevision = (user: string, key: string, packet: unknown) =>
  sendApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/packet/revisions`, { body: { packet }, headers: { "if-match": '"1"' } });

const aliceAsUser = () => ({ id: alice, login: "alice", kind: "human", bot: false });
const bobAsUser = () => ({ id: bob, login: "bob", kind: "human", bot: false });

describe("the 202 answer to a commitment", () => {
  it("carries a due date's proposal: Alice's confirmation, then a member of the target team's, neither received, expiring in 7 days", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const answer = await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-15" }));
    expect(answer.status).toBe(202);
    const { proposal } = answer.body;
    expect(proposal.confirmations).toEqual({
      needed: [
        { step: "accountable_human", user: aliceAsUser(), rules: [], team: null },
        { step: "other_side", user: null, rules: ["target_team"], team: { id: team["FE"], key: "FE" } },
      ],
      received: [],
    });
    expect(new Date(proposal.expiresAt).getTime() - new Date(proposal.createdAt).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    const packet = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}/packet`);
    expect(packet.body.packet.due_date).toBeUndefined();
  });

  it("carries a decline's proposal, which needs only Bob's confirmation", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const answer = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    expect(answer.status).toBe(202);
    expect(answer.body.proposal.confirmations).toEqual({
      needed: [{ step: "accountable_human", user: bobAsUser(), rules: [], team: null }],
      received: [],
    });
  });

  it("carries a scope change's proposal on a claimed request, which needs Alice's confirmation and then the claimant's", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const answer = await addRevision(alice, request.key, packetWith({ acceptance_criteria: ["Changed after the claim."] }));
    expect(answer.status).toBe(202);
    expect(answer.body.proposal.confirmations.needed).toEqual([
      { step: "accountable_human", user: aliceAsUser(), rules: [], team: null },
      { step: "other_side", user: null, rules: ["claimant"], team: { id: team["FE"], key: "FE" } },
    ]);
  });
});

describe("the confirm URL", () => {
  it("is in no 202 body and in no proposal text, for every commitment an operation makes", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const claimed = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${claimed.key}/claim`);
    const answers = [
      await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" }),
      await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${claimed.key}/status`, { state: "done" }),
      await addRevision(alice, request.key, packetWith({}, { due_date: "2026-10-15" })),
      await addRevision(alice, claimed.key, packetWith({ need: "A new need." })),
      await addRevision(alice, claimed.key, packetWith({ need: "A new need." }, { due_date: "2026-11-01" })),
    ];
    expect(answers.map(({ status, body }) => [status, body.proposal.kind])).toEqual([
      [202, "decline"],
      [202, "done"],
      [202, "due_date"],
      [202, "scope"],
      [202, "scope"],
    ]);
    for (const { body } of answers) {
      expect(JSON.stringify(body)).not.toMatch(/\/confirm\//);
      const text = proposalText(body.proposal);
      expect(text).toContain(body.proposal.id);
      expect(text).not.toMatch(/\/confirm\/|https?:/);
    }
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ProposalTextError, proposalText, type ProposalJson } from "../src/proposals.ts";

// The shared text of a proposal for the MCP tools and the CLI (public-api:
// Commitments over the API answer 202 with a proposal; agent-safety: The
// confirm URL never reaches the model; agent-surfaces: Commitment tools return
// proposals). A call that makes a commitment gets its proposal back, and the
// tools and the CLI print it in Tiehall's own words: its id, what it proposes
// for which request, the confirmations it needs and those it has received,
// when it expires, and that it waits in a person's web inbox. It carries no
// link at all, so never the confirm URL, and every value it prints is one
// whose form holds no text anyone wrote.

const due: ProposalJson = {
  id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  request: { id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", key: "FE-142" },
  kind: "due_date",
  state: "pending",
  accountableHuman: { id: "a1a1a1a1-0000-4000-8000-000000000001", login: "alice", kind: "human", bot: false },
  confirmations: {
    needed: [
      { step: "accountable_human", user: { id: "a1a1a1a1-0000-4000-8000-000000000001", login: "alice", kind: "human", bot: false }, rules: [], team: null },
      { step: "other_side", user: null, rules: ["target_team"], team: { id: "f0f0f0f0-0000-4000-8000-0000000000fe", key: "FE" } },
    ],
    received: [],
  },
  createdAt: "2026-10-01T09:00:00.000Z",
  expiresAt: "2026-10-08T09:00:00.000Z",
};

const decline: ProposalJson = {
  ...due,
  kind: "decline",
  accountableHuman: { id: "b1b1b1b1-0000-4000-8000-000000000002", login: "bob", kind: "human", bot: false },
  confirmations: {
    needed: [{ step: "accountable_human", user: { id: "b1b1b1b1-0000-4000-8000-000000000002", login: "bob", kind: "human", bot: false }, rules: [], team: null }],
    received: [],
  },
};

describe("a proposal's text", () => {
  it("names the proposal, what it proposes, the confirmations it needs, its expiry and the web inbox", () => {
    expect(proposalText(due)).toBe(
      [
        "Proposal 3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f: change the due date of FE-142. It is pending.",
        "It needs 2 confirmations: first alice's, its accountable human; then one from a member of team FE.",
        "It has received none yet.",
        "It expires at 2026-10-08T09:00:00.000Z, unless every confirmation it needs has come by then.",
        "It waits in alice's web inbox: a person confirms or rejects it there, in Tiehall's web UI, not through an agent.",
      ].join("\n"),
    );
  });

  it("says a commitment that needs one confirmation needs just its accountable human's", () => {
    expect(proposalText(decline).split("\n").slice(0, 2)).toEqual([
      "Proposal 3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f: decline FE-142. It is pending.",
      "It needs 1 confirmation: bob's, its accountable human.",
    ]);
  });

  it("names the confirmations received, and who the proposal waits for next", () => {
    const halfway: ProposalJson = {
      ...due,
      confirmations: {
        ...due.confirmations,
        received: [{ step: "accountable_human", user: due.accountableHuman, confirmedAt: "2026-10-02T10:00:00.000Z" }],
      },
    };
    const lines = proposalText(halfway).split("\n");
    expect(lines).toContain("It has received alice's, at 2026-10-02T10:00:00.000Z.");
    expect(lines.at(-1)).toBe(
      "It waits in the web inboxes of the people who may give the other side's confirmation: a person confirms or rejects it there, in Tiehall's web UI, not through an agent.",
    );
  });

  it.each([
    [["requester_side"], { id: "b0b0b0b0-0000-4000-8000-0000000000be", key: "BE" }, "then one from the requesting user or a member of team BE."],
    [["claimant"], { id: "f0f0f0f0-0000-4000-8000-0000000000fe", key: "FE" }, "then one from the claimant of FE-142, or a member of team FE once the claimant is no longer a member of the install."],
    [["target_team", "claimant"], { id: "f0f0f0f0-0000-4000-8000-0000000000fe", key: "FE" }, "then one from a person who is a member of team FE and the claimant of FE-142, or a member of team FE once the claimant is no longer a member of the install."],
  ] as const)("names the other side for the rules %j", (rules, team, ending) => {
    const proposal: ProposalJson = { ...due, confirmations: { needed: [due.confirmations.needed[0]!, { step: "other_side", user: null, rules: [...rules], team }], received: [] } };
    expect(proposalText(proposal).split("\n")[1]).toBe(`It needs 2 confirmations: first alice's, its accountable human; ${ending}`);
  });

  it.each([
    ["applied", "It took effect."],
    ["rejected", "It was rejected, so it will not take effect."],
    ["withdrawn", "It was withdrawn, so it will not take effect."],
    ["expired", "It expired, so it will not take effect."],
    ["cancelled", "It was cancelled, so it will not take effect."],
  ] as const)("says how a proposal that is %s ended, and points to no inbox", (state, line) => {
    const lines = proposalText({ ...due, state }).split("\n");
    expect(lines).toContain(line);
    expect(lines.join("\n")).not.toMatch(/web inbox/);
  });

  it("refuses a value that does not have its form, without quoting it", () => {
    for (const broken of [
      { ...due, request: { ...due.request, key: "FE-142 /confirm/x" } },
      { ...due, accountableHuman: { ...due.accountableHuman, login: "alice see https://evil.example/confirm/1" } },
      { ...due, kind: "anything" },
      { ...due, expiresAt: "soon" },
    ] as ProposalJson[]) {
      expect(() => proposalText(broken)).toThrow(ProposalTextError);
      try {
        proposalText(broken);
      } catch (error) {
        expect(String((error as Error).message)).not.toMatch(/confirm|evil/);
      }
    }
  });

  it("never holds a confirm URL, or any link, whatever the proposal", () => {
    const login = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,20}$/);
    const user = fc.record({ id: fc.uuid({ version: 4 }), login, kind: fc.constant("human" as const), bot: fc.boolean() });
    const team = fc.record({ id: fc.uuid({ version: 4 }), key: fc.stringMatching(/^[A-Z][A-Z0-9]{1,9}$/) });
    const date = fc.date({ min: new Date("2026-01-01"), max: new Date("2030-01-01"), noInvalidDate: true }).map((day) => day.toISOString());
    const proposals = fc.record({
      id: fc.uuid({ version: 4 }),
      request: fc.record({ id: fc.uuid({ version: 4 }), key: fc.stringMatching(/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,4}$/) }),
      kind: fc.constantFrom("due_date", "scope", "decline", "reassign", "withdraw", "done"),
      state: fc.constantFrom("pending", "applied", "rejected", "withdrawn", "expired", "cancelled"),
      accountableHuman: user,
      confirmations: fc.record({
        needed: fc.array(
          fc.record({
            step: fc.constantFrom("accountable_human", "other_side"),
            user: fc.option(user, { nil: null }),
            rules: fc.subarray(["target_team", "requester_side", "claimant"]),
            team: fc.option(team, { nil: null }),
          }),
          { maxLength: 2 },
        ),
        received: fc.array(fc.record({ step: fc.constantFrom("accountable_human", "other_side"), user, confirmedAt: date }), { maxLength: 2 }),
      }),
      createdAt: date,
      expiresAt: date,
    });
    fc.assert(
      fc.property(proposals, (proposal) => {
        const text = proposalText(proposal as ProposalJson);
        expect(text).not.toMatch(/\/confirm\/|https?:|www\./);
      }),
    );
  });
});

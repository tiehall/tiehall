import { describe, expect, it } from "vitest";
import { changedPacketFields, packetCommitments, SCOPE_FIELDS, type PacketContent } from "../src/packet-changes.ts";

// Which packet fields a change touches, and which of those changes are
// commitments (handoff-packet: Packet changes that are commitments;
// handoff-packet: What changed since revision N; design.md, Decisions this
// change rests on: D23; D28 #14, #15). Scope is the need, the acceptance
// criteria and the contract section. Setting, moving or removing the due date
// after the request was opened is a commitment, and so is a change to scope
// while the request is claimed; any other change is not.

const base: PacketContent = {
  schema_version: "1-beta",
  kind: "request",
  due_date: "2026-10-15",
  untrusted: {
    need: "Add a dark mode.",
    acceptance_criteria: ["It follows the system setting."],
    links: [{ url: "https://wiki.example.com/dark", title: "Dark" }],
    contract: { api: "payments-api", changes: [{ id: "a", level: "ERR", operation: "GET /x" }] },
  },
};

function changed(untrusted: Record<string, unknown>, top: Record<string, unknown> = {}): PacketContent {
  return { ...base, ...top, untrusted: { ...base.untrusted, ...untrusted } };
}

describe("the fields a change touches", () => {
  it.each([
    ["nothing", base, []],
    ["the need", changed({ need: "Add a light mode." }), ["need"]],
    ["the acceptance criteria and the links", changed({ acceptance_criteria: [], links: [] }), ["acceptance_criteria", "links"]],
    ["the due date, removed", { ...base, due_date: undefined }, ["due_date"]],
    ["code refs, added", changed({ code_refs: [{ repository: "acme/web" }] }), ["code_refs"]],
    ["extensions, added", changed({ extensions: { "com.acme.x": {} } }), ["extensions"]],
    ["the kind", { ...base, kind: "contract_change" }, ["kind"]],
  ] as const)("are %s", (_name, after, fields) => {
    expect(changedPacketFields(base, after as PacketContent)).toEqual(fields);
  });

  it("do not count a contract section whose keys are only in another order", () => {
    const reordered = changed({ contract: { changes: [{ operation: "GET /x", level: "ERR", id: "a" }], api: "payments-api" } });
    expect(changedPacketFields(base, reordered)).toEqual([]);
  });
});

describe("the commitments a change makes", () => {
  it("names scope as the need, the acceptance criteria and the contract section", () => {
    expect(SCOPE_FIELDS).toEqual(["need", "acceptance_criteria", "contract"]);
  });

  it.each([
    ["a scope change while unclaimed", changed({ need: "Other." }), false, []],
    ["a scope change while claimed", changed({ need: "Other." }), true, ["scope"]],
    ["new acceptance criteria while claimed", changed({ acceptance_criteria: ["More."] }), true, ["scope"]],
    ["a new contract section while claimed", changed({ contract: { api: "billing-api", changes: [] } }), true, ["scope"]],
    ["new links while claimed", changed({ links: [] }), true, []],
    ["a moved due date while unclaimed", changed({}, { due_date: "2026-10-22" }), false, ["due_date"]],
    ["a removed due date while claimed", { ...base, due_date: undefined }, true, ["due_date"]],
    ["a moved due date and a new need while claimed", changed({ need: "Other." }, { due_date: "2026-10-22" }), true, ["due_date", "scope"]],
    ["nothing", base, true, []],
  ] as const)("are none but those for %s", (_name, after, claimed, commitments) => {
    expect(packetCommitments(base, after as PacketContent, claimed)).toEqual(commitments);
  });
});

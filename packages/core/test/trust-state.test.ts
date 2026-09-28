import { describe, expect, it } from "vitest";
import {
  checkEventTypes,
  memberRemoved,
  memberRoleChanged,
  recordedTrustState,
  setupCompleted,
  TRUST_STATE_EVENT_TYPES,
  trustDifferences,
  trustStateReconciled,
  type TrustEvent,
  type TrustState,
} from "../src/index.ts";

// The nightly comparison of the trust state with the security events
// (activity-log: Trust-state changes are reconciled every night; design.md,
// Technical decisions: T8; design.md, Self-hosting decisions: S14). The
// security events, replayed in order, say who the members are, in which role,
// and which agent-client grants exist; the comparison with the install's
// current state gives one difference per member or grant whose current state
// the events do not record, and each difference becomes a `reconciled`
// security event, which later replays take into account.

const PIA = "1f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d61";
const LEE = "2f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d62";
const BOB = "3f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d63";
const GRANT = "4f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d64";

const roleChanged = (userId: string, role: "admin" | "member", previousRole: "admin" | "member"): TrustEvent => ({
  type: memberRoleChanged.type,
  data: { userId, role, previousRole },
});
const removed = (userId: string): TrustEvent => ({ type: memberRemoved.type, data: { userId, cause: "admin", blocked: true } });
const reconciled = (data: Record<string, unknown>): TrustEvent => ({ type: trustStateReconciled.type, data });

describe("the reconciled event", () => {
  it("is a security event that names what differs: a member with their role, or a grant, and whether it is present", () => {
    expect(trustStateReconciled.class).toBe("security");
    expect(checkEventTypes([trustStateReconciled])).toEqual([]);
    expect(Object.keys(trustStateReconciled.fields).sort()).toEqual(["grantId", "present", "role", "subject", "userId"]);
  });

  it("is among the event types the replay reads, with the role change, the removal and the completion of setup", () => {
    expect(TRUST_STATE_EVENT_TYPES).toEqual([memberRoleChanged.type, memberRemoved.type, trustStateReconciled.type, setupCompleted.type]);
  });
});

describe("the state the security events record", () => {
  it("is empty without events", () => {
    expect(recordedTrustState([])).toEqual({ members: [], grants: [] });
  });

  it("takes a role change as the member's presence in the new role, and a removal as their absence", () => {
    expect(recordedTrustState([roleChanged(LEE, "admin", "member")])).toEqual({ members: [{ userId: LEE, role: "admin" }], grants: [] });
    expect(recordedTrustState([roleChanged(LEE, "admin", "member"), removed(LEE)])).toEqual({ members: [], grants: [] });
  });

  it("takes the completion of setup as the first admin's presence as an admin", () => {
    expect(setupCompleted.class).toBe("security");
    expect(recordedTrustState([{ type: setupCompleted.type, data: { userId: PIA } }])).toEqual({ members: [{ userId: PIA, role: "admin" }], grants: [] });
    expect(recordedTrustState([{ type: setupCompleted.type, data: { userId: PIA } }, roleChanged(PIA, "member", "admin")]).members).toEqual([
      { userId: PIA, role: "member" },
    ]);
  });

  it("lets the latest event about a member win, in the order given", () => {
    const events = [roleChanged(LEE, "admin", "member"), removed(LEE), roleChanged(LEE, "member", "admin"), roleChanged(PIA, "admin", "member")];
    expect(recordedTrustState(events).members).toEqual([
      { userId: PIA, role: "admin" },
      { userId: LEE, role: "member" },
    ]);
  });

  it("takes a reconciled event as what it recorded: a member present in a role, absent, or a grant present or not", () => {
    const events = [
      roleChanged(LEE, "admin", "member"),
      reconciled({ subject: "member", userId: LEE, present: false }),
      reconciled({ subject: "member", userId: BOB, present: true, role: "member" }),
      reconciled({ subject: "grant", userId: PIA, grantId: GRANT, present: true }),
    ];
    expect(recordedTrustState(events)).toEqual({ members: [{ userId: BOB, role: "member" }], grants: [{ grantId: GRANT, userId: PIA }] });
    expect(recordedTrustState([...events, reconciled({ subject: "grant", userId: PIA, grantId: GRANT, present: false })]).grants).toEqual([]);
  });

  it("ignores events of other types, and malformed data, so a replay never throws", () => {
    const events: TrustEvent[] = [
      { type: "request.claimed", data: { requestId: GRANT, userId: LEE } },
      { type: memberRoleChanged.type, data: { role: "admin" } },
      { type: memberRoleChanged.type, data: { userId: LEE, role: "owner" } },
      { type: trustStateReconciled.type, data: { subject: "member", userId: LEE, present: true } },
    ];
    expect(recordedTrustState(events)).toEqual({ members: [], grants: [] });
  });
});

describe("the differences", () => {
  const recorded: TrustState = { members: [{ userId: PIA, role: "admin" }, { userId: LEE, role: "member" }], grants: [{ grantId: GRANT, userId: PIA }] };

  it("are none when the current state is what the events record, whatever the order", () => {
    const current: TrustState = { members: [{ userId: LEE, role: "member" }, { userId: PIA, role: "admin" }], grants: [{ grantId: GRANT, userId: PIA }] };
    expect(trustDifferences(current, recorded)).toEqual([]);
  });

  it("name a member whose role is not the recorded one, with the role they hold now", () => {
    const current: TrustState = { ...recorded, members: [{ userId: PIA, role: "admin" }, { userId: LEE, role: "admin" }] };
    expect(trustDifferences(current, recorded)).toEqual([{ subject: "member", userId: LEE, present: true, role: "admin" }]);
  });

  it("name a member no event records, with their role, and a recorded member who is no longer one", () => {
    const current: TrustState = { ...recorded, members: [{ userId: PIA, role: "admin" }, { userId: BOB, role: "member" }] };
    expect(trustDifferences(current, recorded)).toEqual([
      { subject: "member", userId: LEE, present: false },
      { subject: "member", userId: BOB, present: true, role: "member" },
    ]);
  });

  it("name a grant no event records, and a recorded grant that is gone", () => {
    const other = "5f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d65";
    const current: TrustState = { ...recorded, grants: [{ grantId: other, userId: LEE }] };
    expect(trustDifferences(current, recorded)).toEqual([
      { subject: "grant", userId: PIA, grantId: GRANT, present: false },
      { subject: "grant", userId: LEE, grantId: other, present: true },
    ]);
  });

  it("are in a fixed order: members by user id, then grants by grant id", () => {
    const current: TrustState = { members: [{ userId: BOB, role: "member" }], grants: [] };
    const none: TrustState = { members: [{ userId: LEE, role: "member" }], grants: [{ grantId: GRANT, userId: PIA }] };
    expect(trustDifferences(current, none).map((difference) => `${difference.subject}:${difference.subject === "grant" ? difference.grantId : difference.userId}`)).toEqual([
      `member:${LEE}`,
      `member:${BOB}`,
      `grant:${GRANT}`,
    ]);
  });

  it("each replay as the state they name, so the next comparison finds nothing", () => {
    const current: TrustState = { members: [{ userId: PIA, role: "admin" }, { userId: BOB, role: "admin" }], grants: [] };
    const differences = trustDifferences(current, recorded);
    const events = differences.map((difference) => reconciled({ ...difference }));
    const replayed = recordedTrustState([
      roleChanged(PIA, "admin", "member"),
      roleChanged(LEE, "member", "admin"),
      reconciled({ subject: "grant", userId: PIA, grantId: GRANT, present: true }),
      ...events,
    ]);
    expect(trustDifferences(current, replayed)).toEqual([]);
  });
});

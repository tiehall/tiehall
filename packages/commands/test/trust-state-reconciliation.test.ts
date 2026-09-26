import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileTrustState, WORKER_JOBS, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";

// Trust-state changes are reconciled every night (activity-log: Trust-state
// changes are reconciled every night; activity-log: Which actions are security
// events; design.md, Technical decisions: T8; design.md, Self-hosting
// decisions: S14). A nightly worker job compares the install's members, their
// roles and the agent-client grants with what the security events record, and
// appends one `activity_log.reconciled` security event, as the system's, for
// each difference: a member whose membership or role no event records, or a
// recorded member who is gone. A change stored without its event, such as one
// lost between a write the sign-in service owns and its event, so still
// reaches the activity log; a clean state adds nothing.

let install: TestInstall;
let pia: WebSessionCaller;
let lee: string;

beforeAll(async () => {
  install = await startTestInstall();
  // Added as the owner, so no security event records them yet.
  pia = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "pia" }), sessionId: randomUUID() };
  lee = await addUser(install.owner, { role: "member", login: "lee" });
});

afterAll(async () => {
  await install.close();
});

interface Reconciled {
  number: number;
  class: string;
  actor_kind: string;
  actor_user_id: string | null;
  data: Record<string, unknown>;
}

/** Every reconciled event so far, oldest first. */
async function reconciledEvents(): Promise<Reconciled[]> {
  const { rows } = await install.owner.query<Reconciled>(
    "SELECT number::int AS number, class, actor_kind, actor_user_id, data FROM events WHERE type = 'activity_log.reconciled' ORDER BY number",
  );
  return rows;
}

/** Runs the nightly comparison once, as the worker does, and returns the reconciled events it appended. */
async function reconcile(): Promise<Record<string, unknown>[]> {
  const before = (await reconciledEvents()).length;
  await reconcileTrustState.handle(
    { id: "reconcile", queue: reconcileTrustState.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date() },
  );
  return (await reconciledEvents()).slice(before).map(({ data }) => data);
}

describe("the nightly comparison", () => {
  it("records, once, each member whose membership no security event records, and then a clean state adds none", async () => {
    const expected = [
      { userId: pia.userId, role: "admin" },
      { userId: lee, role: "member" },
    ]
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .map(({ userId, role }) => ({ subject: "member", userId, present: true, role }));
    expect(await reconcile()).toEqual(expected);
    const [first] = await reconciledEvents();
    expect(first).toMatchObject({ class: "security", actor_kind: "system", actor_user_id: null });
    expect(await reconcile()).toEqual([]);
  });

  it("a role change stored while its event was dropped gains a reconciled event naming the member and the role they hold now", async () => {
    // As if the change had been stored and the process stopped before its event was appended.
    await install.owner.query("UPDATE members SET role = 'admin' WHERE user_id = $1", [lee]);
    expect(await reconcile()).toEqual([{ subject: "member", userId: lee, present: true, role: "admin" }]);
    expect(await reconcile()).toEqual([]);
  });

  it("a removal stored while its event was dropped gains a reconciled event naming the member as gone", async () => {
    const dana = await addUser(install.owner, { role: "member", login: "dana" });
    expect(await reconcile()).toEqual([{ subject: "member", userId: dana, present: true, role: "member" }]);
    await install.owner.query("DELETE FROM members WHERE user_id = $1", [dana]);
    expect(await reconcile()).toEqual([{ subject: "member", userId: dana, present: false }]);
    expect(await reconcile()).toEqual([]);
  });

  it("finds nothing to reconcile after a change made through a command, whose event commits with it", async () => {
    expect((await install.confirm(pia, "members.change_role", { userId: lee, role: "member" })).status).toBe(200);
    expect(await reconcile()).toEqual([]);
    expect((await install.confirm(pia, "members.remove", { userId: lee })).status).toBe(200);
    expect(await reconcile()).toEqual([]);
  });

  it("runs every night in the worker, as a system action that starts no job", () => {
    expect(WORKER_JOBS).toContain(reconcileTrustState);
    // Once a night, in UTC.
    expect(reconcileTrustState.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });
});

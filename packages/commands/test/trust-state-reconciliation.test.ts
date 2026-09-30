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
// each difference: a member whose membership or role no event records, a
// recorded member who is gone, or an agent grant that exists or is gone
// without its event. A change stored without its event, such as one lost
// between a write the sign-in service owns and its event, so still reaches the
// activity log; a clean state adds nothing.

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

  it("a grant stored while its event was dropped gains a reconciled event naming it, and one revoked without its event gains one naming it gone", async () => {
    // As if the approval had been stored and the process stopped before its event was appended.
    const clientId = `client-${randomUUID()}`;
    await install.owner.query(
      "INSERT INTO oauth_clients (org_id, client_id, name, redirect_uris) SELECT id, $1, 'An agent', ARRAY['http://127.0.0.1:53682/callback'] FROM orgs",
      [clientId],
    );
    const { rows } = await install.owner.query<{ id: string }>(
      "INSERT INTO oauth_consents (org_id, client_id, user_id, scopes, created_at, updated_at) SELECT id, $1, $2, ARRAY['requests:read'], now(), now() FROM orgs RETURNING id",
      [clientId, pia.userId],
    );
    const grantId = rows[0]?.id;
    expect(await reconcile()).toEqual([{ subject: "grant", userId: pia.userId, grantId, present: true }]);
    expect(await reconcile()).toEqual([]);
    await install.owner.query("DELETE FROM oauth_consents WHERE id = $1", [grantId]);
    expect(await reconcile()).toEqual([{ subject: "grant", userId: pia.userId, grantId, present: false }]);
    expect(await reconcile()).toEqual([]);
  });

  it("finds nothing to reconcile after an approval and a revocation made through their commands, whose events commit with them", async () => {
    const clientId = `client-${randomUUID()}`;
    await install.owner.query(
      "INSERT INTO oauth_clients (org_id, client_id, name, redirect_uris) SELECT id, $1, 'An agent', ARRAY['http://127.0.0.1:53682/callback'] FROM orgs",
      [clientId],
    );
    const authorization = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1:53682/callback", scope: "requests:read" }).toString();
    expect((await install.confirm(pia, "agent_clients.approve", { authorization })).status).toBe(303);
    expect(await reconcile()).toEqual([]);
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM oauth_consents WHERE client_id = $1", [clientId]);
    expect(await install.web(pia).write("agent_grants.revoke", { grantId: rows[0]?.id }, install.fromThePage(pia))).toMatchObject({ ok: true });
    expect(await reconcile()).toEqual([]);
  });

  it("runs every night in the worker, as a system action that starts no job", () => {
    expect(WORKER_JOBS).toContain(reconcileTrustState);
    // Once a night, in UTC.
    expect(reconcileTrustState.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });
});

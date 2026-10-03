import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { holdRow, untilWaiting } from "./support/locks.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf, tokenOf } from "./support/requests.ts";

// A removal takes effect on the removed member's next call, and no write in
// flight names them as its actor after it (teams-and-roles: Membership is
// re-checked on every call; teams-and-roles: Removing a member; design.md,
// Design rules: Teams and roles). A write made for a user reads the user's
// membership row FOR KEY SHARE before it judges anything (with-org.ts), the
// first lock of the lock order (event-sequence.ts), so a removal that comes
// while the write is in flight waits for it to commit, and one that came first
// leaves the write to find the user gone: 403 removed-member. Each case holds
// a row the write needs once it is past its check of the membership, so the
// removal runs while the write waits, every time the test runs.

let install: TestInstall;
let ada: string;
let fe: string;

beforeAll(async () => {
  install = await startTestInstall();
  ada = await addUser(install.owner, { login: "ada-writes", role: "admin" });
  fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, ada, fe);
}, 60_000);

afterAll(async () => {
  await install?.close();
});

/** The numbers of the events that record this user's actions, and of the user's removal. */
async function eventsOf(userId: string): Promise<{ acted: number[]; removed: number | undefined }> {
  const { rows } = await install.owner.query<{ number: string; type: string; actor_user_id: string | null; data: { userId?: string } }>(
    "SELECT number, type, actor_user_id, data FROM events ORDER BY number",
  );
  const removed = rows.find(({ type, data }) => type === "member.removed" && data.userId === userId);
  return {
    acted: rows.filter(({ actor_user_id, type }) => actor_user_id === userId && type !== "member.removed").map(({ number }) => Number(number)),
    removed: removed === undefined ? undefined : Number(removed.number),
  };
}

describe("a removal while a write made for the member is in flight", () => {
  it.each([
    ["a web session", (userId: string) => sessionOf(userId)],
    ["a personal access token", (userId: string) => tokenOf(userId)],
  ])("never lets the write commit after the removal naming the member, made through %s", async (_through, callerOf) => {
    const dana = await addUser(install.owner, { login: `dana-${Math.random().toString(36).slice(2, 8)}` });
    await joinTeams(install.owner, dana, fe);
    const request = await openRequestInTheWebUi<{ id: string; key: string }>(install, ada, { targetTeam: "FE" });
    // Dana's comment, past its check of Dana's membership, waits for the request's row, which the test holds.
    const held = await holdRow(install.databaseUrl, "SELECT id FROM requests WHERE id = $1 FOR UPDATE", [request.id]);
    const writing = install.execute("messages.post", callerOf(dana), { key: request.key, kind: "comment", body: "Still here?" }).then(
      () => "committed" as const,
      (error: unknown) => error,
    );
    await untilWaiting(install.owner, 1);
    let removed = false;
    const removal = install.confirm(sessionOf(ada), "members.remove", { userId: dana }).finally(() => {
      removed = true;
    });
    // The removal either waits for Dana's write, or, before the fix, runs to its end at once.
    await untilWaiting(install.owner, 2, () => removed);
    await held.release();
    expect((await removal).status).toBe(200);
    const outcome = await writing;

    const { acted, removed: removedAt } = await eventsOf(dana);
    expect(removedAt).toBeDefined();
    if (outcome === "committed") {
      expect(acted.length).toBeGreaterThan(0);
      for (const number of acted) expect(number).toBeLessThan(removedAt!);
    } else {
      expect(outcome).toMatchObject({ reason: "removed-member", status: 403 });
      expect(acted).toEqual([]);
    }
  });
});

// The changes to who is a member lock the admins' rows first and judge their caller only once they hold them, so two
// admins who remove each other at once wait in a line rather than on each other (member-changes.ts).
describe("two admins removing each other at once", () => {
  it("take their turns: one removal applies, and the other, made by the admin it removed, gets 403 removed-member", async () => {
    for (let round = 0; round < 4; round += 1) {
      const kim = await addUser(install.owner, { login: `kim-${round}`, role: "admin" });
      const lou = await addUser(install.owner, { login: `lou-${round}`, role: "admin" });
      const answers = await Promise.all([
        install.confirm(sessionOf(kim), "members.remove", { userId: lou }),
        install.confirm(sessionOf(lou), "members.remove", { userId: kim }),
      ]);
      const statuses = answers.map(({ status }) => status);
      expect(statuses.sort()).toEqual([200, 403]);
      const refused = answers.find(({ status }) => status === 403)!;
      expect(await refused.text()).toContain("removed-member");
      const { rows } = await install.owner.query("SELECT count(*)::int AS left FROM members WHERE user_id = ANY($1)", [[kim, lou]]);
      expect(rows).toEqual([{ left: 1 }]);
    }
  });
});

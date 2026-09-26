import { setTimeout as delay } from "node:timers/promises";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { takeRequestNumber, withOrg, type OrgContext } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";

// Per-team request keys (requests: Per-team request keys; design.md, Design
// rules: Requests and events). A request's key is its target team's key and a
// number from a count kept per team. The transaction that creates the request
// takes the number, which locks the team's count until it ends: numbers never
// repeat within a team, a create that rolls back gives its number back unused,
// so no number is ever skipped or used twice, and each team counts on its own.

let install: TestInstall;
let requesterId: string;
/** The teams the property opens requests to, by key; BE opens them all. */
const teams = new Map<string, string>();

beforeAll(async () => {
  install = await startTestInstall();
  requesterId = await addUser(install.owner, { login: "alice" });
  for (const key of ["BE", "FE", "MOB", "OPS"]) {
    const { rows } = await install.owner.query<{ id: string }>(
      "INSERT INTO teams (org_id, key, name) SELECT id, $1, $1 FROM orgs RETURNING id",
      [key],
    );
    teams.set(key, rows[0]?.id ?? "");
  }
});

afterAll(async () => {
  await install.close();
});

class RolledBack extends Error {}

/** Creates a request to the team in its own transaction, as requests.create will: the number, then the row. */
async function create(teamKey: string, options: { before?: number; between?: number; rollBack?: boolean } = {}): Promise<number | undefined> {
  try {
    return await withOrg(install.db, async (context: OrgContext) => {
      if (options.before) await delay(options.before);
      const number = await takeRequestNumber(context, teams.get(teamKey) ?? "");
      if (options.between) await delay(options.between);
      await context.tx.execute(
        `INSERT INTO requests (org_id, target_team_id, number, title, requesting_user_id, requesting_team_id)
         VALUES ('${context.orgId}', '${teams.get(teamKey)}', ${number}, 'A request', '${requesterId}', '${teams.get("BE")}')`,
      );
      if (options.rollBack) throw new RolledBack();
      return number;
    });
  } catch (error) {
    if (error instanceof RolledBack) return undefined;
    throw error;
  }
}

/** The numbers of every stored request of each team, in order. */
async function storedNumbers(): Promise<Map<string, number[]>> {
  const { rows } = await install.owner.query<{ key: string; number: number }>(
    "SELECT t.key, r.number FROM requests r JOIN teams t ON t.org_id = r.org_id AND t.id = r.target_team_id ORDER BY t.key, r.number",
  );
  const numbers = new Map<string, number[]>([...teams.keys()].map((key) => [key, []]));
  for (const { key, number } of rows) numbers.get(key)?.push(number);
  return numbers;
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

describe("the per-team count", () => {
  it("gives the next number of the team, and each team counts on its own", async () => {
    const before = await storedNumbers();
    const fe = before.get("FE")?.length ?? 0;
    const be = before.get("BE")?.length ?? 0;
    expect(await create("FE")).toBe(fe + 1);
    expect(await create("FE")).toBe(fe + 2);
    // A request to BE right after FE's takes BE's next number, and FE's next is still its own.
    expect(await create("BE")).toBe(be + 1);
    expect(await create("FE")).toBe(fe + 3);
  });

  it("gives a rolled-back create's number to the next create, so no stored number is skipped", async () => {
    const next = (await storedNumbers()).get("MOB")?.length ?? 0;
    expect(await create("MOB", { rollBack: true })).toBeUndefined();
    expect(await create("MOB")).toBe(next + 1);
  });

  it("never repeats or reuses a number, whatever the interleaving of concurrent creates across teams", async () => {
    const create$ = fc.record({
      team: fc.constantFrom(...teams.keys()),
      before: fc.integer({ min: 0, max: 4 }),
      between: fc.integer({ min: 0, max: 4 }),
      rollBack: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(create$, { minLength: 1, maxLength: 16 }), async (creates) => {
        const before = await storedNumbers();
        // Every create runs at once, each in its own transaction, and the delays shuffle where they wait.
        const numbers = await Promise.all(creates.map(({ team, ...options }) => create(team, options)));
        const after = await storedNumbers();
        for (const team of teams.keys()) {
          const had = before.get(team) ?? [];
          const taken = creates.flatMap((each, index) => (each.team === team && numbers[index] !== undefined ? [numbers[index]] : []));
          // The committed creates of this team, and only they, took the numbers right after the ones it had.
          expect([...taken].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(range(had.length + 1, taken.length));
          // Stored numbers run from 1 with no gap and no repeat: no number was reused or skipped.
          expect(after.get(team)).toEqual(range(1, had.length + taken.length));
        }
      }),
      { numRuns: 25 },
    );
  });
});

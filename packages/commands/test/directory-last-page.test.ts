import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { connectMcp, mcpPerson, PROTOCOL_VERSIONS, resultSize, type McpPerson } from "./support/mcp.ts";

// agent-surfaces: The MCP tools; decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (39), as
// the maintainer answered on 2026-10-12. A team or an API that fits on a page that begins with it is never split, and
// a page ends before one only when it would take the page past the 32,000 characters. The last team or API of the
// directory is followed by no page, so the page that takes it answers with no cursor and is measured so: one that
// fits on that last page, as it answers, is listed there whole, and not split across a page whose cursor alone would
// take it past the cap. Each case sets the install's teams to a multiple of 50, so that the last page of teams is full
// and the last team, or an API too long to share that page, begins the last page; and it fits that page to the cap by
// measuring the page twice, a page growing by the same characters for each team of a list, or for each character of
// a team's notes.

const version = PROTOCOL_VERSIONS[0];
/** The teams that lists name: LW0001 to LW0600. */
const LISTED = Array.from({ length: 600 }, (_, index) => `LW${String(index + 1).padStart(4, "0")}`);

let harness: AgentAccessHarness;
let dana: McpPerson;

beforeAll(async () => {
  harness = await startAgentAccess();
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  await harness.install.owner.query("INSERT INTO teams (org_id, key, name) SELECT o.id, k.key, 'Team ' || k.key FROM orgs o, unnest($1::text[]) AS k(key)", [LISTED]);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** A page of directory as Dana's agent reads it: its structured content and its size. */
interface ReadPage {
  page: {
    teams: { id: string; key: string; intakeNotesWrittenBy: unknown[] | null; continuedFromPreviousPage?: boolean; continuedOnNextPage?: boolean }[];
    apis: { id: string; consumers: unknown[]; continuedFromPreviousPage?: boolean; continuedOnNextPage?: boolean }[];
    next: string | null;
  };
  size: number;
}

async function readPage(cursor: string | undefined): Promise<ReadPage> {
  const client = await connectMcp(harness, { token: dana.token, version });
  try {
    const result = await client.callTool({ name: "directory", arguments: cursor === undefined ? {} : { cursor } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return { page: result.structuredContent as ReadPage["page"], size: resultSize(result as never) };
  } finally {
    await client.close();
  }
}

/** Every page from this cursor on, or from the first. */
async function readFrom(cursor: string | undefined): Promise<ReadPage[]> {
  const pages: ReadPage[] = [];
  for (;;) {
    const read = await readPage(cursor);
    pages.push(read);
    if (read.page.next === null) return pages;
    cursor = read.page.next;
    expect(pages.length).toBeLessThan(40);
  }
}

/** Adds teams that come before every other's key, LA00001 on, until the install has a multiple of 50; returns their keys. */
async function fillToFifty(): Promise<string[]> {
  const { rows } = await harness.install.owner.query<{ count: number }>("SELECT count(*)::int AS count FROM teams");
  const keys = Array.from({ length: (50 - ((rows[0]?.count ?? 0) % 50)) % 50 }, (_, index) => `LA${String(index + 1).padStart(5, "0")}`);
  await harness.install.owner.query("INSERT INTO teams (org_id, key, name) SELECT o.id, k.key, k.key FROM orgs o, unnest($1::text[]) AS k(key)", [keys]);
  return keys;
}

/** The cursor of the last page, which begins with the last team or API, as the page before it names it. */
async function cursorOfLastPage(): Promise<string> {
  const pages = await readFrom(undefined);
  const before = pages.at(-2)?.page.next;
  if (before === undefined || before === null) throw new Error("The directory has a single page.");
  return before;
}

/** The last page, from its cursor, which must list this team or API whole and alone. */
async function lastPageWith(cursor: string, id: string): Promise<ReadPage> {
  const [last, ...more] = await readFrom(cursor);
  expect(more).toEqual([]);
  expect([...last!.page.teams, ...last!.page.apis].map((entry) => entry.id)).toEqual([id]);
  return last!;
}

describe("directory's last page", () => {
  it("lists the last team whole on the last page when it fits there with no cursor", async () => {
    const { owner } = harness.install;
    const fillers = await fillToFifty();
    // ZZW, the last team by key, after a multiple of 50: its notes' writer belonged to 420 of the listed teams.
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO teams (org_id, key, name, intake_notes, intake_notes_writer_team_ids)
       SELECT o.id, 'ZZW', 'Last writers', '', (SELECT array_agg(id) FROM teams WHERE key = ANY($1)) FROM orgs o RETURNING id`,
      [LISTED.slice(0, 420)],
    );
    const id = rows[0]?.id ?? "";
    try {
      const cursor = await cursorOfLastPage();
      const sizeWith = async (characters: number): Promise<number> => {
        await owner.query("UPDATE teams SET intake_notes = repeat('a', $1) WHERE id = $2", [characters, id]);
        return (await lastPageWith(cursor, id)).size;
      };
      // Each character of the notes adds the same characters to the page.
      const at10 = await sizeWith(10);
      const each = ((await sizeWith(20)) - at10) / 10;
      const fitting = 10 + Math.floor((32_000 - at10) / each);
      expect(fitting).toBeLessThanOrEqual(4_000);
      await owner.query("UPDATE teams SET intake_notes = repeat('a', $1) WHERE id = $2", [fitting, id]);

      const pages = await readFrom(undefined);
      const parts = pages.flatMap(({ page }) => page.teams.filter((team) => team.id === id));
      expect(parts).toHaveLength(1);
      expect(parts[0]).not.toHaveProperty("continuedFromPreviousPage");
      expect(parts[0]).not.toHaveProperty("continuedOnNextPage");
      expect(parts[0]?.intakeNotesWrittenBy).toHaveLength(420);
      const last = pages.at(-1)!;
      expect(last.page.teams.map((team) => team.id)).toEqual([id]);
      expect(last.page.next).toBeNull();
      expect(last.size).toBeLessThanOrEqual(32_000);
      expect(last.size).toBeGreaterThan(32_000 - each);
    } finally {
      await owner.query("DELETE FROM teams WHERE id = $1 OR key = ANY($2)", [id, fillers]);
    }
  });

  it("lists the last API whole on the last page when it fits there with no cursor", async () => {
    const { owner } = harness.install;
    const fillers = await fillToFifty();
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO apis (org_id, name, provider_team_id, repository_id, repository_owner_id, repository_full_name, registered_by)
       SELECT o.id, 'zz-last-api', t.id, 9900, 9000, 'acme/zz-last-api', $1 FROM orgs o JOIN teams t ON t.org_id = o.id AND t.key = 'FE' RETURNING id`,
      [dana.userId],
    );
    const id = rows[0]?.id ?? "";
    const consumedBy = async (count: number): Promise<void> => {
      await owner.query("DELETE FROM api_consumers WHERE api_id = $1", [id]);
      await owner.query(
        `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
         SELECT org_id, $1, id, $3, now(), now() FROM teams WHERE key = ANY($2)`,
        [id, LISTED.slice(0, count), dana.userId],
      );
    };
    try {
      // With 420 consumers the API no longer fits beside the last page's 50 teams, and begins the last page.
      await consumedBy(420);
      const cursor = await cursorOfLastPage();
      const sizeWith = async (count: number): Promise<number> => {
        await consumedBy(count);
        return (await lastPageWith(cursor, id)).size;
      };
      // Each consumer adds the same characters to the page.
      const at420 = await sizeWith(420);
      const each = ((await sizeWith(440)) - at420) / 20;
      const fitting = 420 + Math.floor((32_000 - at420) / each);
      expect(fitting).toBeLessThanOrEqual(LISTED.length);
      await consumedBy(fitting);

      const pages = await readFrom(undefined);
      const parts = pages.flatMap(({ page }) => page.apis.filter((api) => api.id === id));
      expect(parts).toHaveLength(1);
      expect(parts[0]).not.toHaveProperty("continuedFromPreviousPage");
      expect(parts[0]).not.toHaveProperty("continuedOnNextPage");
      expect(parts[0]?.consumers).toHaveLength(fitting);
      const last = pages.at(-1)!;
      expect(last.page.apis.map((api) => api.id)).toEqual([id]);
      expect(last.page.next).toBeNull();
      expect(last.size).toBeLessThanOrEqual(32_000);
      expect(last.size).toBeGreaterThan(32_000 - each);
    } finally {
      await owner.query("DELETE FROM api_consumers WHERE api_id = $1", [id]);
      await owner.query("DELETE FROM apis WHERE id = $1", [id]);
      await owner.query("DELETE FROM teams WHERE key = ANY($1)", [fillers]);
    }
  });
});

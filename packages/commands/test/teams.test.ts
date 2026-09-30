import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller, WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";

// Teams (teams-and-roles: Teams; teams-and-roles: What admins and members may
// do; teams-and-roles: One org per install). The install's teams live in
// Tiehall's own records, and only admins manage them, in the web UI: they
// create teams, rename them, change their keys, and add people to them and
// remove them. A user can belong to several teams, and a team may have no
// members. A team's name is 1 to 100 characters once its leading and trailing
// blanks are removed, and any other gets 400 (design.md, Decisions: D45 (2)).
// Who belongs to a team is never taken from GitHub teams or any other outside
// source.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

let install: TestInstall;
let ada: WebSessionCaller;
let dana: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  dana = { kind: "web_session", userId: await addUser(install.owner, { role: "member", login: "dana" }), sessionId: randomUUID() };
});

afterAll(async () => {
  await install.close();
});

interface Team {
  id: string;
  key: string;
  name: string;
}

/** Runs a team operation from the web UI's form, as the signed-in session. */
function submit(caller: WebSessionCaller, commandId: string, input: unknown) {
  return install.web(caller).write(commandId, input, install.fromThePage(caller));
}

async function createTeam(key: string, name: string): Promise<Team> {
  const result = await submit(ada, "teams.create", { key, name });
  if (!result.ok) throw new Error(`teams.create failed: ${JSON.stringify(result.problem)}`);
  return result.output as Team;
}

/** The keys of the teams a user belongs to, in order. */
async function teamsOf(userId: string): Promise<string[]> {
  const { rows } = await install.owner.query<{ key: string }>(
    "SELECT t.key FROM team_members m JOIN teams t ON t.org_id = m.org_id AND t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.key",
    [userId],
  );
  return rows.map(({ key }) => key);
}

/** Every team with its members' ids, to show that a refused change changed nothing. */
async function allTeams(): Promise<unknown[]> {
  const { rows } = await install.owner.query(
    `SELECT t.key, t.name, coalesce(array_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
       FROM teams t LEFT JOIN team_members m ON m.org_id = t.org_id AND m.team_id = t.id
      GROUP BY t.key, t.name ORDER BY t.key`,
  );
  return rows;
}

describe("an admin", () => {
  it("creates a team that nobody belongs to, and it exists with no members", async () => {
    const mob = await createTeam("MOB", "Mobile");
    expect(mob).toEqual({ id: expect.any(String), key: "MOB", name: "Mobile" });
    expect(await allTeams()).toContainEqual({ key: "MOB", name: "Mobile", members: [] });
  });

  it("adds a member of one team to a second, who then belongs to both", async () => {
    const be = await createTeam("BE", "Backend");
    const fe = await createTeam("FE", "Frontend");
    expect(await submit(ada, "teams.add_member", { teamId: be.id, userId: dana.userId })).toEqual({
      ok: true,
      output: { teamId: be.id, userId: dana.userId },
    });
    await submit(ada, "teams.add_member", { teamId: fe.id, userId: dana.userId });
    expect(await teamsOf(dana.userId)).toEqual(["BE", "FE"]);
    // Adding someone who is already in the team changes nothing.
    expect((await submit(ada, "teams.add_member", { teamId: fe.id, userId: dana.userId })).ok).toBe(true);
    expect(await teamsOf(dana.userId)).toEqual(["BE", "FE"]);
  });

  it("removes a person from a team, leaving their other teams", async () => {
    const ops = await createTeam("OPS", "Operations");
    const web = await createTeam("WEBX", "Web");
    const lee = await addUser(install.owner, { role: "member", login: "lee" });
    await submit(ada, "teams.add_member", { teamId: ops.id, userId: lee });
    await submit(ada, "teams.add_member", { teamId: web.id, userId: lee });
    expect(await submit(ada, "teams.remove_member", { teamId: ops.id, userId: lee })).toEqual({
      ok: true,
      output: { teamId: ops.id, userId: lee },
    });
    expect(await teamsOf(lee)).toEqual(["WEBX"]);
    expect(await teamsOf(ada.userId)).toEqual([]);
  });

  it("renames a team and changes its key", async () => {
    const pay = await createTeam("PAY", "Payments");
    expect(await submit(ada, "teams.rename", { teamId: pay.id, name: "Payments and billing" })).toEqual({
      ok: true,
      output: { id: pay.id, key: "PAY", name: "Payments and billing" },
    });
    expect(await submit(ada, "teams.change_key", { teamId: pay.id, key: "BILL" })).toEqual({
      ok: true,
      output: { id: pay.id, key: "BILL", name: "Payments and billing" },
    });
  });

  it("gets 400 for a name of 101 characters or of blanks only, creating a team or renaming one, and nothing changes", async () => {
    const ux = await createTeam("UX", "Design");
    const before = await allTeams();
    for (const name of ["n".repeat(101), "   "]) {
      for (const [commandId, input] of [
        ["teams.create", { key: "UXR", name }],
        ["teams.rename", { teamId: ux.id, name }],
      ] as const) {
        expect(await submit(ada, commandId, input), `${commandId} with a name of ${name.length}`).toMatchObject({
          ok: false,
          problem: { status: 400, type: "https://tiehall.com/problems/invalid-input" },
        });
      }
    }
    expect(await allTeams()).toEqual(before);
  });

  it("accepts a name of 100 characters, creating a team and renaming one", async () => {
    const team = await createTeam("LONG", "l".repeat(100));
    expect(team.name).toBe("l".repeat(100));
    expect(await submit(ada, "teams.rename", { teamId: team.id, name: "m".repeat(100) })).toEqual({
      ok: true,
      output: { id: team.id, key: "LONG", name: "m".repeat(100) },
    });
  });

  it("gets 404 for a team that does not exist, or a person who is not a member of the install, and changes nothing", async () => {
    const qa = await createTeam("QA", "Quality");
    const outsider = await addUser(install.owner, { role: null, login: "outsider" });
    const before = await allTeams();
    for (const [commandId, input] of [
      ["teams.add_member", { teamId: randomUUID(), userId: dana.userId }],
      ["teams.add_member", { teamId: qa.id, userId: outsider }],
      ["teams.add_member", { teamId: qa.id, userId: randomUUID() }],
      ["teams.rename", { teamId: randomUUID(), name: "Nobody" }],
      ["teams.change_key", { teamId: randomUUID(), key: "NONE" }],
      ["teams.remove_member", { teamId: randomUUID(), userId: dana.userId }],
    ] as const) {
      expect(await submit(ada, commandId, input), commandId).toMatchObject({ ok: false, problem: { status: 404 } });
    }
    expect(await allTeams()).toEqual(before);
  });
});

describe("a member", () => {
  it("who submits the form that creates a team gets 403, and no team is created", async () => {
    const before = await allTeams();
    expect(await submit(dana, "teams.create", { key: "MOB2", name: "Mobile" })).toMatchObject({
      ok: false,
      problem: { status: 403, type: "https://tiehall.com/problems/forbidden" },
    });
    expect(await allTeams()).toEqual(before);
  });

  it("gets 403 for every other change to teams, and nothing changes", async () => {
    const [team] = (await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'BE'")).rows;
    const teamId = team?.id ?? "";
    const before = await allTeams();
    for (const [commandId, input] of [
      ["teams.rename", { teamId, name: "Ours now" }],
      ["teams.change_key", { teamId, key: "OURS" }],
      ["teams.add_member", { teamId, userId: dana.userId }],
      ["teams.remove_member", { teamId, userId: dana.userId }],
    ] as const) {
      expect(await submit(dana, commandId, input), commandId).toMatchObject({ ok: false, problem: { status: 403 } });
    }
    expect(await allTeams()).toEqual(before);
  });
});

describe("a change to a team in GitHub", () => {
  it("changes no Tiehall team: a GitHub event or a job cannot run a team operation", async () => {
    const [team] = (await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'FE'")).rows;
    const teamId = team?.id ?? "";
    const before = await allTeams();
    const fromGitHub: Caller[] = [
      { kind: "integration_event", source: "github" },
      { kind: "integration_event", source: "github", userId: ada.userId },
      { kind: "system_job", job: "github.reconcile_membership" },
    ];
    for (const caller of fromGitHub) {
      await expect(install.execute("teams.add_member", caller, { teamId, userId: ada.userId }), caller.kind).rejects.toMatchObject({ status: 403 });
      await expect(install.execute("teams.remove_member", caller, { teamId, userId: dana.userId }), caller.kind).rejects.toMatchObject({
        status: 403,
      });
      await expect(install.execute("teams.create", caller, { key: "GH", name: "frontend" }), caller.kind).rejects.toMatchObject({ status: 403 });
    }
    expect(await allTeams()).toEqual(before);
  });

  it("has nowhere to land: the team tables hold nothing from GitHub, and only the team operations write them", async () => {
    const { rows } = await install.owner.query<{ table: string; column: string }>(
      `SELECT table_name AS table, column_name AS column FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('teams', 'team_members') ORDER BY table_name, ordinal_position`,
    );
    expect(rows.map(({ table, column }) => `${table}.${column}`)).toEqual([
      "team_members.org_id",
      "team_members.team_id",
      "team_members.user_id",
      "team_members.added_at",
      "teams.org_id",
      "teams.id",
      "teams.key",
      "teams.name",
      "teams.created_at",
      // The intake settings an admin sets (agent-surfaces: Admins set a team's intake notes and required fields).
      "teams.intake_notes",
      "teams.required_fields",
    ]);
    const sources = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "apps", "packages"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\0")
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes("/test/") && !file.startsWith("packages/db/"));
    const writers = sources.filter((file) => {
      const text = readFileSync(`${repoRoot}${file}`, "utf8");
      return /\.(insert|update|delete)\(\s*(teams|teamMembers)\b/.test(text) || /\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(teams|team_members)\b/i.test(text);
    });
    expect(writers).toEqual(["packages/commands/src/teams.ts"]);
  });
});

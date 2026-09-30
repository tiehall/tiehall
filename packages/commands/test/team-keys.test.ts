import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTeamKey } from "@tiehall/core";
import type { WebResult, WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";

// Team keys (teams-and-roles: Team keys; design.md, Design rules: Teams and
// roles; design.md, Self-hosting decisions: S15). Each team's key has 2 to 10
// characters, the uppercase letters A to Z and the digits 0 to 9, and starts
// with a letter; a key in any other form gets 400. Every key is unique in the
// install: a key another team uses gets 409 and changes nothing. A renamed
// key stays an alias of its team and counts as in use by it, so no other team
// can take it. Every app path is lowercase, so a key such as MCP never shadows
// one.

const webApp = fileURLToPath(new URL("../../../apps/web/app/", import.meta.url));

let install: TestInstall;
let ada: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin" }), sessionId: randomUUID() };
});

afterAll(async () => {
  await install.close();
});

interface Team {
  id: string;
  key: string;
  name: string;
}

function submit(commandId: string, input: unknown): Promise<WebResult<Team>> {
  return install.web(ada).write<Team>(commandId, input, install.fromThePage(ada));
}

async function create(key: string): Promise<Team> {
  const result = await submit("teams.create", { key, name: `Team ${key}` });
  if (!result.ok) throw new Error(`teams.create ${key} failed: ${JSON.stringify(result.problem)}`);
  return result.output;
}

async function keys(): Promise<{ teams: string[]; aliases: string[] }> {
  const teams = await install.owner.query<{ key: string }>("SELECT key FROM teams ORDER BY key");
  const aliases = await install.owner.query<{ key: string; team: string }>(
    "SELECT a.key, t.key AS team FROM team_key_aliases a JOIN teams t ON t.org_id = a.org_id AND t.id = a.team_id ORDER BY a.key",
  );
  return { teams: teams.rows.map(({ key }) => key), aliases: aliases.rows.map(({ key, team }) => `${key}->${team}`) };
}

describe("a key in the allowed form", () => {
  it("is accepted, such as FE, PAY2 and PLATFORM10", async () => {
    for (const key of ["FE", "PAY2", "PLATFORM10"]) expect((await create(key)).key).toBe(key);
  });
});

describe("a key in another form", () => {
  it.each(["fe", "F", "2FE", "2FA", "PLATFORM100", "FE-X"])("such as %j gets 400 and creates or changes no team", async (key) => {
    const before = await keys();
    expect(await submit("teams.create", { key, name: "Wrong key" })).toMatchObject({
      ok: false,
      problem: { status: 400, type: "https://tiehall.com/problems/invalid-input", errors: [{ path: ["key"] }] },
    });
    const [team] = (await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'PAY2'")).rows;
    expect(await submit("teams.change_key", { teamId: team?.id, key })).toMatchObject({ ok: false, problem: { status: 400 } });
    expect(await keys()).toEqual(before);
  });

  it("is refused by the database too, whatever writes it", async () => {
    await expect(install.owner.query("INSERT INTO teams (org_id, key, name) SELECT id, 'fe', 'Lower' FROM orgs")).rejects.toThrow(
      /teams_key_format/,
    );
  });
});

describe("a key another team uses", () => {
  it("gets 409 for a new team, and no team is created", async () => {
    const before = await keys();
    expect(await submit("teams.create", { key: "FE", name: "Another frontend" })).toMatchObject({
      ok: false,
      problem: { status: 409, type: "https://tiehall.com/problems/conflict" },
    });
    expect(await keys()).toEqual(before);
  });

  it("gets 409 when another team is given it, and that team keeps its previous key", async () => {
    const ops = await create("OPS");
    const before = await keys();
    expect(await submit("teams.change_key", { teamId: ops.id, key: "FE" })).toMatchObject({ ok: false, problem: { status: 409 } });
    expect(await keys()).toEqual(before);
    expect(before.teams).toContain("OPS");
  });

  it("changes nothing when a team is given the key it already has", async () => {
    const [team] = (await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'OPS'")).rows;
    const before = await keys();
    expect(await submit("teams.change_key", { teamId: team?.id, key: "OPS" })).toMatchObject({ ok: true, output: { key: "OPS" } });
    expect(await keys()).toEqual(before);
  });
});

describe("a renamed key", () => {
  it("stays an alias of its team, which no other team can take", async () => {
    const [fe] = (await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'FE'")).rows;
    expect(await submit("teams.change_key", { teamId: fe?.id, key: "WEB" })).toMatchObject({ ok: true, output: { id: fe?.id, key: "WEB" } });
    expect(await keys()).toMatchObject({ aliases: ["FE->WEB"] });

    const before = await keys();
    expect(await submit("teams.create", { key: "FE", name: "A new frontend" })).toMatchObject({ ok: false, problem: { status: 409 } });
    const [ops] = (await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'OPS'")).rows;
    expect(await submit("teams.change_key", { teamId: ops?.id, key: "FE" })).toMatchObject({ ok: false, problem: { status: 409 } });
    expect(await keys()).toEqual(before);
  });

  it("keeps every key a team has had: a second rename adds a second alias", async () => {
    const [web] = (await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'WEB'")).rows;
    await submit("teams.change_key", { teamId: web?.id, key: "UI" });
    expect((await keys()).aliases).toEqual(["FE->UI", "WEB->UI"]);
    expect(await submit("teams.create", { key: "WEB", name: "Web again" })).toMatchObject({ ok: false, problem: { status: 409 } });
  });

  it("can be taken back by its own team, whose current key then becomes an alias", async () => {
    const [ui] = (await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'UI'")).rows;
    expect(await submit("teams.change_key", { teamId: ui?.id, key: "FE" })).toMatchObject({ ok: true, output: { key: "FE" } });
    expect((await keys()).aliases).toEqual(["UI->FE", "WEB->FE"]);
  });
});

describe("a key that spells an app path", () => {
  it("such as MCP is accepted, while every app path stays lowercase and so is never a key", async () => {
    expect((await create("MCP")).key).toBe("MCP");
    expect((await create("API")).key).toBe("API");
    // The app's own paths (design.md, Self-hosting decisions: S15), and every route the web app serves at its top level.
    const appPaths = ["api", "mcp", "docs", "confirm", "consent", "device", "setup", "webhooks", "schemas", ".well-known", "healthz", "admin", "members", "sign-in", "sign-out"];
    const routes = readdirSync(webApp, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name);
    expect(routes.length).toBeGreaterThan(0);
    for (const segment of [...appPaths, ...routes]) {
      expect(segment, segment).toBe(segment.toLowerCase());
      expect(isTeamKey(segment), segment).toBe(false);
    }
    expect(appPaths).toEqual(expect.arrayContaining(routes));
  });
});

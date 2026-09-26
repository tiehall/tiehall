import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, defineCatalog, defineCommand } from "@tiehall/catalog";
import { createExecute, HANDLERS, type Caller, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";

// Removing a member (teams-and-roles: Removing a member; sign-in: An admin
// removal blocks rejoining through the organization; activity-log: Which
// actions are security events; agent-safety: Actions that need the
// confirmation step). An admin removes a member in the web UI, with the
// confirmation step for that removal; without a valid confirmation it gets 403
// and changes nothing. The removed person is no longer a member of the install
// or of any of its teams, and their next call, through any session or token,
// gets 403 and no data. An admin removal records a block on their GitHub
// account. What they took part in stays, with the provenance that names them.
// An admin may remove themselves while another admin remains; the install
// always keeps one. Each removal is a security event that names the admin who
// removed the person and the block it records.

let install: TestInstall;
let ada: WebSessionCaller;
let omar: WebSessionCaller;
let fe: string;
let be: string;

beforeAll(async () => {
  install = await startTestInstall();
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  omar = { kind: "web_session", userId: await addUser(install.owner, { role: "member", login: "omar" }), sessionId: randomUUID() };
  const teams = await install.owner.query<{ id: string; key: string }>(
    "INSERT INTO teams (org_id, key, name) SELECT id, k, k FROM orgs, unnest(ARRAY['FE', 'BE']) AS k RETURNING id, key",
  );
  fe = teams.rows.find(({ key }) => key === "FE")?.id ?? "";
  be = teams.rows.find(({ key }) => key === "BE")?.id ?? "";
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  // Ada is the only admin at the start of each test.
  await install.owner.query("UPDATE members SET role = CASE WHEN user_id = $1 THEN 'admin' ELSE 'member' END", [ada.userId]);
});

/** A new member in teams FE and BE, with a web session. */
async function newMember(login: string): Promise<WebSessionCaller> {
  const userId = await addUser(install.owner, { role: "member", login });
  await install.owner.query("INSERT INTO team_members (org_id, team_id, user_id) SELECT id, unnest($1::uuid[]), $2 FROM orgs", [[fe, be], userId]);
  return { kind: "web_session", userId, sessionId: randomUUID() };
}

async function isMember(userId: string): Promise<boolean> {
  return (await install.owner.query("SELECT 1 FROM members WHERE user_id = $1", [userId])).rows.length === 1;
}

async function teamsOf(userId: string): Promise<string[]> {
  const { rows } = await install.owner.query<{ key: string }>(
    "SELECT t.key FROM team_members m JOIN teams t ON t.org_id = m.org_id AND t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.key",
    [userId],
  );
  return rows.map(({ key }) => key);
}

async function removals(userId: string): Promise<unknown[]> {
  const { rows } = await install.owner.query(
    "SELECT class, actor_kind, actor_user_id, surface, data FROM events WHERE type = 'member.removed' AND data->>'userId' = $1 ORDER BY number",
    [userId],
  );
  return rows;
}

async function blockOf(userId: string): Promise<unknown[]> {
  const { rows } = await install.owner.query(
    "SELECT b.github_account_id = u.github_account_id AS on_their_account FROM sign_in_blocks b JOIN users u ON u.org_id = b.org_id AND u.github_account_id = b.github_account_id WHERE u.id = $1",
    [userId],
  );
  return rows;
}

async function problemOf(answer: Response): Promise<{ status: number; type: unknown }> {
  const body = (await answer.text()).trim();
  return { status: answer.status, type: body.startsWith("{") ? (JSON.parse(body) as { type?: unknown }).type : undefined };
}

describe("a confirmed removal", () => {
  it("ends the membership of the install and of every team, and records a security event naming the admin and the block", async () => {
    const dana = await newMember("dana");
    expect(await teamsOf(dana.userId)).toEqual(["BE", "FE"]);
    const answer = await install.confirm(ada, "members.remove", { userId: dana.userId });
    expect(answer.status).toBe(200);
    expect(await isMember(dana.userId)).toBe(false);
    expect(await teamsOf(dana.userId)).toEqual([]);
    expect(await removals(dana.userId)).toEqual([
      {
        class: "security",
        actor_kind: "web_session",
        actor_user_id: ada.userId,
        surface: "web",
        data: { userId: dana.userId, cause: "admin", blocked: true },
      },
    ]);
    expect(await blockOf(dana.userId)).toEqual([{ on_their_account: true }]);
  });

  it("shows on its review page, in Tiehall's words, who is removed and what the removal does", async () => {
    const lee = await newMember("lee-acme");
    const input = encodeURIComponent(JSON.stringify({ userId: lee.userId }));
    const page = await install.confirmRoute(ada)(new Request(`${URL_OF_INSTALL}/confirm/members.remove?input=${input}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Remove a member");
    expect(html).toContain("lee-acme");
    expect(html).toMatch(/BE, FE/);
    expect(html).toMatch(/invite/);
  });

  it("leaves the removed person's next call through a session or a token refused with 403 and no data", async () => {
    const dana = await newMember("dana-2");
    // An operation every member may run, which answers with data of the install.
    const probes = defineCatalog([
      ...CATALOG.commands,
      defineCommand({
        id: "probes.teams",
        summary: "List the keys of the install's teams.",
        input: z.object({}),
        output: z.object({ keys: z.array(z.string()) }),
        method: "GET",
        path: "/api/v1/probes/teams",
        scopes: ["requests:read"],
        commitment: false,
        confirm: false,
        surfaces: ["rest", "mcp"],
        tool: "probe_teams",
        stability: "alpha",
      }),
    ]);
    const execute = createExecute({
      catalog: probes,
      handlers: {
        ...HANDLERS,
        "probes.teams": async (_input, { tx }) => ({
          keys: (await tx.execute<{ key: string }>("SELECT key FROM teams ORDER BY key")).rows.map(({ key }) => key),
        }),
      },
      store: { database: install.db, jobs: { send: async () => {} } },
    });
    const callers: Caller[] = [
      dana,
      { kind: "web_session", userId: dana.userId, sessionId: randomUUID() },
      { kind: "oauth_token", userId: dana.userId, clientId: "https://client.example/metadata.json", scopes: ["requests:read"], surface: "mcp" },
      { kind: "personal_access_token", userId: dana.userId, tokenId: randomUUID(), scopes: ["requests:read"], surface: "api" },
    ];
    for (const caller of callers) expect(await execute("probes.teams", caller, {})).toEqual({ keys: ["BE", "FE"] });

    expect((await install.confirm(ada, "members.remove", { userId: dana.userId })).status).toBe(200);
    for (const caller of callers) {
      await expect(execute("probes.teams", caller, {}), caller.kind).rejects.toMatchObject({
        status: 403,
        type: "https://tiehall.com/problems/removed-member",
      });
    }
    // The web UI refuses the same session, before it looks at what the form asks for.
    expect(await install.web(dana).write("teams.create", { key: "DANA", name: "Dana's" }, install.fromThePage(dana))).toMatchObject({
      ok: false,
      problem: { status: 403, type: "https://tiehall.com/problems/removed-member" },
    });
  });

  it("keeps what the person took part in, with the provenance that names them", async () => {
    const dana = await newMember("dana-3");
    // An event the person caused before the removal, as a message they posted will be.
    await install.owner.query(
      `INSERT INTO event_sequence (org_id, last_number) SELECT id, 0 FROM orgs ON CONFLICT DO NOTHING;
       UPDATE event_sequence SET last_number = last_number + 1`,
    );
    await install.owner.query(
      `INSERT INTO events (org_id, number, class, type, data, actor_kind, actor_user_id, surface)
       SELECT org_id, last_number, 'domain', 'request.message_posted', jsonb_build_object('requestId', $2::text, 'messageId', $3::text), 'agent', $1, 'mcp'
         FROM event_sequence`,
      [dana.userId, randomUUID(), randomUUID()],
    );
    const before = await install.owner.query("SELECT number, actor_user_id, data FROM events WHERE actor_user_id = $1", [dana.userId]);
    expect(before.rows).toHaveLength(1);
    expect((await install.confirm(ada, "members.remove", { userId: dana.userId })).status).toBe(200);
    expect((await install.owner.query("SELECT number, actor_user_id, data FROM events WHERE actor_user_id = $1", [dana.userId])).rows).toEqual(
      before.rows,
    );
    expect((await install.owner.query("SELECT github_login FROM users WHERE id = $1", [dana.userId])).rows).toEqual([{ github_login: "dana-3" }]);
  });
});

describe("an admin removing themselves", () => {
  it("is removed while another admin remains, who stays an admin", async () => {
    await install.owner.query("UPDATE members SET role = 'admin' WHERE user_id = $1", [omar.userId]);
    const pia: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "pia" }), sessionId: randomUUID() };
    expect((await install.confirm(pia, "members.remove", { userId: pia.userId })).status).toBe(200);
    expect(await isMember(pia.userId)).toBe(false);
    expect((await install.owner.query("SELECT role FROM members WHERE user_id = $1", [omar.userId])).rows).toEqual([{ role: "admin" }]);
  });

  it("is refused with 409 when they are the only admin, who stays a member with the role admin, and no event is recorded", async () => {
    expect(await problemOf(await install.confirm(ada, "members.remove", { userId: ada.userId }))).toEqual({
      status: 409,
      type: "https://tiehall.com/problems/conflict",
    });
    expect((await install.owner.query("SELECT role FROM members WHERE user_id = $1", [ada.userId])).rows).toEqual([{ role: "admin" }]);
    expect(await removals(ada.userId)).toEqual([]);
    expect(await blockOf(ada.userId)).toEqual([]);
  });
});

describe("a removal that is not allowed", () => {
  it("without the confirmation step gets 403, and the person stays a member", async () => {
    const dana = await newMember("dana-4");
    const result = await install.web(ada).write("members.remove", { userId: dana.userId }, install.fromThePage(ada));
    expect(result).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/confirmation-required" } });
    expect(await isMember(dana.userId)).toBe(true);
    expect(await teamsOf(dana.userId)).toEqual(["BE", "FE"]);
    expect(await removals(dana.userId)).toEqual([]);
  });

  it("asked by a member gets 403, and nothing changes", async () => {
    const dana = await newMember("dana-5");
    expect(await problemOf(await install.confirm(omar, "members.remove", { userId: dana.userId }))).toEqual({
      status: 403,
      type: "https://tiehall.com/problems/forbidden",
    });
    expect(await isMember(dana.userId)).toBe(true);
  });

  it("of someone who is not a member of the install gets 404", async () => {
    const outsider = await addUser(install.owner, { role: null });
    expect((await problemOf(await install.confirm(ada, "members.remove", { userId: outsider }))).status).toBe(404);
    expect(await blockOf(outsider)).toEqual([]);
  });

  it("is offered on no agent surface: a token gets 404, even an admin's", async () => {
    const dana = await newMember("dana-6");
    const token: Caller = { kind: "oauth_token", userId: ada.userId, clientId: "https://client.example/metadata.json", scopes: ["requests:write"], surface: "mcp" };
    await expect(install.execute("members.remove", token, { userId: dana.userId })).rejects.toMatchObject({ status: 404 });
    expect(await isMember(dana.userId)).toBe(true);
  });
});

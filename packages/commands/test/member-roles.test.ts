import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, defineCatalog, defineCommand } from "@tiehall/catalog";
import { createExecute, HANDLERS, type Caller, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";

// Changing a member's role (teams-and-roles: Changing a member's role;
// teams-and-roles: Two roles, admin and member; activity-log: Which actions
// are security events; agent-safety: Actions that need the confirmation step).
// An admin changes a member's role between member and admin in the web UI,
// with the confirmation step for that exact change: a change without a valid
// confirmation for it gets 403 and changes nothing. The new role applies from
// the member's next call, through every session and token that acts for them.
// The install always keeps an admin, so a change that would leave none gets
// 409. Each change is a security event that names the admin, the member and
// the new role.

let install: TestInstall;
let ada: WebSessionCaller;
let dana: WebSessionCaller;
let kim: string;

beforeAll(async () => {
  install = await startTestInstall();
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  dana = { kind: "web_session", userId: await addUser(install.owner, { role: "member", login: "dana-k" }), sessionId: randomUUID() };
  kim = await addUser(install.owner, { role: "member", login: "kim" });
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  // Ada is the only admin at the start of each test.
  await install.owner.query("UPDATE members SET role = CASE WHEN user_id = $1 THEN 'admin' ELSE 'member' END", [ada.userId]);
});

async function roleOf(userId: string): Promise<string | undefined> {
  return (await install.owner.query<{ role: string }>("SELECT role FROM members WHERE user_id = $1", [userId])).rows[0]?.role;
}

async function roleChanges(): Promise<{ class: string; actor_kind: string; actor_user_id: string; surface: string; data: unknown }[]> {
  const { rows } = await install.owner.query(
    "SELECT class, actor_kind, actor_user_id, surface, data FROM events WHERE type = 'member.role_changed' ORDER BY number",
  );
  return rows;
}

async function problemOf(answer: Response): Promise<{ status: number; type: unknown }> {
  const body = (await answer.text()).trim();
  return { status: answer.status, type: body.startsWith("{") ? (JSON.parse(body) as { type?: unknown }).type : undefined };
}

describe("a confirmed role change", () => {
  it("makes the member an admin, and the activity log gains a security event naming the admin, the member and the new role", async () => {
    const before = (await roleChanges()).length;
    const answer = await install.confirm(ada, "members.change_role", { userId: dana.userId, role: "admin" });
    expect(answer.status).toBe(200);
    expect(await roleOf(dana.userId)).toBe("admin");
    expect((await roleChanges()).slice(before)).toEqual([
      {
        class: "security",
        actor_kind: "web_session",
        actor_user_id: ada.userId,
        surface: "web",
        data: { userId: dana.userId, role: "admin", previousRole: "member" },
      },
    ]);
  });

  it("shows on its review page, in Tiehall's words, whose role changes and from what to what", async () => {
    const input = encodeURIComponent(JSON.stringify({ userId: dana.userId, role: "admin" }));
    const page = await install.confirmRoute(ada)(new Request(`${URL_OF_INSTALL}/confirm/members.change_role?input=${input}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Change a member&#39;s role");
    expect(html).toContain("dana-k");
    expect(html).toMatch(/from member to admin/);
  });
});

describe("a role change without a valid confirmation", () => {
  it("gets 403 when the web UI's form sends only the session and the CSRF token, and the role is unchanged", async () => {
    const result = await install.web(ada).write("members.change_role", { userId: dana.userId, role: "admin" }, install.fromThePage(ada));
    expect(result).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/confirmation-required" } });
    expect(await roleOf(dana.userId)).toBe("member");
  });

  it("gets 403 when the confirmation was given for another change, and neither role changes", async () => {
    const route = install.confirmRoute(ada);
    const reviewed = encodeURIComponent(JSON.stringify({ userId: dana.userId, role: "admin" }));
    const html = await (await route(new Request(`${URL_OF_INSTALL}/confirm/members.change_role?input=${reviewed}`))).text();
    const field = (name: string) => (new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "").replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c)));
    const before = (await roleChanges()).length;
    const answer = await route(
      new Request(`${URL_OF_INSTALL}/confirm/members.change_role`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ input: JSON.stringify({ userId: kim, role: "admin" }), nonce: field("nonce"), csrf: field("csrf") }).toString(),
      }),
    );
    expect(await problemOf(answer)).toEqual({ status: 403, type: "https://tiehall.com/problems/confirmation-required" });
    expect(await roleOf(kim)).toBe("member");
    expect(await roleOf(dana.userId)).toBe("member");
    expect((await roleChanges()).length).toBe(before);
  });
});

describe("a lowered role", () => {
  it("applies at once: in a session opened before the change, the former admin's form that creates a team gets 403", async () => {
    const omar: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "omar" }), sessionId: randomUUID() };
    expect((await install.confirm(ada, "members.change_role", { userId: omar.userId, role: "member" })).status).toBe(200);
    const result = await install.web(omar).write("teams.create", { key: "OMAR", name: "Omar's team" }, install.fromThePage(omar));
    expect(result).toMatchObject({ ok: false, problem: { status: 403 } });
    expect((await install.owner.query("SELECT key FROM teams WHERE key = 'OMAR'")).rows).toEqual([]);
  });

  it("applies from the member's next call through every session and token that acts for them", async () => {
    // An operation every member may run, which answers with the role the call was made with.
    const probes = defineCatalog([
      ...CATALOG.commands,
      defineCommand({
        id: "probes.my_role",
        summary: "Answer with the role of the user the call acts for.",
        input: z.object({}),
        output: z.object({ role: z.string() }),
        method: "GET",
        path: "/api/v1/probes/role",
        scopes: ["requests:read"],
        commitment: false,
        confirm: false,
        surfaces: ["rest", "mcp"],
        tool: "my_role",
        stability: "alpha",
      }),
    ]);
    const execute = createExecute({
      catalog: probes,
      handlers: { ...HANDLERS, "probes.my_role": async (_input, { member }) => ({ role: member?.role ?? "none" }) },
      store: { database: install.db, jobs: { send: async () => {} } },
    });
    const lee = await addUser(install.owner, { role: "member", login: "lee" });
    const callers: Caller[] = [
      { kind: "web_session", userId: lee, sessionId: randomUUID() },
      { kind: "oauth_token", userId: lee, clientId: "https://client.example/metadata.json", scopes: ["requests:read"], surface: "mcp" },
      { kind: "personal_access_token", userId: lee, tokenId: randomUUID(), scopes: ["requests:read"], surface: "api" },
    ];
    for (const caller of callers) expect(await execute("probes.my_role", caller, {})).toEqual({ role: "member" });
    expect((await install.confirm(ada, "members.change_role", { userId: lee, role: "admin" })).status).toBe(200);
    for (const caller of callers) expect(await execute("probes.my_role", caller, {})).toEqual({ role: "admin" });
    expect((await install.confirm(ada, "members.change_role", { userId: lee, role: "member" })).status).toBe(200);
    for (const caller of callers) expect(await execute("probes.my_role", caller, {})).toEqual({ role: "member" });
  });
});

describe("keeping an admin", () => {
  it("refuses the only admin's step down with 409, and their role stays admin", async () => {
    const before = (await roleChanges()).length;
    expect(await problemOf(await install.confirm(ada, "members.change_role", { userId: ada.userId, role: "member" }))).toEqual({
      status: 409,
      type: "https://tiehall.com/problems/conflict",
    });
    expect(await roleOf(ada.userId)).toBe("admin");
    expect((await roleChanges()).length).toBe(before);
  });

  it("lets an admin step down while a second admin remains", async () => {
    await install.owner.query("UPDATE members SET role = 'admin' WHERE user_id = $1", [dana.userId]);
    expect((await install.confirm(ada, "members.change_role", { userId: ada.userId, role: "member" })).status).toBe(200);
    expect(await roleOf(ada.userId)).toBe("member");
    expect(await roleOf(dana.userId)).toBe("admin");
  });
});

describe("a role change that is not allowed", () => {
  it("naming a role other than admin or member, such as owner, gets 400 and changes nothing", async () => {
    expect(await problemOf(await install.confirm(ada, "members.change_role", { userId: dana.userId, role: "owner" }))).toEqual({
      status: 400,
      type: "https://tiehall.com/problems/invalid-input",
    });
    expect(await roleOf(dana.userId)).toBe("member");
  });

  it("asked by a member gets 403, and nothing changes", async () => {
    expect(await problemOf(await install.confirm(dana, "members.change_role", { userId: dana.userId, role: "admin" }))).toEqual({
      status: 403,
      type: "https://tiehall.com/problems/forbidden",
    });
    expect(await roleOf(dana.userId)).toBe("member");
  });

  it("for someone who is not a member of the install gets 404", async () => {
    const outsider = await addUser(install.owner, { role: null });
    expect((await problemOf(await install.confirm(ada, "members.change_role", { userId: outsider, role: "admin" }))).status).toBe(404);
    expect(await roleOf(outsider)).toBeUndefined();
  });

  it("is offered on no agent surface: a token gets 404, even an admin's", async () => {
    const token: Caller = { kind: "personal_access_token", userId: ada.userId, tokenId: randomUUID(), scopes: ["requests:write"], surface: "api" };
    await expect(install.execute("members.change_role", token, { userId: dana.userId, role: "admin" })).rejects.toMatchObject({ status: 404 });
    expect(await roleOf(dana.userId)).toBe("member");
  });
});

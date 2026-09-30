import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInCompleted } from "@tiehall/core";
import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import {
  ACTIVITY_LOG_PATH,
  createActivityLogRoute,
  createAgentTokenCheck,
  createRestHandler,
  createMcpRoute,
  createMembersRoute,
  createTeamsRoute,
  MEMBERS_PATH,
  TEAMS_PATH,
  write,
  type Caller,
  type WebSessionCaller,
} from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { mcpClient, PROTOCOL_VERSIONS, textOf } from "./support/mcp.ts";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Bot users (teams-and-roles: Bot users; teams-and-roles: What admins and
// members may do; design.md, Decisions this change rests on: D28 #94). An
// admin sets and clears a bot flag on a user of the install, in the web UI. A
// flagged user stays an identity of kind human that carries the flag, and
// holds a role and teams like anyone else; v1 counts no seats, so the flag's
// only effect is that it is shown wherever a user is listed or named. A
// member's attempt to set or clear it gets 403 and changes nothing. Every
// member sees the members list in the web UI, ordered by GitHub login, and no
// agent surface offers it (design.md, Decisions: D45 (3)). A flagged user
// holds personal access tokens like anyone (agent-access: Machine access is a
// PAT held by a bot user).

let install: TestInstall;
let ada: WebSessionCaller;
let dana: WebSessionCaller;
let bot: string;

beforeAll(async () => {
  install = await startTestInstall();
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  dana = { kind: "web_session", userId: await addUser(install.owner, { role: "member", login: "dana" }), sessionId: randomUUID() };
  bot = await addUser(install.owner, { role: "member", login: "acme-ci-bot" });
  await install.owner.query("INSERT INTO teams (org_id, key, name) SELECT id, 'OPS', 'Operations' FROM orgs");
  await install.owner.query(
    "INSERT INTO team_members (org_id, team_id, user_id) SELECT org_id, id, $1 FROM teams WHERE key = 'OPS'",
    [bot],
  );
});

afterAll(async () => {
  await install.close();
});

function setFlag(caller: WebSessionCaller, userId: string, flag: boolean) {
  return install.web(caller).write("users.set_bot_flag", { userId, bot: flag }, install.fromThePage(caller));
}

interface ListedMember {
  id: string;
  login: string;
  kind: string;
  bot: boolean;
  role: string;
  teams: string[];
}

/** The members list of the web UI, as the given session reads it. */
async function listed(caller: WebSessionCaller, userId: string): Promise<ListedMember | undefined> {
  const result = await install.web(caller).read<{ members: ListedMember[] }>("members.list", {});
  if (!result.ok) throw new Error(`members.list failed: ${JSON.stringify(result.problem)}`);
  return result.output.members.find(({ id }) => id === userId);
}

describe("an admin", () => {
  it("sets the bot flag: the user carries it, stays of kind human, and keeps their role and teams", async () => {
    expect(await listed(ada, bot)).toEqual({ id: bot, login: "acme-ci-bot", kind: "human", bot: false, role: "member", teams: ["OPS"] });
    expect(await setFlag(ada, bot, true)).toEqual({ ok: true, output: { userId: bot, bot: true } });
    expect(await listed(ada, bot)).toEqual({ id: bot, login: "acme-ci-bot", kind: "human", bot: true, role: "member", teams: ["OPS"] });
  });

  it("finds the user marked as a bot in the members list, as every member does", async () => {
    expect(await listed(dana, bot)).toMatchObject({ login: "acme-ci-bot", bot: true });
    expect(await listed(dana, ada.userId)).toMatchObject({ login: "ada", bot: false });
  });

  it("finds the user marked as a bot where a review page names them", async () => {
    for (const [commandId, input] of [
      ["members.change_role", { userId: bot, role: "admin" }],
      ["members.remove", { userId: bot }],
    ] as const) {
      const page = await install.confirmRoute(ada)(
        new Request(`${URL_OF_INSTALL}/confirm/${commandId}?input=${encodeURIComponent(JSON.stringify(input))}`),
      );
      expect(page.status, commandId).toBe(200);
      expect(await page.text(), commandId).toContain("acme-ci-bot (a bot user)");
    }
  });

  it.each([
    ["the members page", MEMBERS_PATH, createMembersRoute],
    ["the teams page", TEAMS_PATH, createTeamsRoute],
  ] as const)("finds the user marked as a bot wherever %s names them, its controls included", async (_page, path, create) => {
    const route = create({ execute: install.execute, session: async () => ada, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
    const answer = await route(new Request(`${URL_OF_INSTALL}${path}`));
    expect(answer.status).toBe(200);
    // The page's visible text, one line per element's text.
    const lines = (await answer.text())
      .replace(/<[^>]+>/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("acme-ci-bot"));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.filter((line) => !line.includes("acme-ci-bot (a bot user)"))).toEqual([]);
  });

  it("clears the flag: the user no longer carries it, and their role and teams are unchanged", async () => {
    expect(await setFlag(ada, bot, false)).toEqual({ ok: true, output: { userId: bot, bot: false } });
    expect(await listed(ada, bot)).toEqual({ id: bot, login: "acme-ci-bot", kind: "human", bot: false, role: "member", teams: ["OPS"] });
  });

  it("gets 404 for a user who is not a member of the install", async () => {
    const outsider = await addUser(install.owner, { role: null });
    expect(await setFlag(ada, outsider, true)).toMatchObject({ ok: false, problem: { status: 404 } });
  });

  it("finds the user marked as a bot where the activity log names them as the user an integration acted for", async () => {
    await setFlag(ada, bot, true);
    try {
      await write(
        { database: install.db, jobs: { send: async () => {} } },
        { actorKind: "integration", userId: bot, surface: "github" },
        (writer) => writer.record(signInCompleted, { userId: bot }),
      );
      const route = createActivityLogRoute({ execute: install.execute, session: async () => ada, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
      const page = await route(new Request(`${URL_OF_INSTALL}${ACTIVITY_LOG_PATH}?type=sign_in.completed`));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("integration github acme-ci-bot (a bot user)");
    } finally {
      await setFlag(ada, bot, false);
    }
  });

  it("sees whoami, called with the user's personal access token, say that its user is a bot", async () => {
    const botSession: WebSessionCaller = { kind: "web_session", userId: bot, sessionId: randomUUID() };
    // The MCP endpoint, which checks personal access tokens as the web role's does.
    const mcp = createMcpRoute({
      catalog: CATALOG,
      execute: install.execute,
      authenticate: createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: async () => undefined, database: install.db }),
      database: install.db,
      logger: install.logger,
    });
    await setFlag(ada, bot, true);
    try {
      const created = await install.confirm(botSession, "personal_access_tokens.create", { name: "whoami", scopes: ["requests:read"], expiresInDays: 30 });
      expect(created.status).toBe(200);
      const token = /<pre><code>(th_pat_[A-Za-z0-9_-]+)<\/code><\/pre>/.exec(await created.text())?.[1] ?? "";
      for (const version of PROTOCOL_VERSIONS) {
        const client = mcpClient({ version });
        const fetchThroughRoute = (input: string | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          request.headers.set("authorization", `Bearer ${token}`);
          return mcp(request);
        };
        await client.connect(new StreamableHTTPClientTransport(new URL(`${URL_OF_INSTALL}/mcp`), { fetch: fetchThroughRoute }));
        try {
          const result = await client.callTool({ name: "whoami", arguments: {} });
          expect(result.structuredContent, version).toEqual({
            user: { id: bot, login: "acme-ci-bot", kind: "human", bot: true },
            teams: expect.any(Array),
            install: { url: URL_OF_INSTALL },
          });
          expect(textOf(result), version).toContain("acme-ci-bot (a bot user)");
        } finally {
          await client.close();
        }
      }
    } finally {
      await setFlag(ada, bot, false);
    }
  });
  it("sees a flagged user hold personal access tokens, which keep acting for them when the flag changes", async () => {
    const botSession: WebSessionCaller = { kind: "web_session", userId: bot, sessionId: randomUUID() };
    // A REST route that checks personal access tokens as the web role's does.
    const rest = createRestHandler({
      catalog: CATALOG,
      document: OPENAPI_JSON,
      execute: install.execute,
      authenticate: createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: async () => undefined, database: install.db }),
      logger: install.logger,
    });
    const call = (token: string) => rest(new Request(`${URL_OF_INSTALL}/api/v1/requests`, { headers: { authorization: `Bearer ${token}` } }));
    await setFlag(ada, bot, true);
    try {
      const created = await install.confirm(botSession, "personal_access_tokens.create", { name: "CI", scopes: ["requests:read"], expiresInDays: 30 });
      expect(created.status).toBe(200);
      const token = /<pre><code>(th_pat_[A-Za-z0-9_-]+)<\/code><\/pre>/.exec(await created.text())?.[1] ?? "";
      expect((await call(token)).status).toBe(200);
      await setFlag(ada, bot, false);
      expect((await call(token)).status).toBe(200);
      await setFlag(ada, bot, true);
      expect((await call(token)).status).toBe(200);
      const { rows } = await install.owner.query("SELECT user_id, revoked_at FROM personal_access_tokens WHERE name = 'CI'");
      expect(rows).toEqual([{ user_id: bot, revoked_at: null }]);
    } finally {
      await setFlag(ada, bot, false);
    }
  });
});

describe("a member", () => {
  it("who submits the form that sets the bot flag on their own user gets 403, and carries no flag", async () => {
    expect(await setFlag(dana, dana.userId, true)).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/forbidden" } });
    expect(await listed(dana, dana.userId)).toMatchObject({ bot: false });
  });

  it("gets 403 clearing another user's flag too, and nothing changes", async () => {
    await setFlag(ada, bot, true);
    expect(await setFlag(dana, bot, false)).toMatchObject({ ok: false, problem: { status: 403 } });
    expect(await listed(dana, bot)).toMatchObject({ bot: true });
  });
});

describe("the bot flag", () => {
  it("is set on no agent surface: a token gets 404, even an admin's", async () => {
    const token: Caller = { kind: "personal_access_token", userId: ada.userId, tokenId: randomUUID(), scopes: ["requests:write"], surface: "api" };
    await expect(install.execute("users.set_bot_flag", token, { userId: dana.userId, bot: true })).rejects.toMatchObject({ status: 404 });
  });
});

describe("the members list", () => {
  it("shows a member every member of the install, ordered by GitHub login", async () => {
    const result = await install.web(dana).read<{ members: ListedMember[] }>("members.list", {});
    expect(result.ok ? result.output.members.map(({ login }) => login) : result).toEqual(["acme-ci-bot", "ada", "dana"]);
  });

  it("is offered on no agent surface: a token gets 404, even an admin's", async () => {
    const token: Caller = { kind: "personal_access_token", userId: ada.userId, tokenId: randomUUID(), scopes: ["requests:read"], surface: "api" };
    await expect(install.execute("members.list", token, {})).rejects.toMatchObject({ status: 404 });
  });
});

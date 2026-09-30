import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remindPersonalAccessTokenOwners, type WebSessionCaller } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, packetOf, sessionOf } from "./support/requests.ts";
import { startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// Machine access is a PAT held by a bot user (agent-access: Machine access is
// a PAT held by a bot user; teams-and-roles: Bot users; design.md, Decisions
// this change rests on: D28 #94; design.md, Design rules: Agent access;
// design.md, Technical decisions: T7). A company's bot or internal service
// gets access through a personal access token held by a dedicated bot user: a
// user who signs in with their own GitHub account like any person, whom an
// admin marks as a bot, and who creates the PAT in the web UI like anyone.
// Calls with it act for the bot user, whose provenance names it as the
// accountable human, and the bot user gets the expiry reminders every PAT owner
// gets. Tiehall offers no service accounts: the token endpoint refuses the
// client credentials grant with unsupported_grant_type.

let harness: AgentAccessHarness;
let bot: SignedIn;
let ada: WebSessionCaller;
let pat: string;

beforeAll(async () => {
  harness = await startAgentAccess();
  const { owner } = harness.install;
  ada = sessionOf(await addUser(owner, { role: "admin", login: "ada" }));
  // The company's GitHub machine account signs in with GitHub like any person.
  bot = await harness.member("acme-ci-bot");
  const ops = await addTeam(owner, "OPS");
  await addTeam(owner, "FE");
  await joinTeams(owner, bot.userId, ops);
  const flagged = await harness.install.web(ada).write("users.set_bot_flag", { userId: bot.userId, bot: true }, harness.install.fromThePage(ada));
  if (!flagged.ok) throw new Error(`users.set_bot_flag answered ${flagged.problem.status}`);
  pat = await harness.personalAccessToken(bot, { name: "CI", scopes: ["requests:read", "requests:write"], expiresInDays: 30 });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("a bot user's personal access token", () => {
  it("acts for the bot user, whom the provenance of what it does names as the accountable human", async () => {
    const { rows: flag } = await harness.install.owner.query("SELECT bot FROM users WHERE id = $1", [bot.userId]);
    expect(flag).toEqual([{ bot: true }]);
    const answer = await harness.api("POST", "/api/v1/requests", bearer(pat), { title: "Rotate the deploy key", targetTeam: "FE", requestingTeam: "OPS", packet: packetOf() });
    expect(answer.status).toBe(200);
    const { key } = (await answer.json()) as { key: string };
    const { rows } = await harness.install.owner.query(
      `SELECT e.actor_kind, e.actor_user_id, e.surface, e.client, r.requesting_user_id
         FROM events e JOIN requests r ON r.org_id = e.org_id AND r.id = (e.data->>'requestId')::uuid
        WHERE e.type = 'request.opened' ORDER BY e.number DESC LIMIT 1`,
    );
    expect(key).toMatch(/^FE-\d+$/);
    expect(rows).toEqual([{ actor_kind: "agent", actor_user_id: bot.userId, surface: "api", client: null, requesting_user_id: bot.userId }]);
  });

  it("gets its owner the expiry reminders: the bot user's web inbox lists them 14 and 3 days before", async () => {
    const { rows } = await harness.install.owner.query("SELECT expires_at FROM personal_access_tokens WHERE user_id = $1 AND name = 'CI'", [bot.userId]);
    const expiresAt = rows[0].expires_at as Date;
    for (const daysBefore of [14, 3]) {
      const at = new Date(expiresAt.getTime() - daysBefore * 24 * 60 * 60 * 1000);
      await remindPersonalAccessTokenOwners.handle(
        { id: "reminders", queue: remindPersonalAccessTokenOwners.type.queue, data: {}, signal: new AbortController().signal },
        { database: harness.install.db, now: () => at, installUrl: URL_OF_INSTALL },
      );
    }
    const inbox = await harness.install.web(sessionOf(bot.userId)).read<{ reminders: { daysBefore: number }[] }>("inbox.standing_list", {});
    if (!inbox.ok) throw new Error(`inbox.standing_list answered ${inbox.problem.status}`);
    expect(inbox.output.reminders.map(({ daysBefore }) => daysBefore)).toEqual([14, 3]);
  });
});

describe("service accounts", () => {
  it("are not offered: the token endpoint refuses the client credentials grant with unsupported_grant_type, for any client", async () => {
    const registered = await harness.registerClient();
    for (const clientId of [registered.clientId, "tiehall-cli"]) {
      const answer = await harness.handle(
        new Request(`${URL_OF_INSTALL}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, scope: "requests:read" }).toString(),
        }),
      );
      expect(answer.status, clientId).toBe(400);
      expect(((await answer.json()) as { error?: string }).error, clientId).toBe("unsupported_grant_type");
    }
  });
});

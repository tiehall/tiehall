import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, defineCommand, type Catalog } from "@tiehall/catalog";
import { createExecute, createLogger, createRestHandler, type Caller, type PersonalAccessTokenCaller } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { addTeam, callApi, joinTeams, openRequestInTheWebUi, tokenOf } from "./support/requests.ts";

// Tokens act for one user within that user's role (agent-access: Six kinds of
// caller; agent-access: Tokens act for one user within that user's role;
// design.md, Decisions this change rests on: D23, D28 #3, #4, #48; design.md,
// Design rules: Agent access). An OAuth token acts for the user who approved
// its client, and a personal access token for the user who created it. What
// either may do is bounded three ways: by its scopes, by the user's role, and
// by the user's part in the request, so a token with every scope still cannot
// act where its user may not. A commitment started through a token becomes a
// proposal. No token runs an admin operation, even an admin's: admin
// operations are offered on no agent surface, so their paths are not there,
// and were one ever offered, the role would still refuse a member's token.

let harness: AgentAccessHarness;
let bob: SignedIn;
let erin: SignedIn;
let alice: SignedIn;
let pay7: string;
let fe1: string;

const EVERY_SCOPE = ["requests:read", "requests:write", "contracts:report"] as const;

beforeAll(async () => {
  harness = await startAgentAccess();
  const { owner } = harness.install;
  const team: Record<string, string> = {};
  for (const key of ["PAY", "FE", "BE"]) team[key] = await addTeam(owner, key);
  alice = await harness.member("alice");
  bob = await harness.member("bob");
  erin = await harness.member("erin");
  await joinTeams(owner, alice.userId, team["BE"] ?? "");
  await joinTeams(owner, bob.userId, team["FE"] ?? "");
  await joinTeams(owner, erin.userId, team["FE"] ?? "");
  pay7 = (await openRequestInTheWebUi<{ key: string }>(harness.install, alice.userId, { targetTeam: "PAY" })).key;
  fe1 = (await openRequestInTheWebUi<{ key: string }>(harness.install, alice.userId, { targetTeam: "FE" })).key;
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** A request's state and claimant as stored. */
async function stored(key: string): Promise<{ state: string; claimant: string | null }> {
  const { rows } = await harness.install.owner.query<{ state: string; claimant: string | null }>(
    `SELECT r.state, r.claimant_user_id AS claimant FROM requests r JOIN teams t ON t.org_id = r.org_id AND t.id = r.target_team_id
      WHERE t.key || '-' || r.number = $1`,
    [key],
  );
  return rows[0] ?? { state: "missing", claimant: null };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("an OAuth token", () => {
  it("cannot act outside its user's part: Bob, not of team PAY, cannot claim PAY-7 with requests:write", async () => {
    const { accessToken } = await harness.tokens(bob, ["requests:read", "requests:write"]);
    const answer = await harness.api("POST", `/api/v1/requests/${pay7}/claim`, bearer(accessToken));
    expect(answer.status).toBe(403);
    expect(((await answer.json()) as { type: string }).type).toBe("https://tiehall.com/problems/forbidden");
    expect(await stored(pay7)).toEqual({ state: "open", claimant: null });
  });

  it("acts for the user who approved its client, recorded as an agent's action through that client on /api/v1", async () => {
    const { client, accessToken } = await harness.tokens(erin, ["requests:read", "requests:write"]);
    const answer = await harness.api("POST", `/api/v1/requests/${fe1}/claim`, bearer(accessToken));
    expect(answer.status).toBe(200);
    expect(await stored(fe1)).toEqual({ state: "claimed", claimant: erin.userId });
    const { rows } = await harness.install.owner.query("SELECT actor_kind, actor_user_id, client, surface FROM events WHERE type = 'request.claimed' ORDER BY number DESC LIMIT 1");
    expect(rows[0]).toEqual({ actor_kind: "agent", actor_user_id: erin.userId, client: client.clientId, surface: "api" });
  });

  // requests: Provenance is stamped by the server; D30 (3). A call through the CLI, which alone holds a token of the
  // CLI's client, from its device flow, is recorded on cli; any other /api/v1 call on api.
  it("held by the CLI, from its device flow, is recorded as an agent's action through the CLI, on cli", async () => {
    const fe = (await harness.install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'FE'")).rows[0]?.id ?? "";
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, alice.userId, { targetTeam: "FE" });
    const { accessToken } = await harness.signInCli(bob);
    const answer = await harness.api("POST", `/api/v1/requests/${request.key}/claim`, bearer(accessToken));
    expect(answer.status).toBe(200);
    const { rows } = await harness.install.owner.query("SELECT actor_kind, actor_user_id, client, surface, team_id FROM events WHERE type = 'request.claimed' ORDER BY number DESC LIMIT 1");
    expect(rows[0]).toEqual({ actor_kind: "agent", actor_user_id: bob.userId, client: "tiehall-cli", surface: "cli", team_id: fe });
  });

  it("turns a commitment into a proposal: Erin's agent declining FE-1 gets 202 with a proposal, and FE-1 is not declined", async () => {
    const { client, accessToken } = await harness.tokens(erin, ["requests:read", "requests:write"]);
    const answer = await harness.api("POST", `/api/v1/requests/${fe1}/status`, bearer(accessToken), { state: "declined" });
    expect(answer.status).toBe(202);
    const body = (await answer.json()) as { proposal: { kind: string; accountableHuman: { id: string } } };
    expect(body.proposal).toMatchObject({ kind: "decline", accountableHuman: { id: erin.userId } });
    expect((await stored(fe1)).state).not.toBe("declined");
    const { rows } = await harness.install.owner.query("SELECT actor_kind, client, surface FROM proposals WHERE kind = 'decline' ORDER BY created_at DESC LIMIT 1");
    expect(rows[0]).toEqual({ actor_kind: "agent", client: client.clientId, surface: "api" });
  });
});

describe("a personal access token", () => {
  const pat = (userId: string): PersonalAccessTokenCaller => ({ ...tokenOf(userId), scopes: [...EVERY_SCOPE] });

  it("cannot act outside its user's part, whatever scopes it carries", async () => {
    const answer = await callApi(harness.install, pat(bob.userId), "POST", `/api/v1/requests/${pay7}/claim`);
    expect(answer.status).toBe(403);
    expect(await stored(pay7)).toEqual({ state: "open", claimant: null });
  });

  it("gets 404 with every scope on the path of an internal command, an admin operation among them, a member's and an admin's alike", async () => {
    await harness.install.owner.query("UPDATE members SET role = 'admin' WHERE user_id = $1", [alice.userId]);
    for (const user of [bob.userId, alice.userId]) {
      for (const [method, path] of [
        ["POST", "/api/v1/teams"],
        ["POST", "/api/v1/invites"],
        ["POST", `/api/v1/members/${bob.userId}/role`],
        ["POST", "/api/v1/settings/sign-in-policy"],
        ["POST", "/api/v1/personal-access-tokens"],
      ] as const) {
        const answer = await callApi(harness.install, pat(user), method, path, { role: "admin" });
        expect(answer.status, `${method} ${path}`).toBe(404);
        expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/route-not-found" });
      }
    }
    for (const id of ["teams.create", "members.change_role", "settings.set_sign_in_policy"]) {
      expect(CATALOG.get(id)?.surfaces, id).toEqual([]);
      await expect(harness.install.execute(id, pat(alice.userId), {}), id).rejects.toMatchObject({ status: 404 });
    }
  });

  it("gets 403 with every scope on an admin operation for a member, were a catalog ever to offer one on REST, and runs nothing", async () => {
    // A catalog that breaks the rule that admin operations are offered on no agent surface, built by hand as no
    // registration would allow: the role still bounds the token's user.
    const definition = defineCommand({
      id: "probes.admin_report",
      summary: "An admin operation, offered on REST against the rules.",
      input: z.object({}),
      output: z.object({ ran: z.boolean() }),
      method: "POST",
      path: "/api/v1/probes/admin-report",
      scopes: ["requests:read"],
      commitment: false,
      confirm: false,
      admin: "activity_log",
      surfaces: ["rest"],
      stability: "alpha",
    });
    const catalog: Catalog = { commands: [definition], get: (id) => (id === definition.id ? definition : undefined) };
    let runs = 0;
    const execute = createExecute({
      catalog,
      handlers: { [definition.id]: async () => ((runs += 1), { ran: true }) },
      store: { database: harness.install.db, jobs: { send: async () => {} } },
    });
    const call = (caller: Caller) =>
      createRestHandler({ catalog, document: "{}\n", execute, authenticate: async () => caller, logger: createLogger({ write: () => {} }) })(
        new Request(`${URL_OF_INSTALL}/api/v1/probes/admin-report`, { method: "POST" }),
      );
    const refused = await call(pat(bob.userId));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { type: string }).type).toBe("https://tiehall.com/problems/forbidden");
    expect(runs).toBe(0);
  });
});

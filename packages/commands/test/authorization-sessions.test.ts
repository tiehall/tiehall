import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { URL_OF_INSTALL } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";
import { pkcePair, startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";

// The authorization endpoint takes a web session only as Tiehall's own pages
// take it (sign-in: Signing out and ending sessions, as github-layer-hardening
// states it; agent-access: The consent screen shows who is asking; design.md,
// Decisions this change rests on: D37). An agent client sends the person's
// browser to /api/auth/oauth2/authorize, which gives a code for a client the
// person approved. A browser whose web session reached its 30 days is treated
// as not signed in there too: it gets no code, is sent to sign in, and the
// session is gone. A browser that carries a session a removal ended is
// refused with 403 and gets no code, whatever grant exists.

let harness: AgentAccessHarness;

beforeAll(async () => {
  harness = await startAgentAccess();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe("the authorization endpoint", () => {
  it("still gives a code to a signed-in member for a client they approved", async () => {
    const ana = await harness.member("ana-fresh");
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    const answer = await harness.authorize(ana.cookie, client, pkcePair(), { scope: "requests:read" });
    expect(new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL).searchParams.get("code")).not.toBeNull();
  });

  it("treats a web session that reached its 30 days as none: no code, the browser is sent to sign in, the session is gone", async () => {
    const ana = await harness.member("ana-capped");
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    await harness.install.owner.query("UPDATE web_sessions SET created_at = now() - interval '31 days' WHERE user_id = $1", [ana.userId]);
    const answer = await harness.authorize(ana.cookie, client, pkcePair(), { scope: "requests:read" });
    expect([302, 303]).toContain(answer.status);
    const location = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.pathname).toBe("/sign-in");
    const { rows } = await harness.install.owner.query("SELECT count(*)::int AS n FROM web_sessions WHERE user_id = $1", [ana.userId]);
    expect(rows[0].n).toBe(0);
    // Tiehall's own pages treat the same browser as not signed in.
    const page = await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: ana.cookie, accept: "text/html" } }));
    expect(page.status).toBe(303);
  });

  it("refuses a session a removal ended with 403, and gives no code, even where a grant exists", async () => {
    const ada = sessionOf(await addUser(harness.install.owner, { role: "admin", login: "ada-ended" }));
    const dana = await harness.member("dana-ended");
    const client = await harness.registerClient();
    expect((await harness.install.confirm(ada, "members.remove", { userId: dana.userId })).status).toBe(200);
    // A grant row for Dana, as no write may leave one; the ended session must not reach it.
    await harness.approve(dana.userId, client.clientId, ["requests:read"]);
    const answer = await harness.authorize(dana.cookie, client, pkcePair(), { scope: "requests:read" });
    expect(answer.status).toBe(403);
    expect(answer.headers.get("location")).toBeNull();
    expect(await answer.text()).not.toContain("code=");
  });
});

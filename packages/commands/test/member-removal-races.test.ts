import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSessionCaller } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { holdRow, untilWaiting } from "./support/locks.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";
import { hiddenField, pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// A removal leaves no credential of the person alive, even one a write was
// creating as it committed (teams-and-roles: Removing a member; sign-in: An
// admin removal blocks rejoining through the organization; design.md,
// Decisions this change rests on: D28 #4, #10; design.md, Self-hosting
// decisions: S5 and S14). A personal access token Dana confirms, an agent
// client Dana approves and a refresh token Dana's agent rotates while an admin
// removes Dana each either fails or is revoked by the removal: none works
// again, and once an invite admits Dana again the PAT gets 401, the agent
// client meets the consent screen again, and the refresh token gets
// invalid_grant. Each case holds a row lock from the test, so the two writes
// overlap every time it runs.

let harness: AgentAccessHarness;
let ada: WebSessionCaller;

beforeAll(async () => {
  harness = await startAgentAccess();
  ada = sessionOf(await addUser(harness.install.owner, { role: "admin", login: "ada-races" }));
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The org's event counter, which every write takes with its first event, held as a write in flight holds it. */
const holdEventCounter = () => holdRow(harness.install.databaseUrl, "SELECT last_number FROM event_sequence FOR UPDATE");

/** Removes Dana with Ada's confirmation, and says when the removal has answered. */
function removing(dana: SignedIn): { answer: Promise<Response>; finished: () => boolean } {
  let finished = false;
  const answer = harness.install.confirm(ada, "members.remove", { userId: dana.userId }).finally(() => {
    finished = true;
  });
  return { answer, finished: () => finished };
}

/** An admin invites Dana's GitHub account after the removal, and Dana signs in with it. */
async function rejoin(dana: SignedIn, login: string): Promise<SignedIn> {
  // An access token records the second it was issued; a rejoin takes more than a second in any real install.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await harness.install.owner.query(
    `INSERT INTO invites (org_id, github_account_id, github_login, role, created_by, created_at, expires_at)
       SELECT o.id, u.github_account_id, u.github_login, 'member', $2, now(), now() + interval '7 days' FROM orgs o, users u WHERE u.id = $1`,
    [dana.userId, ada.userId],
  );
  const { response, jar } = await harness.signIn.signIn(login);
  expect(response.status).toBe(302);
  return { userId: dana.userId, cookie: jar.header() };
}

describe("a removal that commits while Dana's write creates a credential", () => {
  it("revokes a personal access token Dana confirms at that moment, or refuses it; after a rejoin it gets 401", async () => {
    let dana = await harness.member("dana-pat");
    // Dana's confirmation reaches its first event as the removal starts.
    const held = await holdEventCounter();
    const creating = harness.personalAccessToken(dana, { name: "Raced script" }).then(
      (token) => token,
      () => undefined,
    );
    await untilWaiting(harness.install.owner, 1);
    const removal = removing(dana);
    await untilWaiting(harness.install.owner, 2, removal.finished);
    await held.release();
    expect((await removal.answer).status).toBe(200);
    const pat = await creating;
    const { rows } = await harness.install.owner.query<{ revoked: boolean }>(
      "SELECT revoked_at IS NOT NULL AS revoked FROM personal_access_tokens WHERE user_id = $1",
      [dana.userId],
    );
    expect(rows.every(({ revoked }) => revoked)).toBe(true);
    dana = await rejoin(dana, "dana-pat");
    if (pat !== undefined) expect((await harness.api("GET", "/api/v1/requests", bearer(pat))).status).toBe(401);
  });

  it("removes a grant Dana confirms at that moment, or refuses it; after a rejoin the client meets the consent screen", async () => {
    let dana = await harness.member("dana-grant");
    const client = await harness.registerClient();
    // Dana is on the consent screen, and confirms as the removal starts.
    const toConsent = await harness.authorize(dana.cookie, client, pkcePair(), { scope: "requests:read" });
    const consentPath = toConsent.headers.get("location") ?? "";
    expect(new URL(consentPath, URL_OF_INSTALL).pathname).toBe("/consent");
    const html = await (await harness.handle(new Request(`${URL_OF_INSTALL}${consentPath}`, { headers: { cookie: dana.cookie, accept: "text/html" } }))).text();
    // Storing the grant reads Dana's user row, which is held until the removal has started.
    const held = await holdRow(harness.install.databaseUrl, "SELECT id FROM users WHERE id = $1 FOR UPDATE", [dana.userId]);
    const approving = harness.handle(
      new Request(`${URL_OF_INSTALL}/confirm/agent_clients.approve`, {
        method: "POST",
        headers: { cookie: dana.cookie, accept: "text/html", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ input: hiddenField(html, "input"), nonce: hiddenField(html, "nonce"), csrf: hiddenField(html, "csrf") }).toString(),
      }),
    );
    await untilWaiting(harness.install.owner, 1);
    const removal = removing(dana);
    await untilWaiting(harness.install.owner, 2, removal.finished);
    await held.release();
    expect((await removal.answer).status).toBe(200);
    await approving;
    const { rows } = await harness.install.owner.query("SELECT id FROM oauth_consents WHERE user_id = $1", [dana.userId]);
    expect(rows).toEqual([]);
    dana = await rejoin(dana, "dana-grant");
    const again = await harness.authorize(dana.cookie, client, pkcePair(), { scope: "requests:read" });
    expect(new URL(again.headers.get("location") ?? "", URL_OF_INSTALL).pathname).toBe("/consent");
  });

  it("leaves no refresh token from a rotation under way that works, then or after a rejoin", async () => {
    let dana = await harness.member("dana-refresh");
    const { client, refreshToken } = await harness.tokens(dana, ["requests:read"]);
    // The rotation stores its new refresh token as the removal commits: the client's row, which the new token's
    // foreign key reads, is held until then.
    const held = await holdRow(harness.install.databaseUrl, "SELECT id FROM oauth_clients WHERE client_id = $1 FOR UPDATE", [client.clientId]);
    const refreshing = harness.refresh(client, refreshToken ?? "");
    await untilWaiting(harness.install.owner, 1);
    const removal = removing(dana);
    await untilWaiting(harness.install.owner, 2, removal.finished);
    await held.release();
    expect((await removal.answer).status).toBe(200);
    const rotated = await refreshing;
    expect(rotated.body["error"]).toBe("invalid_grant");
    const { rows } = await harness.install.owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM oauth_refresh_tokens WHERE user_id = $1 AND revoked IS NULL",
      [dana.userId],
    );
    expect(rows[0]?.n).toBe(0);
    dana = await rejoin(dana, "dana-refresh");
    expect((await harness.refresh(client, refreshToken ?? "")).body["error"]).toBe("invalid_grant");
  });
});

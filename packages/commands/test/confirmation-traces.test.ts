import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { URL_OF_INSTALL } from "./support/install.ts";
import { startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// Where a confirmation that is not a commitment shows (requests: Receipts;
// agent-safety: The documented limit of the confirmation step; activity-log:
// Which actions are security events; agent-access: Personal access tokens are
// scoped, expiring and created in the web UI). docs/security-and-trust.md
// says that an agent driving a person's signed-in browser can click confirm,
// and how a confirmation the person did not make shows up: a commitment's
// confirmation and an undo give a receipt; the other confirmations give none,
// and are security events in the activity log, while a new personal access
// token is also listed on the person's Connected agents and tokens page. This
// checks that account against the install, for the case the page warns about:
// a browser-driving agent confirming a personal access token for itself.

const PAGE = new URL("../../../docs/security-and-trust.md", import.meta.url);

let harness: AgentAccessHarness;
let ana: SignedIn;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-t");
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

const receiptsOf = async (userId: string) =>
  (await harness.install.owner.query("SELECT count(*)::int AS n FROM receipts WHERE user_id = $1", [userId])).rows[0].n as number;

describe("a confirmed personal access token, which the trust docs name among the confirmations", () => {
  it("is what the docs say: a receipt for a commitment or an undo only, and the token on /tokens and in the activity log", () => {
    const text = readFileSync(PAGE, "utf8").replace(/\s+/g, " ");
    expect(text).toContain("a new personal access token");
    expect(text).toContain("Every confirmation of a commitment, and every undo, gets a receipt in the web inbox");
    expect(text).toContain("The other confirmations give no receipt");
    expect(text).toContain("is also listed on your page `/tokens`");
  });

  it("gives no receipt, and shows on the person's /tokens page and as a security event in the activity log", async () => {
    const receipts = await receiptsOf(ana.userId);
    const { rows } = await harness.install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events");
    await harness.personalAccessToken(ana, { name: "A token for an agent", scopes: ["requests:write"], expiresInDays: 30 });

    expect(await receiptsOf(ana.userId)).toBe(receipts);
    const page = await (await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: ana.cookie, accept: "text/html" } }))).text();
    expect(page).toContain("A token for an agent");
    const events = await harness.install.owner.query("SELECT type, class, actor_user_id FROM events WHERE number > $1 ORDER BY number", [rows[0].n]);
    expect(events.rows).toEqual([{ type: "personal_access_token.created", class: "security", actor_user_id: ana.userId }]);
  }, 120_000);
});

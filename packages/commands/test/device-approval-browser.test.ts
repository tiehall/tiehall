import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_CLIENT_ID, createDeviceApprovalRoute } from "../src/index.ts";
import { startBrowserHarness, type BrowserHarness } from "./support/browser.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { MCP_RESOURCE, startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { sessionOf } from "./support/requests.ts";

// The device approval page in a real browser (agent-access: The device
// approval page cannot be prefilled; agent-access: The CLI signs in through a
// restricted device flow; design.md, Design rules: Agent access; design.md,
// Self-hosting decisions: S7). `tiehall login` asks for a device code and
// prints it; the person follows a link that carries the code, finds the code
// field empty, types the code, reads where and when the sign-in was started,
// and approves it with the confirmation step. The CLI's next poll gets its
// tokens. device-approval.test.ts covers each refusal.

let harness: AgentAccessHarness;
let browser: BrowserHarness;
let ana: string;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = (await harness.member("ana-k")).userId;
  browser = await startBrowserHarness(harness.install, {
    pages: { "/device": (session, origin) => createDeviceApprovalRoute({ step: harness.install.step, session, url: origin, secret: harness.install.authSecret }) },
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await harness?.close();
}, 60_000);

/** `tiehall login`'s device authorization request. */
async function login(): Promise<{ deviceCode: string; userCode: string }> {
  const answer = await harness.handle(
    new Request(`${URL_OF_INSTALL}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.7" },
      body: new URLSearchParams({ client_id: CLI_CLIENT_ID, resource: MCP_RESOURCE, scope: "requests:read requests:write" }).toString(),
    }),
  );
  const body = (await answer.json()) as { device_code: string; user_code: string };
  return { deviceCode: body.device_code, userCode: body.user_code };
}

describe("the device approval page in a browser", { timeout: 60_000 }, () => {
  it("sends a browser without a session to sign in", async () => {
    const page = await browser.pageOf(undefined);
    const answer = await page.request.get(`${browser.origin}/device?user_code=ABCDEFGH`, { maxRedirects: 0 });
    expect(answer.status()).toBe(303);
    expect(answer.headers()["location"]).toBe(`/sign-in?return=${encodeURIComponent("/device")}`);
    await page.context().close();
  });

  it("ignores the code in its link, shows where and when the sign-in started once the code is typed, and approves it with a confirmation", async () => {
    const { deviceCode, userCode } = await login();
    const page = await browser.pageOf(sessionOf(ana));
    await page.goto(`${browser.origin}/device?user_code=${userCode}`);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Sign in the tiehall CLI");
    const field = page.getByLabel("The code tiehall login printed");
    await expect(field.inputValue()).resolves.toBe("");
    await expect(page.content()).resolves.not.toContain(userCode);

    await field.fill(userCode);
    await Promise.all([page.waitForURL(`${browser.origin}/device`), page.getByRole("button", { name: "Continue" }).click()]);
    await expect(page.getByText(/198\.51\.100\.7/).count()).resolves.toBe(1);
    await expect(page.getByText("Continue only if you just ran tiehall login.").count()).resolves.toBe(1);
    const { rows } = await harness.install.owner.query("SELECT status, user_id FROM oauth_device_codes WHERE device_code = $1", [deviceCode]);
    expect(rows).toEqual([{ status: "pending", user_id: null }]);

    await Promise.all([page.waitForURL(`${browser.origin}/confirm/agent_clients.approve_device`), page.getByRole("button", { name: "Confirm" }).click()]);
    await expect(page.getByText("Return to your terminal", { exact: false }).count()).resolves.toBe(1);
    const polled = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: CLI_CLIENT_ID }).toString(),
      }),
    );
    expect(polled.status).toBe(200);
    expect(((await polled.json()) as { access_token?: unknown }).access_token).toBeTypeOf("string");
    await page.context().close();
  });
});

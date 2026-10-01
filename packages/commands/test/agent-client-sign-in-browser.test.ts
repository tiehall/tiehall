import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCertificate } from "@tiehall/testing/tls";
import { pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { URL_OF_INSTALL } from "./support/install.ts";

// An approved agent client's authorization that reaches the sign-in page, in
// a real browser (agent-access: Approving an agent client uses the
// confirmation step; agent-access: The consent screen shows who is asking;
// sign-in: GitHub is the only way to sign in). A native agent client, such as
// an MCP client on the person's own computer, sends the person's browser to
// the authorization again, for example after its refresh token ran out, while
// the person's web session has ended. The authorization server sends the
// browser to the sign-in page, whose form's post leads to GitHub, which knows
// the install's App already and sends the browser straight back to the
// sign-in callback, which brings it back to the authorization; the person
// approved the client before, so the authorization sends the browser on to the
// client's redirect URI with the code at once. A browser applies the sign-in
// page's form-action to every redirect that follows its form's post, so the
// page's policy has to allow that last one, or the browser stops on the
// sign-in page and the client never gets its code. The install is
// https://tiehall.example.com, served over HTTPS with a test certificate the
// browser trusts by its key, through a host-resolver rule, with the routes of
// the agent access harness; the GitHub stub plays GitHub.

let harness: AgentAccessHarness;
let ana: SignedIn;
let server: Server;
let browser: Browser;
/** The client's own address on the person's computer, and what the browser brought to it. */
let loopback: { server: HttpServer; url: string; received: URLSearchParams[] };

beforeAll(async () => {
  harness = await startAgentAccess();
  // Ana signs in with GitHub once, which authorizes the install's App on GitHub.
  ana = await harness.member("ana-k");
  const received: URLSearchParams[] = [];
  const client = createHttpServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/callback") received.push(url.searchParams);
    outgoing.writeHead(url.pathname === "/callback" ? 200 : 404, { "content-type": "text/plain; charset=utf-8" }).end("The agent is signed in.");
  });
  await new Promise<void>((resolve) => client.listen(0, "127.0.0.1", resolve));
  loopback = { server: client, url: `http://127.0.0.1:${(client.address() as AddressInfo).port}/callback`, received };
  const certificate = createTestCertificate({ dnsNames: ["tiehall.example.com"] });
  server = createServer({ key: certificate.key, cert: certificate.cert }, (incoming, outgoing) => {
    answer(incoming, outgoing).catch((error: unknown) => {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({
    ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }),
    args: [`--host-resolver-rules=MAP tiehall.example.com 127.0.0.1:${port}`, `--ignore-certificate-errors-spki-list=${certificate.spkiSha256}`],
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  await new Promise((resolve) => loopback?.server.close(resolve));
  await harness?.close();
}, 60_000);

/** Answers the browser with the harness's routes, as the install at https://tiehall.example.com. */
async function answer(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = incoming.method ?? "GET";
  const request = new Request(new URL(incoming.url ?? "/", URL_OF_INSTALL), {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
  const answered = await harness.handle(request);
  const out: Record<string, string | string[]> = Object.fromEntries(answered.headers);
  const cookies = answered.headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies;
  outgoing.writeHead(answered.status, out);
  outgoing.end(Buffer.from(await answered.arrayBuffer()));
}

describe("an approved agent client's authorization that reaches the sign-in page", () => {
  it("sends the browser on to the client's loopback redirect URI with the code once its person has signed in again", { timeout: 120_000 }, async () => {
    const client = { clientId: "", redirectUri: loopback.url };
    client.clientId = (await harness.registerClient({ redirect_uris: [loopback.url] })).clientId;
    // Ana approved the client before; their web session has ended, and they are still signed in to GitHub.
    await harness.approve(ana.userId, client.clientId, ["requests:read", "requests:write"]);
    harness.stub.signIn("ana-k");
    const pkce = pkcePair();
    const authorization = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: loopback.url,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: "state-again",
      resource: `${URL_OF_INSTALL}/mcp`,
      scope: "requests:read requests:write",
    });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);

      await page.goto(`${URL_OF_INSTALL}/api/auth/oauth2/authorize?${authorization.toString()}`);
      await page.waitForURL(`${URL_OF_INSTALL}/sign-in?*`);
      // The form's post leads through GitHub and the sign-in callback back to the authorization, and on to the client.
      await Promise.all([page.waitForURL(`${loopback.url}?*`), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);

      const code = loopback.received.find((received) => received.get("state") === "state-again");
      expect(code?.get("iss")).toBe(URL_OF_INSTALL);
      const tokens = await harness.exchange(client, code?.get("code") ?? "", pkce);
      expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
      expect(typeof tokens.body["access_token"]).toBe("string");
    } finally {
      await context.close();
    }
  });
});

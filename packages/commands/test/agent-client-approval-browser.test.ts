import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { pkcePair } from "./support/agent-access.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// Approving an agent client in a real browser (agent-access: Approving an
// agent client uses the confirmation step; agent-access: The consent screen
// shows who is asking; design.md, Self-hosting decisions: S7). A native agent
// client, such as an MCP client on the person's own computer, registers with
// a loopback redirect URI and sends the person's browser to the
// authorization. The person approves it on the consent screen, whose form
// posts to the confirmation step; the confirmed approval sends the browser
// back to the authorization, which sends it on to the client's redirect URI
// with the code. A browser applies the consent screen's form-action to every
// redirect that follows its form's post, so the page's policy has to allow
// that last one, or the browser stops on the consent screen and the client
// never gets its code. The web app runs as the image runs it (web-app.ts).

let stub: GitHubStub;
let install: TestInstall;
let web: WebApp;
let signIn: SignInHarness;
let browser: Browser;
/** The client's own address on the person's computer, and what the browser brought to it. */
let loopback: { server: Server; url: string; received: URLSearchParams[] };

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  await addUser(install.owner, { login: "ana-k", githubAccountId: stub.addUser({ login: "ana-k" }).id });
  web = await startWebApp(install);
  signIn = await startSignIn(install, stub, { url: web.url });
  const received: URLSearchParams[] = [];
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/callback") received.push(url.searchParams);
    outgoing.writeHead(url.pathname === "/callback" ? 200 : 404, { "content-type": "text/plain; charset=utf-8" }).end("The agent is signed in.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  loopback = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`, received };
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => loopback?.server.close(resolve));
  await web?.close();
  await install?.close();
  await stub?.close();
}, 60_000);

/** Registers a native agent client with a loopback redirect URI, as an MCP client does, and returns its id. */
async function registerClient(redirectUri: string): Promise<string> {
  const answer = await web.fetch("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Desktop agent",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const body = (await answer.json()) as { client_id?: string };
  expect(answer.status, JSON.stringify(body)).toBe(201);
  return body.client_id ?? "";
}

describe("approving an agent client in a browser", () => {
  it("sends the browser on to the client's loopback redirect URI with the code, which the client exchanges for its tokens", { timeout: 120_000 }, async () => {
    const clientId = await registerClient(loopback.url);
    const pkce = pkcePair();
    const [name = "", value = ""] = ((await signIn.signIn("ana-k")).jar.header().split("; ").find((pair) => pair.startsWith("tiehall.session_token=")) ?? "").split(/=(.*)/s);
    const context = await browser.newContext();
    await context.addCookies([{ name, value, url: web.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const authorization = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: loopback.url,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: "state-1",
      resource: `${web.url}/mcp`,
      scope: "requests:read requests:write",
    });

    await page.goto(`${web.url}/api/auth/oauth2/authorize?${authorization.toString()}`);
    await page.waitForURL(`${web.url}/consent?*`);
    await page.getByRole("heading", { name: "Approve an agent client" }).waitFor();
    await Promise.all([page.waitForURL(`${loopback.url}?*`), page.getByRole("button", { name: "Confirm" }).click()]);

    expect(loopback.received).toHaveLength(1);
    const answer = loopback.received[0]!;
    expect(answer.get("state")).toBe("state-1");
    expect(answer.get("iss")).toBe(web.url);
    const token = await web.fetch("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: answer.get("code") ?? "",
        code_verifier: pkce.verifier,
        client_id: clientId,
        redirect_uri: loopback.url,
        resource: `${web.url}/mcp`,
      }).toString(),
    });
    const tokens = (await token.json()) as { access_token?: unknown };
    expect(token.status, JSON.stringify(tokens)).toBe(200);
    expect(typeof tokens.access_token).toBe("string");
    await context.close();
  });
});

import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { createTestCertificate } from "@tiehall/testing/tls";
import { createHomeRoute } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Signing in with GitHub and signing out, in a real browser (sign-in: GitHub
// is the only way to sign in; sign-in: Signing out and ending sessions). The
// install is https://tiehall.example.com, served over HTTPS with a test
// certificate the browser trusts by its key, through a host-resolver rule, so
// the browser keeps the session's __Secure- cookie as it would at an install.
// The GitHub stub plays GitHub's authorize page. A person who is not signed in
// opens the install, is sent to the sign-in page, which offers GitHub only,
// authorizes the install's App on GitHub, comes back signed in, and signs out;
// a person who may not sign in is refused with 403.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let server: Server;
let browser: Browser;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const ana = stub.addUser({ login: "ana-k", email: "ana@acme.example" });
  stub.addUser({ login: "kim-outside" });
  await addUser(install.owner, { login: "ana-k", githubAccountId: ana.id });
  harness = await startSignIn(install, stub);
  const home = createHomeRoute({ session: (request) => harness.service.session(request.headers), secret: () => install.authSecret, logger: install.logger });

  const route = (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return home(request);
    if (pathname === "/sign-in") return harness.service.page(request);
    if (pathname === "/sign-out") return harness.service.signOut(request);
    if (pathname.startsWith("/api/auth/")) return harness.service.handler(request);
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };
  const certificate = createTestCertificate({ dnsNames: ["tiehall.example.com"] });
  server = createServer({ key: certificate.key, cert: certificate.cert }, (incoming, outgoing) => {
    answer(route, incoming, outgoing).catch((error: unknown) => {
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
  await stub?.close();
  await install?.close();
});

/** Answers the browser with the install's routes, as the install at https://tiehall.example.com. */
async function answer(route: (request: Request) => Promise<Response>, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
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
  const answered = await route(request);
  const out: Record<string, string | string[]> = Object.fromEntries(answered.headers);
  const cookies = answered.headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies;
  outgoing.writeHead(answered.status, out);
  outgoing.end(Buffer.from(await answered.arrayBuffer()));
}

describe("signing in with GitHub in a browser", { timeout: 90_000 }, () => {
  it("sends a visitor to sign in, signs a member in through GitHub, and signs them out", async () => {
    stub.signIn("ana-k");
    const context = await browser.newContext();
    const page = await context.newPage();

    // Not signed in: the install sends the browser to the sign-in page, which offers GitHub only.
    await page.goto(`${URL_OF_INSTALL}/`);
    expect(page.url()).toBe(`${URL_OF_INSTALL}/sign-in`);
    await expect(page.getByRole("button").allTextContents()).resolves.toEqual(["Sign in with GitHub"]);

    // GitHub asks to authorize the install's App, and sends the browser back signed in.
    await Promise.all([page.waitForURL(`${stub.webUrl}/login/oauth/authorize?*`), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
    await Promise.all([page.waitForURL(`${URL_OF_INSTALL}/`), page.getByRole("button", { name: `Authorize ${harness.app.name}` }).click()]);
    await expect(page.getByText("You are signed in.").count()).resolves.toBe(1);
    const [session] = (await context.cookies(URL_OF_INSTALL)).filter(({ name }) => name === "__Secure-tiehall.session_token");
    expect(session).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax", path: "/" });

    // Signing out ends the session: the browser is sent to sign in again.
    await Promise.all([page.waitForURL(`${URL_OF_INSTALL}/sign-in`), page.getByRole("button", { name: "Sign out" }).click()]);
    expect((await context.cookies(URL_OF_INSTALL)).map(({ name }) => name)).not.toContain("__Secure-tiehall.session_token");
    await page.goto(`${URL_OF_INSTALL}/`);
    expect(page.url()).toBe(`${URL_OF_INSTALL}/sign-in`);
    await context.close();
  });

  it("refuses a person who may not sign in with 403 and the text that says to ask an admin for an invite", async () => {
    stub.signIn("kim-outside");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${URL_OF_INSTALL}/sign-in`);
    await Promise.all([page.waitForURL(`${stub.webUrl}/login/oauth/authorize?*`), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
    const [refused] = await Promise.all([
      page.waitForResponse((response) => response.url().startsWith(`${URL_OF_INSTALL}/api/auth/callback/github`)),
      page.getByRole("button", { name: `Authorize ${harness.app.name}` }).click(),
    ]);
    expect(refused.status()).toBe(403);
    await expect(page.content()).resolves.toContain("Ask an admin of the install for an invite");
    // The browser gets a page, not the problem as JSON: the refusal's title and its problem type, and a link to sign in.
    expect(refused.headers()["content-type"]).toBe("text/html; charset=utf-8");
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Sign-in refused");
    await expect(page.content()).resolves.toContain("https://tiehall.com/problems/sign-in-refused");
    await expect(page.getByRole("link", { name: "Go to the sign-in page" }).getAttribute("href")).resolves.toBe("/sign-in");
    expect((await context.cookies(URL_OF_INSTALL)).map(({ name }) => name)).not.toContain("__Secure-tiehall.session_token");
    await context.close();
  });
});

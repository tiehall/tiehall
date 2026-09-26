import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import type { WebSessionCaller } from "../../src/index.ts";
import type { TestInstall } from "./install.ts";

// A browser for the tests of the web UI's pages, such as a proposal's confirm
// page. It is the installed Google Chrome (Playwright's "chrome" channel),
// which the CI runner has, so no browser is downloaded; TIEHALL_TEST_CHROME
// names another Chromium-based executable. A local server answers the
// browser with the install's own routes, as the install at the server's
// origin, so the browser sends what it sends to an install, such as its Origin
// and Sec-Fetch-Site headers. Each person's browser is its own context, which
// holds a cookie naming the web session it is signed in with, or none; the
// sign-in service, which issues real sessions, is not part of these tests.

export interface BrowserHarness {
  /** The origin of the local server, which the install's routes take as the install's URL. */
  origin: string;
  /** A page in a fresh browser of its own, signed in as this web session, or signed in as nobody. */
  pageOf(session: WebSessionCaller | undefined): Promise<Page>;
  close(): Promise<void>;
}

const COOKIE = "tiehall_test_session";

export async function startBrowserHarness(install: TestInstall): Promise<BrowserHarness> {
  /** The web sessions the browsers are signed in with, by the value of their cookie. */
  const sessions = new Map<string, WebSessionCaller>();
  let origin = "";
  const sessionOf = async (request: Request) => {
    const cookie = /(?:^|;\s*)tiehall_test_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    return cookie === undefined ? undefined : sessions.get(cookie);
  };

  async function answer(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    }
    const method = incoming.method ?? "GET";
    const request = new Request(new URL(incoming.url ?? "/", origin), {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
    });
    const answered = await install.confirmRouteFor(sessionOf, origin)(request);
    outgoing.writeHead(answered.status, Object.fromEntries(answered.headers));
    outgoing.end(Buffer.from(await answered.arrayBuffer()));
  }

  const server: Server = createServer((incoming, outgoing) => {
    answer(incoming, outgoing).catch((error: unknown) => {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  const browser: Browser = await chromium.launch(executablePath === undefined ? { channel: "chrome" } : { executablePath });

  return {
    origin,
    async pageOf(session) {
      const context = await browser.newContext();
      if (session !== undefined) {
        const value = randomUUID();
        sessions.set(value, session);
        await context.addCookies([{ name: COOKIE, value, url: origin }]);
      }
      return context.newPage();
    },
    async close() {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

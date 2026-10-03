import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_PATH, REFERENCE_PATH, SCRIPT_PATH, referencePage, referenceScript, scalarBundle } from "../lib/api-reference.ts";

// The API reference page at /docs/api (public-api: The API reference page at
// `/docs/api`; design.md, Technical decisions: T10; design.md, Self-hosting
// decisions: S13). The page renders the install's OpenAPI document with the
// reference bundle the install serves itself, with web fonts off, a strict
// Content-Security-Policy and the test-request panel hidden, so an anonymous
// browser reads it, it loads nothing from any other host, and it offers no
// control that sends a request or takes a token.
//
// A local server answers the page's three routes with the same handlers the
// web app's routes use, and /api/v1/openapi.json with a fixture document that
// has an operation, so the page has an operation to show. The browser is the
// installed Google Chrome (Playwright's "chrome" channel), which the CI runner
// has, so no browser is downloaded; TIEHALL_TEST_CHROME names another
// Chromium-based executable.

const DOCUMENT = readFileSync(new URL("../../../packages/catalog/test/fixtures/openapi/v1.json", import.meta.url), "utf8");

let server: Server;
let origin: string;
let browser: Browser;

async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", origin);
  const webRequest = new Request(url, { method: request.method ?? "GET", headers: request.headers as Record<string, string> });
  let answered: Response;
  if (url.pathname === REFERENCE_PATH) answered = referencePage();
  else if (url.pathname === SCRIPT_PATH) answered = referenceScript();
  else if (url.pathname === BUNDLE_PATH) answered = await scalarBundle(webRequest);
  else if (url.pathname === "/api/v1/openapi.json") answered = new Response(DOCUMENT, { headers: { "content-type": "application/json" } });
  else answered = new Response("Not found", { status: 404 });
  response.writeHead(answered.status, Object.fromEntries(answered.headers));
  response.end(Buffer.from(await answered.arrayBuffer()));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    answer(request, response).catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch(executablePath === undefined ? { channel: "chrome" } : { executablePath });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
}, 60_000);

interface Visit {
  page: Page;
  status: number | undefined;
  csp: string | undefined;
  /** Every URL the page requested, the page itself included. */
  loaded: string[];
  /** Every Content-Security-Policy violation the page reported. */
  violations: string[];
}

/** Opens /docs/api in a fresh browser context, with no cookies or session, and waits for the reference to show. */
async function visit(options: { bypassCSP?: boolean } = {}): Promise<Visit> {
  const context = await browser.newContext({ bypassCSP: options.bypassCSP ?? false });
  const page = await context.newPage();
  const loaded: string[] = [];
  page.on("request", (request) => loaded.push(request.url()));
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const response = await page.goto(`${origin}${REFERENCE_PATH}`);
  // The fixture's operation, as the reference renders it.
  await page.getByText("Open a request to a team.").first().waitFor({ timeout: 30_000 });
  // Lets requests that start after the first render, such as fonts and lazy parts, begin.
  await page.waitForLoadState("networkidle");
  const violations = await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
  return { page, status: response?.status(), csp: response?.headers()["content-security-policy"], loaded, violations };
}

describe("the API reference page", { timeout: 60_000 }, () => {
  it("is read by an anonymous browser, with a 200 and the install's document", async () => {
    const { page, status } = await visit();
    expect(status).toBe(200);
    // Not sent to sign in: still on the page, which may add a fragment for the section in view.
    expect(new URL(page.url()).pathname).toBe(REFERENCE_PATH);
    await expect(page.getByText("Tiehall API").first().isVisible()).resolves.toBe(true);
    await page.context().close();
  });

  it("sends a strict Content-Security-Policy", async () => {
    const { page, csp } = await visit();
    const directives = new Map(
      (csp ?? "").split(";").map((part) => {
        const [name = "", ...values] = part.trim().split(/\s+/);
        return [name, values] as const;
      }),
    );
    expect(directives.get("default-src")).toEqual(["'none'"]);
    // Scripts only with this answer's nonce: no inline script, no eval, no host.
    expect(directives.get("script-src")).toEqual([expect.stringMatching(/^'nonce-[A-Za-z0-9+/_-]+=*'$/)]);
    // Styles only inline, as the bundle adds them: no style sheet from any host.
    expect(directives.get("style-src")).toEqual(["'unsafe-inline'"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("img-src")).toEqual(["'self'", "data:"]);
    expect(directives.get("font-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    await page.context().close();
  });

  it("loads nothing from another host and breaks none of its own policy", async () => {
    const { page, loaded, violations } = await visit();
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((url) => !url.startsWith(`${origin}/`) && !url.startsWith("data:"))).toEqual([]);
    expect(violations).toEqual([]);
    await page.context().close();
  });

  it("loads nothing from another host even with its policy switched off, so it asks for nothing the policy would block", async () => {
    const { page, loaded } = await visit({ bypassCSP: true });
    expect(loaded.filter((url) => !url.startsWith(`${origin}/`) && !url.startsWith("data:"))).toEqual([]);
    await page.context().close();
  });

  it("offers no control that sends a request or takes a token, even after every button on it is pressed", async () => {
    const { page, loaded } = await visit();
    const methods: string[] = [];
    page.on("request", (request) => methods.push(`${request.method()} ${request.url()}`));
    expect(await offeredControls(page)).not.toEqual([]);
    expect(await sendingControls(page)).toEqual([]);
    // Presses each button a reader sees, but for the document download, and closes what it opened.
    const buttons = page.locator("button");
    for (let index = 0; index < (await buttons.count()); index += 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible()) || /download/i.test((await button.textContent()) ?? "")) continue;
      await button.click({ timeout: 2_000 }).catch(() => undefined);
      expect(await sendingControls(page), `after pressing button ${index}`).toEqual([]);
      await page.keyboard.press("Escape");
    }
    // Nothing was sent: every request after the page loaded read something from the install.
    expect(methods.filter((request) => !/^GET /.test(request) || !request.startsWith(`GET ${origin}/`))).toEqual([]);
    expect(loaded.length).toBeGreaterThan(0);
    await page.context().close();
  });
});

/** The controls a reader can see and use, as tag, type, text, label and placeholder. */
function offeredControls(page: Page): Promise<string[]> {
  // Scalar keeps its request client in the page, hidden; checkVisibility leaves it out while nothing opens it.
  return page.evaluate(() =>
    [...document.querySelectorAll("button, a, [role=button], input, textarea, select, [contenteditable=true]")]
      .filter((element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
      .map((element) =>
        `${element.tagName.toLowerCase()}[${element.getAttribute("type") ?? ""}] ${(element.textContent ?? "").trim()} ${
          element.getAttribute("aria-label") ?? ""
        } ${element.getAttribute("placeholder") ?? ""}`.replace(/\s+/g, " "),
      ),
  );
}

/** The offered controls that send a request, or that take a token or a password. */
async function sendingControls(page: Page): Promise<string[]> {
  const controls = await offeredControls(page);
  return [
    ...controls.filter((control) => /test request|send|try it|api client|run request/i.test(control)),
    ...controls.filter((control) => /^(input|textarea)/.test(control) && /token|password|api key|auth|bearer|secret/i.test(control)),
    ...controls.filter((control) => /^input\[password\]/.test(control)),
  ];
}

describe("the page's scripts", { timeout: 30_000 }, () => {
  it("are served by the install itself, as JavaScript", async () => {
    const page = await (await fetch(`${origin}${REFERENCE_PATH}`)).text();
    const sources = [...page.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(([, source]) => source);
    expect(sources).toEqual([SCRIPT_PATH, BUNDLE_PATH]);
    for (const source of sources) {
      const response = await fetch(`${origin}${source}`);
      expect(response.status, source).toBe(200);
      expect(response.headers.get("content-type"), source).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("x-content-type-options"), source).toBe("nosniff");
    }
  });

  it("revalidate the bundle by its ETag", async () => {
    const first = await fetch(`${origin}${BUNDLE_PATH}`);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const again = await fetch(`${origin}${BUNDLE_PATH}`, { headers: { "if-none-match": etag ?? "" } });
    expect(again.status).toBe(304);
  });

  it("give the page a fresh nonce on every answer", async () => {
    const nonce = async () => /'nonce-([^']+)'/.exec((await fetch(`${origin}${REFERENCE_PATH}`)).headers.get("content-security-policy") ?? "")?.[1];
    const [first, second] = [await nonce(), await nonce()];
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });
});

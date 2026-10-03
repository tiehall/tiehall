import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestUrlAnswer } from "@tiehall/commands";

// The proxy and the web UI's page of a request URL or an intake page
// (agent-surfaces: Negotiated request URLs; agent-surfaces: Team intake pages;
// agent-surfaces: Request URL response headers). The proxy negotiates every
// call to /<KEY> and /<TEAM> before the page may render, and lets a call that
// negotiates HTML go on to the page naming the key it read in a request
// header of its own; it takes that header from every other call. The page
// renders only a call the proxy negotiated as the page of that very key, and
// is no page otherwise, so no path, method or header that reaches the page
// around the negotiation shows anything. packages/commands/test/request-urls.test.ts
// and intake-pages.test.ts run both in the built app; these tests hold the
// proxy's header and the page's check to it, with the setup gate and the
// negotiation stubbed.

const NEGOTIATED_KEY = "x-tiehall-negotiated-key";

/** What the stubbed negotiation answers the next call with. */
let negotiated: RequestUrlAnswer | undefined;
/** The operations the page read, by their ids. */
let reads: string[];
/** The request headers the page's call carries. */
let callHeaders: Headers;

vi.mock("@tiehall/commands/setup", () => ({ setupGate: () => async () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => callHeaders }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("@tiehall/commands/web", async (original) => {
  const refused = { ok: false, problem: { status: 403, title: "Refused", detail: "Refused for the test." } };
  return {
    ...(await original<typeof import("@tiehall/commands/web")>()),
    requestUrlRoute: () => async () => negotiated,
    webCommands: () => ({
      read: async (commandId: string) => {
        reads.push(commandId);
        return refused;
      },
      csrfToken: async () => "csrf",
    }),
    readRequestPageAs: async () => {
      reads.push("requests.get");
      return refused;
    },
  };
});

const { proxy } = await import("../proxy.ts");
const { default: Page } = await import("../app/[key]/page.tsx");

beforeEach(() => {
  negotiated = undefined;
  reads = [];
  callHeaders = new Headers();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** The request headers Next.js hands the route after the proxy: undefined when the proxy leaves them as they came. */
function overridden(response: Response): Map<string, string> | undefined {
  const names = response.headers.get("x-middleware-override-headers");
  if (names === null) return undefined;
  return new Map(names.split(",").map((name) => [name, response.headers.get(`x-middleware-request-${name}`) ?? ""]));
}

describe("the proxy", () => {
  it("takes the header it tells the page with from a call to any other path", async () => {
    const response = await proxy(new Request("http://localhost/members", { headers: { [NEGOTIATED_KEY]: "FE-1", accept: "text/html" } }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    const headers = overridden(response);
    expect(headers).toBeDefined();
    expect(headers?.has(NEGOTIATED_KEY)).toBe(false);
    expect(headers?.get("accept")).toBe("text/html");
  });

  it("leaves any other call's headers as they came", async () => {
    const response = await proxy(new Request("http://localhost/members", { headers: { accept: "text/html" } }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(overridden(response)).toBeUndefined();
  });

  it("names the key it read to the page of a call it negotiated as HTML, whatever the call named, and marks the answer for the web role", async () => {
    negotiated = { page: { key: "FE-1", headers: new Headers({ etag: 'W/"page"', "content-security-policy": "script-src 'self' 'nonce-abc'" }) } };
    const response = await proxy(new Request("http://localhost/%46E-1", { headers: { [NEGOTIATED_KEY]: "SRE-1" } }));
    expect(overridden(response)?.get(NEGOTIATED_KEY)).toBe("FE-1");
    expect(overridden(response)?.get("content-security-policy")).toBe("script-src 'self' 'nonce-abc'");
    expect(response.headers.get(NEGOTIATED_KEY)).toBe("FE-1");
    expect(response.headers.get("etag")).toBe('W/"page"');
  });

  it("answers a call itself when the negotiation answers it", async () => {
    negotiated = { response: new Response(null, { status: 403 }) };
    const response = await proxy(new Request("http://localhost/FE-1", { method: "PUT", headers: { [NEGOTIATED_KEY]: "FE-1" } }));
    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });
});

describe("the web UI's page at /<KEY>", () => {
  const render = (key: string) => Page({ params: Promise.resolve({ key }) });

  it("is no page for a call the proxy did not negotiate, and reads nothing", async () => {
    await expect(render("FE-1")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render("FE")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(reads).toEqual([]);
  });

  it("is no page for a call the proxy negotiated as another key's page", async () => {
    callHeaders = new Headers({ [NEGOTIATED_KEY]: "FE-2" });
    await expect(render("FE-1")).rejects.toThrow("NEXT_NOT_FOUND");
    callHeaders = new Headers({ [NEGOTIATED_KEY]: "FE-1" });
    await expect(render("FE")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(reads).toEqual([]);
  });

  it("reads the request or the team the proxy negotiated the call as", async () => {
    callHeaders = new Headers({ [NEGOTIATED_KEY]: "FE-1" });
    await render("FE-1").catch(() => undefined);
    callHeaders = new Headers({ [NEGOTIATED_KEY]: "FE" });
    await render("FE").catch(() => undefined);
    expect(reads).toEqual(["requests.get", "teams.get"]);
  });

  // public-api: One error model for Tiehall's own refusals. A server component cannot set its answer's status, so a
  // read refused between the proxy's read and the page's, other than for a browser that is not signed in or a page
  // that is gone, sends the browser to the same URL again, whose negotiation then answers the refusal as its page,
  // with its own status (403 here), rather than the page saying it with 200.
  it("sends a call whose read is refused with 403 to the same URL, whose negotiation answers the refusal with its status", async () => {
    callHeaders = new Headers({ [NEGOTIATED_KEY]: "FE-1" });
    await expect(render("FE-1")).rejects.toThrow("NEXT_REDIRECT /FE-1");
    callHeaders = new Headers({ [NEGOTIATED_KEY]: "FE" });
    await expect(render("FE")).rejects.toThrow("NEXT_REDIRECT /FE");
  });
});

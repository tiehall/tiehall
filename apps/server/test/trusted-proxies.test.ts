import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { forwardedClient, TrustedProxies } from "../src/trusted-proxies.ts";
import { installRequestGuard, type RequestGuard } from "../src/request-guard.ts";

// Forwarded headers are trusted only from the reverse proxies `.env` names
// (self-host-install: `TIEHALL_URL` and TLS). From any other address, a
// request's X-Forwarded-For and X-Forwarded-Proto are ignored: the client is
// the connection's own address, and the scheme the connection's own. The web
// role rewrites both headers before the app sees a request, so everything
// that reads them, such as the security event of a sign-in, reads the client
// the install trusts.

const noNames = async () => [];

function proxies(entries: string[], resolve: (name: string) => Promise<string[]> = noNames): TrustedProxies {
  return new TrustedProxies(entries, { resolve });
}

describe("the client of a request", () => {
  it("is the connection's own address and scheme when the peer is not a named proxy", () => {
    const trusted = proxies(["10.0.0.5"]);
    expect(forwardedClient("192.0.2.10", { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" }, false, trusted)).toEqual({
      address: "192.0.2.10",
      scheme: "http",
    });
  });

  it("comes from X-Forwarded-For and X-Forwarded-Proto when the peer is a named proxy", () => {
    const trusted = proxies(["10.0.0.5"]);
    expect(forwardedClient("10.0.0.5", { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" }, false, trusted)).toEqual({
      address: "203.0.113.7",
      scheme: "https",
    });
  });

  it("walks a chain of proxies from the right, stopping at the first address that is not trusted", () => {
    const trusted = proxies(["10.0.0.0/24"]);
    const headers = { "x-forwarded-for": "198.51.100.1, 203.0.113.7, 10.0.0.4", "x-forwarded-proto": "https, http" };
    expect(forwardedClient("10.0.0.5", headers, false, trusted)).toEqual({ address: "203.0.113.7", scheme: "https" });
  });

  it("matches CIDR ranges, IPv6, and IPv4 addresses that arrive mapped into IPv6", () => {
    expect(forwardedClient("::ffff:172.18.0.3", { "x-forwarded-for": "203.0.113.7" }, false, proxies(["172.16.0.0/12"])).address).toBe(
      "203.0.113.7",
    );
    expect(forwardedClient("fd00::1", { "x-forwarded-for": "2001:db8::7" }, false, proxies(["fd00::/8"])).address).toBe("2001:db8::7");
    expect(forwardedClient("fd00::1", { "x-forwarded-for": "2001:db8::7" }, false, proxies(["10.0.0.5"])).address).toBe("fd00::1");
  });

  it("keeps the connection's scheme when a named proxy sends none, or one that is not http or https", () => {
    const trusted = proxies(["10.0.0.5"]);
    expect(forwardedClient("10.0.0.5", { "x-forwarded-for": "203.0.113.7" }, true, trusted).scheme).toBe("https");
    expect(forwardedClient("10.0.0.5", { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "gopher" }, false, trusted).scheme).toBe(
      "http",
    );
  });

  it("stops at the last trusted hop when a named proxy forwards something that is not an address", () => {
    const trusted = proxies(["10.0.0.5"]);
    expect(forwardedClient("10.0.0.5", { "x-forwarded-for": "unknown" }, false, trusted).address).toBe("10.0.0.5");
  });

  it("trusts the addresses a named host resolves to, and follows it when they change", async () => {
    let answer = ["172.18.0.4"];
    const trusted = proxies(["caddy"], async (name) => (name === "caddy" ? answer : []));
    await trusted.refresh();
    expect(trusted.isTrusted("172.18.0.4")).toBe(true);
    answer = ["172.18.0.9"];
    await trusted.refresh();
    expect(trusted.isTrusted("172.18.0.4")).toBe(false);
    expect(trusted.isTrusted("172.18.0.9")).toBe(true);
  });

  it("trusts nothing from a name that does not resolve", async () => {
    const trusted = proxies(["caddy"], async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND caddy"), { code: "ENOTFOUND" });
    });
    await trusted.refresh();
    expect(trusted.isTrusted("172.18.0.4")).toBe(false);
  });
});

describe("the request guard on the web server", () => {
  let guard: RequestGuard | undefined;

  afterEach(() => {
    guard?.uninstall();
    guard = undefined;
  });

  /** Starts a server the way the Next.js standalone server does, after the guard, and returns the headers it saw. */
  async function headersSeen(trusted: TrustedProxies, headers: Record<string, string>): Promise<IncomingHttpHeaders> {
    guard = installRequestGuard({ proxies: trusted });
    // The Next.js standalone server creates its server through the http module's object, as here.
    const http = (await import("node:http")).default;
    let seen: IncomingHttpHeaders = {};
    const server = http.createServer((request, response) => {
      seen = request.headers;
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await new Promise<void>((resolve, reject) => {
        const call = httpRequest({ host: "127.0.0.1", port, path: "/", headers }, (response) => {
          response.resume();
          response.on("end", resolve);
        });
        call.on("error", reject);
        call.end();
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    return seen;
  }

  const spoofed = {
    "x-forwarded-for": "203.0.113.7",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "evil.example",
    forwarded: "for=203.0.113.7;proto=https",
    "x-real-ip": "203.0.113.7",
  };

  it("ignores forwarded headers from an address that is not named, for the client address and the scheme", async () => {
    const seen = await headersSeen(proxies(["10.0.0.5"]), spoofed);
    expect(seen["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen["x-forwarded-proto"]).toBe("http");
    expect(seen["x-forwarded-host"]).toBeUndefined();
    expect(seen["forwarded"]).toBeUndefined();
    expect(seen["x-real-ip"]).toBeUndefined();
  });

  it("uses the same headers from a named proxy", async () => {
    const seen = await headersSeen(proxies(["127.0.0.1"]), spoofed);
    expect(seen["x-forwarded-for"]).toBe("203.0.113.7");
    expect(seen["x-forwarded-proto"]).toBe("https");
    expect(seen["x-forwarded-host"]).toBe("evil.example");
  });

  it("trusts a proxy named by a host name that resolves to the peer", async () => {
    const trusted = new TrustedProxies(["localhost"]);
    await trusted.refresh();
    const seen = await headersSeen(trusted, spoofed);
    expect(seen["x-forwarded-for"]).toBe("203.0.113.7");
  });
});

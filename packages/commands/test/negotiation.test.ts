import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { negotiate, requestUrlNegotiatesHtml, requestUrlOf, varyOnNegotiatedUrls, withNegotiatedVary } from "../src/index.ts";

// Content negotiation of request URLs (agent-surfaces: Negotiated request URLs;
// agent-surfaces: A browser without a session is sent to sign-in;
// agent-surfaces: Request URL response headers; design.md, Readings to confirm
// with the founder: R17). The .md and .json suffixes win; otherwise the Accept
// header decides, as RFC 9110 has it, and HTML is what a call gets that asks
// for text/html, sends no Accept header, or names nothing more specific that
// Tiehall serves. Every answer of a request URL varies with Accept and
// Authorization, whatever else set its Vary, as Next.js does for the web UI's
// page.

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

describe("a request URL's path", () => {
  it.each([
    ["/FE-142", { key: "FE-142", suffix: undefined }],
    ["/FE-142.md", { key: "FE-142", suffix: "markdown" }],
    ["/FE-142.json", { key: "FE-142", suffix: "json" }],
    ["/PAY2-7", { key: "PAY2-7", suffix: undefined }],
  ])("%s names a request", (path, named) => {
    expect(requestUrlOf(path)).toEqual(named);
  });

  it.each(["/fe-142", "/FE", "/FE-0", "/FE-142.txt", "/FE-142/", "/api/v1/requests/FE-142", "/F-1", "/ABCDEFGHIJK-1", "/FE-142.md.json"])(
    "%s names none",
    (path) => {
      expect(requestUrlOf(path)).toBeUndefined();
    },
  );
});

describe("the representation a call negotiates", () => {
  it.each([
    [null, "html"],
    ["", "html"],
    [BROWSER, "html"],
    ["text/html", "html"],
    ["*/*", "html"],
    ["text/*", "html"],
    ["image/png", "html"],
    ["text/markdown", "markdown"],
    ["text/markdown, text/html;q=0.9, */*;q=0.1", "markdown"],
    ["text/markdown, */*", "markdown"],
    ["TEXT/Markdown", "markdown"],
    ["application/json", "json"],
    ["application/json, text/plain, */*", "json"],
    ["application/*", "json"],
    ["text/markdown;q=0.5, application/json;q=0.8", "json"],
    ["text/html;q=0, */*", "markdown"],
    ["text/html;q=0, text/markdown;q=0, */*", "json"],
    ["text/markdown;q=2, text/html", "html"],
  ])("Accept: %s gets %s", (accept, representation) => {
    expect(negotiate(accept)).toBe(representation);
  });

  it("gives the suffix's representation whatever the Accept header asks for", () => {
    expect(negotiate(BROWSER, "markdown")).toBe("markdown");
    expect(negotiate("text/markdown", "json")).toBe("json");
  });

  it("decides whether a call to a request URL negotiates HTML, and names no other path", () => {
    expect(requestUrlNegotiatesHtml("/FE-142", "*/*")).toBe(true);
    expect(requestUrlNegotiatesHtml("/FE-142", undefined)).toBe(true);
    expect(requestUrlNegotiatesHtml("/FE-142?x=1", "text/markdown")).toBe(false);
    expect(requestUrlNegotiatesHtml("/FE-142.json", BROWSER)).toBe(false);
    expect(requestUrlNegotiatesHtml("/members", BROWSER)).toBeUndefined();
  });
});

describe("the Vary of a request URL's answers", () => {
  it("adds Accept and Authorization to what it lists, each once", () => {
    expect(withNegotiatedVary(undefined)).toBe("Accept, Authorization");
    expect(withNegotiatedVary("rsc, next-router-state-tree")).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect(withNegotiatedVary(["Accept-Encoding", "accept"])).toBe("Accept-Encoding, accept, Authorization");
    expect(withNegotiatedVary("*")).toBe("*");
  });

  let server: Server;
  let origin: string;

  beforeAll(async () => {
    // Answers as Next.js does for a page: its own Vary, set with setHeader as it renders, or given to writeHead.
    server = createServer((request, response) => {
      varyOnNegotiatedUrls(request, response);
      if (request.url?.includes("writeHead") === true) {
        response.writeHead(200, { Vary: "rsc", "content-type": "text/plain" });
        response.end("page");
        return;
      }
      response.setHeader("Vary", "rsc, next-router-state-tree");
      response.end("page");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function get(path: string, method = "GET"): Promise<IncomingHttpHeaders> {
    const { hostname, port } = new URL(origin);
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ hostname, port, path, method }, (incoming) => {
        incoming.resume();
        incoming.on("end", () => resolve(incoming.headers));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  it("names Accept and Authorization besides what the page set, however it set it", async () => {
    expect((await get("/FE-142"))["vary"]).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect((await get("/FE-142.json?writeHead"))["vary"]).toBe("rsc, Accept, Authorization");
    expect((await get("/FE-142", "HEAD"))["vary"]).toBe("rsc, next-router-state-tree, Accept, Authorization");
  });

  it("leaves every other answer as it is", async () => {
    expect((await get("/members"))["vary"]).toBe("rsc, next-router-state-tree");
    expect((await get("/FE-142", "POST"))["vary"]).toBe("rsc, next-router-state-tree");
  });
});

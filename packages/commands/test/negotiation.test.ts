import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NEGOTIATED_KEY_HEADER,
  negotiate,
  pageRouteNegotiatesHtml,
  negotiatedUrlHeaders,
  negotiatedUrlOf,
  requestUrlNegotiatesHtml,
  requestUrlOf,
  teamUrlOf,
  withNegotiatedVary,
} from "../src/index.ts";

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

  // A letter, a digit, a hyphen or a dot written as its percent-encoding is the same character (RFC 3986, section
  // 6.2.2.2), and Next.js decodes it before it picks the page, so the path is the same request URL.
  it.each([
    ["/%46E-142", { key: "FE-142", suffix: undefined }],
    ["/%46%45%2D%31%34%32", { key: "FE-142", suffix: undefined }],
    ["/FE%2d142.md", { key: "FE-142", suffix: "markdown" }],
    ["/FE-142%2Ejson", { key: "FE-142", suffix: "json" }],
  ])("%s, with percent-encoded letters, digits, hyphens or dots, names the same request", (path, named) => {
    expect(requestUrlOf(path)).toEqual(named);
    expect(negotiatedUrlOf(path)).toEqual({ kind: "request", ...named });
  });

  it.each(["/%66E-142", "/FE%2F142", "/FE-142%20", "/FE-142%2Fx", "/%2FFE-142", "/FE-142%", "/FE-142%zz"])(
    "%s, which decodes to no key or to another path, names none",
    (path) => {
      expect(requestUrlOf(path)).toBeUndefined();
      expect(negotiatedUrlOf(path)).toBeUndefined();
    },
  );
});

// agent-surfaces: Team intake pages.
describe("a team intake page's path", () => {
  it.each([
    ["/FE", { key: "FE", suffix: undefined }],
    ["/FE.md", { key: "FE", suffix: "markdown" }],
    ["/API.json", { key: "API", suffix: "json" }],
    ["/PAY2", { key: "PAY2", suffix: undefined }],
  ])("%s names a team", (path, named) => {
    expect(teamUrlOf(path)).toEqual(named);
    expect(negotiatedUrlOf(path)).toEqual({ kind: "team", ...named });
  });

  it.each(["/api", "/Fe", "/F", "/ABCDEFGHIJK", "/FE-142", "/FE/", "/FE.txt", "/1FE", "/members", "/setup"])("%s names none", (path) => {
    expect(teamUrlOf(path)).toBeUndefined();
  });

  it("names the same team with percent-encoded letters, digits or dots", () => {
    expect(teamUrlOf("/%46E")).toEqual({ key: "FE", suffix: undefined });
    expect(negotiatedUrlOf("/%41PI%2Emd")).toEqual({ kind: "team", key: "API", suffix: "markdown" });
    expect(teamUrlOf("/%61pi")).toBeUndefined();
  });

  it("tells a request URL from an intake page", () => {
    expect(negotiatedUrlOf("/FE-142.md")).toEqual({ kind: "request", key: "FE-142", suffix: "markdown" });
    expect(negotiatedUrlOf("/api/v1/openapi.json")).toBeUndefined();
  });
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
    expect(requestUrlNegotiatesHtml("/%46E-142", BROWSER)).toBe(true);
    expect(requestUrlNegotiatesHtml("/%46E-142%2Emd", BROWSER)).toBe(false);
  });

  it("decides the same for a team's intake page", () => {
    expect(requestUrlNegotiatesHtml("/FE", "*/*")).toBe(true);
    expect(requestUrlNegotiatesHtml("/FE", undefined)).toBe(true);
    expect(requestUrlNegotiatesHtml("/FE", "application/json")).toBe(false);
    expect(requestUrlNegotiatesHtml("/FE.md", BROWSER)).toBe(false);
  });

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (38): a call that carries an
  // Authorization header is a program, such as curl or an agent's fetch tool, which cannot use a sign-in page, so
  // where it would negotiate HTML it gets markdown; HTML goes only to a call without the header.
  it.each([[null], [""], ["*/*"], ["text/html"], [BROWSER], ["image/png"]])("gives a call with an Authorization header and Accept: %s markdown", (accept) => {
    expect(negotiate(accept, undefined, true)).toBe("markdown");
    expect(negotiate(accept, undefined, false)).toBe("html");
  });

  it("keeps what such a call names besides HTML, and its suffix", () => {
    expect(negotiate("application/json", undefined, true)).toBe("json");
    expect(negotiate("text/markdown", undefined, true)).toBe("markdown");
    expect(negotiate(BROWSER, "json", true)).toBe("json");
    expect(negotiate(BROWSER, "markdown", true)).toBe("markdown");
  });

  it("decides that a request URL or an intake page called with an Authorization header negotiates no HTML, and so answers no refusal page", () => {
    for (const path of ["/FE-142", "/FE", "/%46E-142"]) {
      for (const accept of [BROWSER, "*/*", undefined]) {
        expect(requestUrlNegotiatesHtml(path, accept, true), `${path} ${accept}`).toBe(false);
        expect(pageRouteNegotiatesHtml(path, accept, true), `${path} ${accept}`).toBe(false);
      }
    }
    expect(requestUrlNegotiatesHtml("/members", BROWSER, true)).toBeUndefined();
    // Every other page route still answers a browser's refusal with a page, as before.
    expect(pageRouteNegotiatesHtml("/members", BROWSER, true)).toBe(true);
  });
});

// agent-surfaces: Request URL response headers. The web role gives every answer of a request URL or an intake page,
// whatever its method and whatever set its headers, Vary: Accept, Authorization, Cache-Control: private, no-store and
// an ETag, which Next.js may have set otherwise as it rendered the page or answered its server action.
describe("the headers the web role gives a request URL's answers", () => {
  it("adds Accept and Authorization to what it lists, each once", () => {
    expect(withNegotiatedVary(undefined)).toBe("Accept, Authorization");
    expect(withNegotiatedVary("rsc, next-router-state-tree")).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect(withNegotiatedVary(["Accept-Encoding", "accept"])).toBe("Accept-Encoding, accept, Authorization");
    expect(withNegotiatedVary("*")).toBe("*");
  });

  let server: Server;
  let origin: string;

  beforeAll(async () => {
    // Answers as Next.js does for a page: its own Vary, set with setHeader as it renders, or given to writeHead. A
    // path that asks for it carries the header the proxy marks a page it negotiated with, as Next.js passes on the
    // proxy's headers, set with setHeader or given to writeHead.
    // Next.js's own Cache-Control is set or given the same ways, and a path that asks for it has an ETag.
    server = createServer((request, response) => {
      negotiatedUrlHeaders(request, response);
      const marked = request.url?.includes("marked") === true;
      const tagged = request.url?.includes("etag") === true;
      if (request.url?.includes("writeHead") === true) {
        response.writeHead(200, {
          Vary: "rsc",
          "Cache-Control": "no-cache, no-store, max-age=0, must-revalidate",
          "content-type": "text/plain",
          ...(marked ? { [NEGOTIATED_KEY_HEADER]: "FE-142" } : {}),
          ...(tagged ? { ETag: '"given"' } : {}),
        });
        response.end("page");
        return;
      }
      if (marked) response.setHeader(NEGOTIATED_KEY_HEADER, "FE-142");
      if (tagged) response.setHeader("ETag", '"set"');
      response.setHeader("Vary", "rsc, next-router-state-tree");
      response.setHeader("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate");
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
    expect((await get("/FE"))["vary"]).toBe("rsc, next-router-state-tree, Accept, Authorization");
  });

  it("names them on the answer of every method, a form's post to the page included, and on a percent-encoded path", async () => {
    expect((await get("/FE-142", "POST"))["vary"]).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect((await get("/FE-142", "PUT"))["vary"]).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect((await get("/%46E-142"))["vary"]).toBe("rsc, next-router-state-tree, Accept, Authorization");
  });

  it("names them on a page the proxy negotiated at a path Next.js rewrote, and sends its mark to nobody", async () => {
    const set = await get("/FE-142.rsc?marked");
    expect(set["vary"]).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect(set[NEGOTIATED_KEY_HEADER]).toBeUndefined();
    const given = await get("/FE-142.rsc?marked&writeHead");
    expect(given["vary"]).toBe("rsc, Accept, Authorization");
    expect(given[NEGOTIATED_KEY_HEADER]).toBeUndefined();
  });

  it("sets Cache-Control: private, no-store and keeps an ETag the answer has, however it was set", async () => {
    for (const path of ["/FE-142", "/FE-142?writeHead", "/FE", "/FE-142.rsc?marked&writeHead"]) {
      expect((await get(path, "POST"))["cache-control"], path).toBe("private, no-store");
    }
    expect((await get("/FE-142?etag"))["etag"]).toBe('"set"');
    expect((await get("/FE-142?etag&writeHead"))["etag"]).toBe('"given"');
  });

  it("gives an answer without an ETag one of its own, which no other answer shares", async () => {
    const first = (await get("/FE-142", "POST"))["etag"];
    const second = (await get("/FE-142", "POST"))["etag"];
    expect(first).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(second).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(first).not.toBe(second);
    expect((await get("/FE-142.rsc?marked&writeHead"))["etag"]).toMatch(/^W\/"/);
  });

  it("leaves every other answer as it is", async () => {
    for (const answer of [await get("/members"), await get("/members", "POST"), await get("/FE-142.rsc")]) {
      expect(answer["vary"]).toBe("rsc, next-router-state-tree");
      expect(answer["cache-control"]).toBe("private, no-cache, no-store, max-age=0, must-revalidate");
      expect(answer["etag"]).toBeUndefined();
    }
    const given = await get("/members?writeHead");
    expect(given["vary"]).toBe("rsc");
    expect(given["cache-control"]).toBe("no-cache, no-store, max-age=0, must-revalidate");
  });
});

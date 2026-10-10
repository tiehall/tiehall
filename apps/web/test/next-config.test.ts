import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BODY_LIMIT, CONTRACT_REPORT_BODY_LIMIT, GITHUB_WEBHOOK_BODY_LIMIT } from "@tiehall/commands";
import nextConfig from "../next.config.ts";

// The framework's own cap on server-action bodies (public-api: Request bodies
// have a size limit; request-body-limit's design.md, Technical decisions: T2).
// The web role's request guard answers a form body over 2 MiB with the error
// model's 413 before the framework reads it. The framework's cap, 1 MB by
// default and refused with an error of its own shape, is the same 2 MiB, so it
// never refuses a form the guard lets through, and never answers before it.

describe("the framework's cap on server-action bodies", () => {
  it("is 2 MiB, the guard's limit for the web UI's forms", () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe(BODY_LIMIT);
  });
});

// The framework's proxy (proxy.ts) runs on every route and copies each request
// body, cutting it at its own cap, 10 MiB by default. A GitHub delivery may be
// up to 25 MB, and the guard lets through up to 25 MiB on /webhooks/github, so
// the proxy's cap is the same 25 MiB: it never cuts a delivery GitHub may send,
// whose signature would then fail, or a contract.report of up to 16 MiB.
describe("the framework's cap on the bodies its proxy copies", () => {
  it("is 25 MiB, the largest limit the guard applies", () => {
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(GITHUB_WEBHOOK_BODY_LIMIT);
    expect(GITHUB_WEBHOOK_BODY_LIMIT).toBeGreaterThanOrEqual(CONTRACT_REPORT_BODY_LIMIT);
  });
});

// The install's assets are read from packages/commands/assets/ by the asset route at run time (web-ui: The install
// serves its own assets; design.md, Design: The install's assets; D57 (14)), so the standalone output, which the image
// copies, carries the folder for that route.
describe("the files the standalone output carries for the asset route", () => {
  it("are every file of packages/commands/assets/", () => {
    expect(nextConfig.outputFileTracingIncludes).toEqual({ "/assets/**": ["../../packages/commands/assets/**"] });
  });
});

// The favicon (web-ui: The mark, the favicon and the app icon; design.md, Design: The install's assets; D57 (10)).
// Next.js takes a file at app/favicon.ico, or a route under it, for a static metadata file, so the asset route serves
// the icon as /assets/favicon.ico, and /favicon.ico, which browsers ask for by themselves, is rewritten to it.
describe("/favicon.ico", () => {
  it("is rewritten to the asset route, its query kept", async () => {
    expect(await nextConfig.rewrites?.()).toEqual([{ source: "/favicon.ico", destination: "/assets/favicon.ico" }]);
  });

  it("has no file or route of its own under app/, which Next.js would take for a static metadata file", () => {
    expect(existsSync(new URL("../app/favicon.ico", import.meta.url))).toBe(false);
  });
});

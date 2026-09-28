import { describe, expect, it } from "vitest";
import { BODY_LIMIT } from "@tiehall/commands";
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

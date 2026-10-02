import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cliStandIn, oidcTokenFor, TOKEN_SERVICE, type CliCall } from "./support/cli.ts";
import { runActionWith } from "./support/runner.ts";

// The Action reports to the install its workflow names (contract-changes: The
// Action reports to the install its workflow names; contract-changes: The
// contract Action; agent-access: CI authenticates with GitHub Actions OIDC
// bound to registered repositories; design.md, Self-hosting decisions: S9,
// S15). The workflow gives the install's URL as the install-url input; the
// pinned CLI asks GitHub Actions for the run's OIDC token with that URL as
// its audience, and sends the report there and nowhere else. Here the CLI of
// this repository runs in the test's process as the pinned CLI, with a fetch
// that plays the token service and the install and records every call.

const scratch = mkdtempSync(join(tmpdir(), "tiehall-contract-install-url-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The calls that went somewhere other than the token service and the given install. */
const elsewhere = (calls: readonly CliCall[], install: string) =>
  calls.filter(({ url }) => !url.startsWith(TOKEN_SERVICE.split("?")[0] ?? "") && new URL(url).origin !== install);

describe("the install-url input", () => {
  it.each(["https://tiehall.example.com", "https://tiehall.internal.acme.example:8443"])(
    "%s gets the report, with a token whose audience is that URL, and nothing else gets anything",
    async (install) => {
      const calls: CliCall[] = [];
      const run = await runActionWith(scratch, { inputs: { "install-url": install }, npx: cliStandIn(calls) });

      expect(run.code).toBe(0);
      const [token, report, ...more] = calls;
      expect(more).toEqual([]);
      expect(new URL(token?.url ?? "").searchParams.get("audience")).toBe(install);
      expect(report?.url).toBe(`${install}/api/v1/contract-reports`);
      expect(report?.method).toBe("POST");
      expect(report?.headers["authorization"]).toBe(`Bearer ${oidcTokenFor(install)}`);
      expect(elsewhere(calls, install)).toEqual([]);
      expect(run.fetched.every((url) => url.startsWith("https://github.com/oasdiff/oasdiff/releases/download/"))).toBe(true);
    },
  );

  it("is taken by its origin, so a trailing slash changes nothing", async () => {
    const calls: CliCall[] = [];
    const run = await runActionWith(scratch, { inputs: { "install-url": "https://tiehall.example.com/" }, npx: cliStandIn(calls) });
    expect(run.code).toBe(0);
    expect(calls.map(({ url }) => url)).toContain("https://tiehall.example.com/api/v1/contract-reports");
  });

  it.each([
    ["an http URL on another host than localhost", "http://tiehall.example.com"],
    ["a URL with a path", "https://tiehall.example.com/api"],
    ["a URL with credentials", "https://ci:secret@tiehall.example.com"],
    ["no URL", "not a url"],
  ])("refuses %s before it downloads or reports anything", async (_case, install) => {
    const calls: CliCall[] = [];
    const run = await runActionWith(scratch, { inputs: { "install-url": install }, npx: cliStandIn(calls) });
    expect(run.code).toBe(1);
    expect(run.fetched).toEqual([]);
    expect(run.reports).toEqual([]);
    expect(calls).toEqual([]);
    expect(run.stdout).toMatch(/^::error title=Input not valid::The input install-url/m);
    expect(run.stdout).not.toContain("secret");
  });

  it("takes http://localhost, with or without a port, for a trial install on the runner's machine", async () => {
    const calls: CliCall[] = [];
    const run = await runActionWith(scratch, { inputs: { "install-url": "http://localhost:3000" }, npx: cliStandIn(calls) });
    expect(run.code).toBe(0);
    expect(calls.at(-1)?.url).toBe("http://localhost:3000/api/v1/contract-reports");
  });
});

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { compareDocuments, DEPRECATION_DAYS, type CompatResult } from "../src/api-compat.ts";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { checkArchive, oasdiff, OASDIFF_VERSION } from "../src/oasdiff.ts";

// Notice before a breaking change, enforced in CI (public-api: Notice before a
// breaking change is enforced in CI; public-api: The API version number while
// the API is beta; public-api: Responses can gain fields without breaking
// clients; design.md, Technical decisions: T12). The pinned, checksum-verified
// oasdiff compares openapi/v1.json at a pull request's merge base with the
// pull request's, and fails on an error-level breaking change to a beta or
// stable operation: a sunset closer than 14 days for beta and 180 for stable,
// a removal before the sunset, any other breaking change, and a breaking
// change that leaves info.version as it was. alpha operations are not held to
// notice, and adding an optional response field is not breaking.
//
// The fixture pairs name their sunset dates relative to the day the test runs,
// as TODAY+N or TODAY-N, because oasdiff measures the notice from today.

/** A fixture pair, with its sunset dates made relative to today. */
function pair(name: string): [string, string] {
  const read = (file: string) =>
    readFileSync(new URL(`fixtures/api-compat/${name}/${file}`, import.meta.url), "utf8").replace(/"TODAY([+-]\d+)"/g, (_, days: string) => {
      const day = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);
      return JSON.stringify(day.toISOString().slice(0, 10));
    });
  return [read("base.json"), read("revision.json")];
}

async function compare(name: string): Promise<CompatResult> {
  const [base, revision] = pair(name);
  return compareDocuments(base, revision);
}

const ids = (result: CompatResult) => result.errors.map(({ id }) => id).sort();

beforeAll(async () => {
  // Downloads and verifies the pinned oasdiff once, when the cache does not hold it yet.
  await oasdiff();
}, 120_000);

describe("the pinned oasdiff", () => {
  it("is the pinned release", async () => {
    expect(spawnSync(await oasdiff(), ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(`oasdiff version ${OASDIFF_VERSION}`);
  });

  it("refuses an archive whose SHA-256 is not the pinned one", () => {
    const archive = Buffer.from("not the release archive");
    const pinned = createHash("sha256").update(archive).digest("hex");
    expect(() => checkArchive("oasdiff.tar.gz", archive, pinned)).not.toThrow();
    expect(() => checkArchive("oasdiff.tar.gz", Buffer.from("a tampered archive"), pinned)).toThrow("nothing from it was run");
  });
});

describe("the compatibility check", () => {
  it("gives a beta operation 14 days of notice and a stable one 180", () => {
    expect(DEPRECATION_DAYS).toEqual({ beta: 14, stable: 180 });
  });

  it("fails a 10-day sunset on a beta operation", async () => {
    const result = await compare("beta-sunset-10-days");
    expect(result.passed).toBe(false);
    expect(ids(result)).toContain("api-sunset-date-too-small");
  });

  it("passes a 20-day sunset on a beta operation", async () => {
    const result = await compare("beta-sunset-20-days");
    expect(result).toEqual({ passed: true, errors: [] });
  });

  it("fails a removal before the sunset", async () => {
    const result = await compare("beta-removed-before-sunset");
    expect(result.passed).toBe(false);
    expect(ids(result).some((id) => /removed-before-sunset$/.test(id))).toBe(true);
  });

  it("fails a 30-day sunset on a stable operation", async () => {
    const result = await compare("stable-sunset-30-days");
    expect(result.passed).toBe(false);
    expect(ids(result)).toContain("api-sunset-date-too-small");
  });

  it("passes a 200-day sunset on a stable operation", async () => {
    expect(await compare("stable-sunset-200-days")).toEqual({ passed: true, errors: [] });
  });

  it("passes a removal after the sunset", async () => {
    expect(await compare("beta-removed-after-sunset")).toEqual({ passed: true, errors: [] });
  });

  it("passes a breaking change to an alpha operation", async () => {
    expect(await compare("alpha-breaking-change")).toEqual({ passed: true, errors: [] });
  });

  it("fails a breaking change that leaves info.version as it was, for the version too", async () => {
    const result = await compare("breaking-without-version-bump");
    expect(result.passed).toBe(false);
    expect(ids(result)).toEqual(["api-version-not-bumped", "response-property-became-optional"]);
  });

  it("still fails a breaking change without notice when info.version was bumped, but not for the version", async () => {
    const result = await compare("breaking-with-version-bump");
    expect(result.passed).toBe(false);
    expect(ids(result)).toEqual(["response-property-became-optional"]);
  });

  it("passes a new optional response field", async () => {
    expect(await compare("new-optional-response-field")).toEqual({ passed: true, errors: [] });
  });

  it("passes the committed document compared with itself", async () => {
    const committed = readFileSync(new URL("../../../openapi/v1.json", import.meta.url), "utf8");
    expect(await compareDocuments(committed, committed)).toEqual({ passed: true, errors: [] });
  });
});

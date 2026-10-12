import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { checkPullRequest, parseLabels, type PullRequestResult } from "../src/api-compat.ts";
import { oasdiff } from "../src/oasdiff.ts";

// The `api-breaking` label (public-api: The `api-breaking` label for urgent
// security fixes; public-api: The API version number while the API is beta;
// design.md, Design rules: Public API). A breaking change to a beta or stable
// operation before its notice has run is allowed only for an urgent security
// fix, and, before Tiehall's first release, for a break of a beta operation
// that an OpenSpec change the maintainers approved names
// (decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (47)): the pull request carries the api-breaking label, adds a changelog
// entry of kind "breaking" to openapi/changelog.json and bumps info.version.
// Without all three the compatibility check fails as it does on any breaking
// change. Which of the two cases a labelled pull request is, its review
// decides.
//
// Each fixture pull request names its labels and a document pair of the
// api-compat fixtures, and holds openapi/changelog.json at its merge base and
// in the pull request.

async function check(name: string): Promise<PullRequestResult> {
  const read = (file: string) => readFileSync(new URL(`fixtures/api-breaking/${name}/${file}`, import.meta.url), "utf8");
  const { labels, documents } = JSON.parse(read("pull-request.json")) as { labels: string[]; documents: string };
  const document = (file: string) =>
    readFileSync(new URL(`fixtures/api-compat/${documents}/${file}`, import.meta.url), "utf8").replace(/"TODAY([+-]\d+)"/g, (_, days: string) =>
      JSON.stringify(new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)),
    );
  return checkPullRequest({
    base: document("base.json"),
    revision: document("revision.json"),
    labels,
    changelogBase: read("changelog-base.json"),
    changelogRevision: read("changelog-revision.json"),
  });
}

beforeAll(async () => {
  await oasdiff();
}, 120_000);

describe("a pull request with the api-breaking label", () => {
  it("passes a breaking change when it adds a breaking changelog entry and bumps info.version", async () => {
    const result = await check("labelled-with-both");
    expect(result.passed).toBe(true);
    expect(result.labelled).toBe(true);
    expect(result.problems).toEqual([]);
    // The breaking change is still reported, as allowed by the label.
    expect(result.errors.map(({ id }) => id)).toEqual(["response-property-became-optional"]);
  });

  it("fails without a changelog entry", async () => {
    const result = await check("labelled-without-changelog-entry");
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("adds no changelog entry of kind breaking to openapi/changelog.json")]);
  });

  it("fails without an info.version bump", async () => {
    const result = await check("labelled-without-version-bump");
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("leaves info.version at 0.3.0")]);
  });

  it("fails when the entry it adds is not a breaking one", async () => {
    const result = await check("labelled-with-a-note-only");
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("adds no changelog entry of kind breaking")]);
  });

  it("fails when the breaking entry was already at the merge base", async () => {
    const result = await check("labelled-with-an-entry-already-at-the-base");
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("adds no changelog entry of kind breaking")]);
  });

  it("lets a removal before the sunset through with both", async () => {
    const result = await check("labelled-removal-before-sunset");
    expect(result.passed).toBe(true);
    expect(result.errors.some(({ id }) => /removed-before-sunset$/.test(id))).toBe(true);
  });

  // D55 (47): before the first release, the wait entries' request_key and team_key become requestKey and teamKey,
  // a break of a beta operation that this change names, on the label's path.
  it("passes the rename of the wait entries' fields before the first release, with a breaking entry and the version bumped", async () => {
    const result = await check("labelled-rename-before-first-release");
    expect(result).toMatchObject({ passed: true, labelled: true, problems: [] });
    expect(result.errors.map(({ id }) => id)).toContain("response-required-property-removed");
    expect((await check("labelled-rename-before-first-release")).errors.every(({ operationId }) => operationId === "events.wait")).toBe(true);
  });

  it("passes a pull request without a breaking change, with nothing to allow", async () => {
    expect(await check("labelled-without-breaking-change")).toEqual({ passed: true, labelled: true, errors: [], problems: [] });
  });
});

describe("a pull request without the label", () => {
  it("fails a breaking change even with a changelog entry and a version bump", async () => {
    const result = await check("unlabelled-with-both");
    expect(result.passed).toBe(false);
    expect(result.labelled).toBe(false);
    expect(result.errors.map(({ id }) => id)).toEqual(["response-property-became-optional"]);
  });
});

describe("the changelog in a pull request", () => {
  it("fails the check when it does not parse, label or not", async () => {
    const [base, revision] = ["base.json", "revision.json"].map((file) =>
      readFileSync(new URL(`fixtures/api-compat/new-optional-response-field/${file}`, import.meta.url), "utf8"),
    ) as [string, string];
    const result = await checkPullRequest({ base, revision, labels: [], changelogRevision: '{ "unreleased": [{ "kind": "breaking" }] }' });
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("openapi/changelog.json does not parse")]);
  });

  it("may be missing at the merge base", async () => {
    const [base, revision] = ["base.json", "revision.json"].map((file) =>
      readFileSync(new URL(`fixtures/api-compat/breaking-with-version-bump/${file}`, import.meta.url), "utf8"),
    ) as [string, string];
    const changelogRevision = readFileSync(new URL("fixtures/api-breaking/labelled-with-both/changelog-revision.json", import.meta.url), "utf8");
    expect((await checkPullRequest({ base, revision, labels: ["api-breaking"], changelogRevision })).passed).toBe(true);
  });
});

describe("the labels CI passes", () => {
  it("are the JSON list of label names that GitHub Actions gives", () => {
    expect(parseLabels('["security","api-breaking"]')).toEqual(["security", "api-breaking"]);
    expect(parseLabels("[]")).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
    expect(() => parseLabels('{"name":"api-breaking"}')).toThrow("PR_LABELS is a JSON list");
  });
});

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseChangelog } from "@tiehall/catalog/changelog";
import { apiChanges, EMPTY_DOCUMENT, recordRelease, releaseNotes } from "../src/api-changelog.ts";
import { oasdiff } from "../src/oasdiff.ts";

// The API changelog of each release (public-api: The changelog page and the
// release notes; design.md, Technical decisions: T12). When a release is
// made, the pinned oasdiff's changelog of openapi/v1.json, from the previous
// release's document to this one's, is recorded in openapi/changelog.json
// with the maintainers' unreleased entries; the changelog page of every
// install that runs the release shows the record, and the release notes carry
// the same entries.
//
// The fixture release 1.4.0 deprecates requests.list with a sunset date and
// adds an optional field to a response of requests.get.

const fixture = (file: string) => readFileSync(new URL(`fixtures/api-changelog/${file}`, import.meta.url), "utf8");

beforeAll(async () => {
  await oasdiff();
}, 120_000);

describe("recording a release", () => {
  it("records oasdiff's changelog from the previous release's document and moves the unreleased entries into it", async () => {
    const { changelog } = await recordRelease({
      changelog: fixture("changelog-before.json"),
      version: "1.4.0",
      date: "2026-12-01",
      previousDocument: fixture("base.json"),
      document: fixture("revision.json"),
    });
    expect(changelog).toBe(fixture("changelog-after.json"));
  });

  it("compares the first release with an empty document, so every operation it has is listed as added", async () => {
    const changes = await apiChanges(EMPTY_DOCUMENT, fixture("base.json"));
    expect(changes.filter(({ operationId }) => operationId !== undefined).map(({ id, operationId }) => `${id} ${operationId}`).sort()).toEqual([
      "endpoint-added requests.get",
      "endpoint-added requests.list",
    ]);
  });

  it("refuses a version already recorded, a day that is not a calendar day, and a changelog that does not parse", async () => {
    const release = { version: "1.3.0", date: "2026-12-01", previousDocument: fixture("base.json"), document: fixture("revision.json") };
    await expect(recordRelease({ ...release, changelog: fixture("changelog-before.json") })).rejects.toThrow("1.3.0 is already recorded");
    await expect(recordRelease({ ...release, version: "1.4.0", date: "1 Dec", changelog: fixture("changelog-before.json") })).rejects.toThrow(
      "calendar day",
    );
    await expect(recordRelease({ ...release, version: "1.4.0", changelog: "{}" })).rejects.toThrow("unreleased is a list");
  });
});

describe("the release notes", () => {
  const release = parseChangelog(fixture("changelog-after.json")).releases[0];

  it("carry the release's deprecation with its sunset date and its new optional field", () => {
    const notes = releaseNotes(release!);
    expect(notes).toContain("## API changes");
    expect(notes).toContain("- `GET /api/v1/requests` (requests.list): endpoint deprecated with sunset date `2026-12-15` (stability: beta)");
    expect(notes).toContain("- `GET /api/v1/requests/{key}` (requests.get): added the optional property `title` to the response with the `200` status");
    expect(notes).toContain("- Note (requests.list): requests.list is deprecated: read a team's requests with its search operation instead.");
    expect(notes).toContain("/docs/api/changelog");
  });

  it("say so when a release changes nothing in the API", () => {
    expect(releaseNotes({ version: "1.4.1", date: "2026-12-02", apiVersion: "0.3.0", entries: [], changes: [] })).toContain(
      "No change to the API.",
    );
  });
});

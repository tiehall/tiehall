import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_CHANGELOG } from "../src/api-changelog.ts";
import {
  addedEntries,
  API_BREAKING_LABEL,
  ChangelogError,
  parseChangelog,
  releaseItems,
  type ChangelogRelease,
} from "../src/changelog.ts";
import { committedChangelogPath } from "../src/committed-files.ts";

// The API changelog (public-api: The `api-breaking` label for urgent security
// fixes; public-api: The changelog page and the release notes). The
// maintainers' dated entries live in openapi/changelog.json, where a pull
// request adds the entry that announces a change, such as the breaking change
// of an urgent security fix, before a release carries it.

const breaking = { date: "2026-09-26", kind: "breaking" as const, text: "requests.get no longer returns the requester's email.", operationIds: ["requests.get"] };
const note = { date: "2026-09-20", kind: "note", text: "The API reference page is at /docs/api." };
const deprecation = {
  id: "endpoint-deprecated-with-sunset",
  level: 1 as const,
  method: "GET",
  path: "/api/v1/requests",
  operationId: "requests.list",
  text: "endpoint deprecated with sunset date `2026-12-15` (stability: beta)",
};
const removal = { id: "api-removed-without-deprecation", level: 3 as const, method: "GET", path: "/api/v1/drafts", operationId: "drafts.get", text: "api removed without deprecation" };
const release: ChangelogRelease = { version: "1.4.0", date: "2026-12-01", apiVersion: "0.4.0", entries: [breaking], changes: [deprecation, removal] };

function changelog(unreleased: unknown[], releases: unknown[] = []): string {
  return JSON.stringify({ unreleased, releases });
}

describe("the changelog file", () => {
  it("is committed as openapi/changelog.json, and parses", () => {
    expect(committedChangelogPath().endsWith("openapi/changelog.json")).toBe(true);
    expect(() => parseChangelog(readFileSync(committedChangelogPath(), "utf8"))).not.toThrow();
  });

  it("is what the catalog package carries for the changelog page", () => {
    expect(API_CHANGELOG).toEqual(parseChangelog(readFileSync(committedChangelogPath(), "utf8")));
  });

  it("names the label a pull request carries for an urgent security fix", () => {
    expect(API_BREAKING_LABEL).toBe("api-breaking");
  });

  it("parses dated entries of a known kind", () => {
    expect(parseChangelog(changelog([breaking, note])).unreleased).toEqual([breaking, note]);
  });

  it("refuses a file that is not a changelog, naming every problem", () => {
    expect(() => parseChangelog("not json")).toThrow(ChangelogError);
    expect(() => parseChangelog(JSON.stringify({ unreleased: [] }))).toThrow("releases is a list");
    const problems = (() => {
      try {
        parseChangelog(
          changelog([
            { ...breaking, date: "2026-02-30" },
            { ...breaking, kind: "rumour" },
            { ...breaking, text: " " },
            { ...breaking, operationIds: ["Requests Get"] },
            { ...breaking, extra: true },
          ]),
        );
      } catch (error) {
        return (error as Error).message.split("\n");
      }
      return [];
    })();
    expect(problems).toEqual([
      "unreleased[0]: date is a calendar day, such as 2026-12-15.",
      "unreleased[1]: kind is one of breaking, note, graduation.",
      "unreleased[2]: text says what changed.",
      "unreleased[3]: operationIds lists operation ids, such as requests.get.",
      "unreleased[4]: extra is not a field of an entry.",
    ]);
  });
});

// The maintainers' decision to graduate an operation to stable (public-api:
// Each operation graduates on its own): an entry of kind graduation, dated the
// day they decided, names each operation it graduates, and the graduation
// check (tools/repo-checks/src/graduation.ts) reads it.
describe("a graduation entry", () => {
  const graduation = {
    date: "2026-11-02",
    kind: "graduation" as const,
    text: "requests.get is stable: no breaking change to it was needed for four weeks, and the maintainers have decided to graduate it.",
    operationIds: ["requests.get"],
  };

  it("parses, naming the operations it graduates", () => {
    expect(parseChangelog(changelog([graduation])).unreleased).toEqual([graduation]);
    expect(parseChangelog(changelog([], [{ ...release, entries: [graduation] }])).releases[0]?.entries).toEqual([graduation]);
  });

  it("is refused when it names no operation, or names a schema, since only an operation graduates", () => {
    const { operationIds: _ids, ...unnamed } = graduation;
    const problems = (() => {
      try {
        parseChangelog(changelog([unnamed, { ...graduation, operationIds: [] }, { ...graduation, schemas: ["packet"] }]));
      } catch (error) {
        return (error as Error).message.split("\n");
      }
      return [];
    })();
    expect(problems).toEqual([
      "unreleased[0]: a graduation names the operations it graduates in operationIds.",
      "unreleased[1]: a graduation names the operations it graduates in operationIds.",
      "unreleased[2]: a graduation is about operations, so it names no schemas.",
    ]);
  });

  it("is shown with what it is about, like any other entry", () => {
    expect(releaseItems({ entries: [graduation], changes: [] })).toEqual([{ kind: "graduation", operationIds: ["requests.get"], text: graduation.text }]);
  });
});

describe("a release in the changelog", () => {
  it("holds its version, its day, the API's version, the maintainers' entries and the changes the compatibility checker found", () => {
    expect(parseChangelog(changelog([], [release])).releases).toEqual([release]);
  });

  it("is refused when a field is missing or malformed, naming each problem", () => {
    const problems = (() => {
      try {
        parseChangelog(
          changelog(
            [],
            [
              { ...release, version: "v1.4" },
              { ...release, date: "soon", apiVersion: 4 },
              { ...release, entries: [{ ...breaking, kind: "rumour" }], changes: [{ ...deprecation, level: 7 }] },
              { ...release, changes: [{ ...deprecation, text: "" }] },
            ],
          ),
        );
      } catch (error) {
        return (error as Error).message.split("\n");
      }
      return [];
    })();
    expect(problems).toEqual([
      "releases[0]: version is a release version, such as 1.4.0.",
      "releases[1]: date is a calendar day, such as 2026-12-15.",
      "releases[1]: apiVersion is the document's info.version, such as 0.4.0.",
      "releases[2].entries[0]: kind is one of breaking, note, graduation.",
      "releases[2].changes[0]: level is 1 (information), 2 (warning) or 3 (error).",
      "releases[3].changes[0]: text says what changed.",
    ]);
  });

  it("shows the maintainers' entries first and then each change, with what it is about", () => {
    // The changes most severe first, each kind in the order the checker gave.
    expect(releaseItems(release)).toEqual([
      { kind: "breaking", operationIds: ["requests.get"], text: "requests.get no longer returns the requester's email." },
      { kind: "error", method: "GET", path: "/api/v1/drafts", operationIds: ["drafts.get"], text: "api removed without deprecation" },
      {
        kind: "info",
        method: "GET",
        path: "/api/v1/requests",
        operationIds: ["requests.list"],
        text: "endpoint deprecated with sunset date `2026-12-15` (stability: beta)",
      },
    ]);
  });
});

describe("the entries a pull request adds", () => {
  it("are the unreleased entries the base did not hold", () => {
    const base = parseChangelog(changelog([note]));
    expect(addedEntries(base, parseChangelog(changelog([breaking, note])))).toEqual([breaking]);
    expect(addedEntries(base, base)).toEqual([]);
  });

  it("count an edited entry as added, and everything when the base had no changelog", () => {
    const base = parseChangelog(changelog([breaking]));
    const edited = { ...breaking, text: "requests.get no longer returns email addresses." };
    expect(addedEntries(base, parseChangelog(changelog([edited])))).toEqual([edited]);
    expect(addedEntries(undefined, base)).toEqual([breaking]);
  });
});

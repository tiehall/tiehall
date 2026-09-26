import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addedEntries, API_BREAKING_LABEL, ChangelogError, COMMITTED_CHANGELOG, parseChangelog } from "../src/changelog.ts";

// The API changelog (public-api: The `api-breaking` label for urgent security
// fixes; public-api: The changelog page and the release notes). The
// maintainers' dated entries live in openapi/changelog.json, where a pull
// request adds the entry that announces a change, such as the breaking change
// of an urgent security fix, before a release carries it.

const breaking = { date: "2026-09-26", kind: "breaking", text: "requests.get no longer returns the requester's email.", operationIds: ["requests.get"] };
const note = { date: "2026-09-20", kind: "note", text: "The API reference page is at /docs/api." };

function changelog(unreleased: unknown[], releases: unknown[] = []): string {
  return JSON.stringify({ unreleased, releases });
}

describe("the changelog file", () => {
  it("is committed as openapi/changelog.json, and parses", () => {
    expect(COMMITTED_CHANGELOG.endsWith("openapi/changelog.json")).toBe(true);
    expect(() => parseChangelog(readFileSync(COMMITTED_CHANGELOG, "utf8"))).not.toThrow();
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
      "unreleased[1]: kind is one of breaking, note.",
      "unreleased[2]: text says what changed.",
      "unreleased[3]: operationIds lists operation ids, such as requests.get.",
      "unreleased[4]: extra is not a field of an entry.",
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

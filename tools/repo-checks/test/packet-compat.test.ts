import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChangelog } from "@tiehall/catalog/changelog";
import { checkPacketPullRequest, PACKET_NOTICE_DAYS, packetNoticeProblems, type PacketPullRequest } from "../src/packet-compat.ts";

// Breaking packet changes before publication (handoff-packet: Breaking packet
// changes before publication; design.md, Design rules: Handoff packet;
// design.md, Readings to confirm with the founder: R22). Every conformance
// fixture that validated keeps validating, and a valid fixture changes only
// with a breaking change announced the way the spec says: a pull request that
// breaks either carries the api-breaking label and adds a changelog entry of
// kind breaking about the packet, dated no earlier than the day the check
// runs, and no release contains the change until 14 days after that date.
//
// Each fixture pull request below starts from the committed packet schema and
// the committed valid fixtures, as a pull request against main would.

const SCHEMA = readFileSync(new URL("../../../packages/packet/schema/v1-beta.json", import.meta.url), "utf8");
const VALID_FOLDER = new URL("../../../packages/packet/fixtures/valid/", import.meta.url);
const VALID: Record<string, string> = Object.fromEntries(
  readdirSync(VALID_FOLDER)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [`valid/${name}`, readFileSync(new URL(name, VALID_FOLDER), "utf8")]),
);
const TODAY = "2026-11-02";
const EMPTY_CHANGELOG = `${JSON.stringify({ unreleased: [], releases: [] }, null, 2)}\n`;

/** The committed schema with acceptance criteria required in every packet: a breaking change. */
function requiringAcceptanceCriteria(): string {
  const schema = JSON.parse(SCHEMA) as { oneOf: { properties: { untrusted: { required: string[] } } }[] };
  for (const variant of schema.oneOf) variant.properties.untrusted.required.push("acceptance_criteria");
  return JSON.stringify(schema);
}

/** The committed schema with a new optional field: not a breaking change. */
function withOptionalField(): string {
  const schema = JSON.parse(SCHEMA) as { oneOf: { properties: { untrusted: { properties: Record<string, unknown> } } }[] };
  for (const variant of schema.oneOf) variant.properties.untrusted.properties["estimate"] = { type: "string", "x-tiehall-untrusted": true };
  return JSON.stringify(schema);
}

/** A changelog whose unreleased entries are these. */
function changelogWith(...entries: Record<string, unknown>[]): string {
  return `${JSON.stringify({ unreleased: entries, releases: [] }, null, 2)}\n`;
}

const NOTICE = { date: TODAY, kind: "breaking", schemas: ["packet"], text: "Every packet names its acceptance criteria." };

/** A fixture pull request: the committed schema and fixtures at its merge base, changed as given. */
function pullRequest(change: Partial<PacketPullRequest> = {}): PacketPullRequest {
  return {
    fixturesEver: Object.entries(VALID).map(([name, text]) => ({ name, text })),
    validBase: VALID,
    validRevision: VALID,
    schemaBase: SCHEMA,
    schemaRevision: SCHEMA,
    labels: [],
    changelogBase: EMPTY_CHANGELOG,
    changelogRevision: EMPTY_CHANGELOG,
    today: TODAY,
    ...change,
  };
}

describe("the two fixture pull requests", () => {
  it("fail a breaking schema change without the label, naming each fixture it breaks", () => {
    const result = checkPacketPullRequest(pullRequest({ schemaRevision: requiringAcceptanceCriteria() }));
    expect(result.passed).toBe(false);
    expect(result.labelled).toBe(false);
    expect(result.breaks).toEqual(
      expect.arrayContaining([
        "valid/minimal-request-packet.json validated against the packet schema at the merge base and fails against the pull request's.",
        "valid/extensions.json validated against the packet schema at the merge base and fails against the pull request's.",
      ]),
    );
    expect(result.breaks).not.toContain("valid/request-packet.json validated against the packet schema at the merge base and fails against the pull request's.");
    expect(result.problems).toEqual([expect.stringContaining("carries no api-breaking label")]);
  });

  it("pass the same change with the label, a changelog entry about the packet and its notice date", () => {
    const result = checkPacketPullRequest(
      pullRequest({ schemaRevision: requiringAcceptanceCriteria(), labels: ["api-breaking"], changelogRevision: changelogWith(NOTICE) }),
    );
    expect(result).toMatchObject({ passed: true, labelled: true, problems: [] });
    expect(result.breaks.length).toBeGreaterThan(0);
  });
});

describe("a breaking packet change with the label", () => {
  const breaking = { schemaRevision: requiringAcceptanceCriteria(), labels: ["api-breaking"] };

  it("fails without a changelog entry of kind breaking about the packet", () => {
    for (const changelogRevision of [
      EMPTY_CHANGELOG,
      changelogWith({ ...NOTICE, kind: "note" }),
      changelogWith({ date: TODAY, kind: "breaking", text: "An API change.", operationIds: ["requests.get"] }),
    ]) {
      const result = checkPacketPullRequest(pullRequest({ ...breaking, changelogRevision }));
      expect(result.passed).toBe(false);
      expect(result.problems).toEqual([expect.stringContaining("adds no changelog entry of kind breaking about the packet")]);
    }
  });

  it("fails with an entry the merge base already had, which announces nothing new", () => {
    const result = checkPacketPullRequest(pullRequest({ ...breaking, changelogBase: changelogWith(NOTICE), changelogRevision: changelogWith(NOTICE) }));
    expect(result.passed).toBe(false);
  });

  it("fails with an entry dated before the day the check runs, which would shorten the notice", () => {
    const result = checkPacketPullRequest(pullRequest({ ...breaking, changelogRevision: changelogWith({ ...NOTICE, date: "2026-10-19" }) }));
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("dated 2026-10-19, before 2026-11-02")]);
  });

  it("fails with a changelog that does not parse, label or not", () => {
    const result = checkPacketPullRequest(pullRequest({ changelogRevision: "{" }));
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("openapi/changelog.json does not parse")]);
  });
});

describe("the fixtures that ever validated", () => {
  it("pass a schema change that only adds an optional field, without the label", () => {
    expect(checkPacketPullRequest(pullRequest({ schemaRevision: withOptionalField() }))).toEqual({ passed: true, labelled: false, breaks: [], problems: [] });
  });

  it("include every earlier version of a valid fixture, named by the commit that had it", () => {
    const earlier = { name: "valid/minimal-request-packet.json", text: '{"schema_version":"1-beta","kind":"request","untrusted":{"need":"Older wording."}}', commit: "0123456789abcdef" };
    const result = checkPacketPullRequest(pullRequest({ fixturesEver: [earlier], validBase: {}, validRevision: {}, schemaRevision: requiringAcceptanceCriteria() }));
    expect(result.breaks).toEqual([
      "valid/minimal-request-packet.json as of 0123456789ab validated against the packet schema at the merge base and fails against the pull request's.",
    ]);
  });

  it("leave out a version an earlier announced change already broke, which no longer validates at the merge base", () => {
    const broken = { name: "valid/old.json", text: '{"schema_version":"0-alpha","untrusted":{"need":"From before."}}', commit: "fedcba9876543210" };
    expect(checkPacketPullRequest(pullRequest({ fixturesEver: [broken] })).passed).toBe(true);
  });

  it("need nothing to compare while the merge base has no schema", () => {
    const { schemaBase: _none, ...withoutBase } = pullRequest({ schemaRevision: requiringAcceptanceCriteria() });
    expect(checkPacketPullRequest(withoutBase).passed).toBe(true);
  });
});

describe("a valid fixture", () => {
  it("fails the check when it changes or is removed without the label", () => {
    const changed = { ...VALID, "valid/request-packet.json": VALID["valid/request-packet.json"]?.replace("dark mode", "night mode") ?? "" };
    const { "valid/extensions.json": _removed, ...removed } = VALID;
    for (const validRevision of [changed, removed]) {
      const result = checkPacketPullRequest(pullRequest({ validRevision }));
      expect(result.passed).toBe(false);
    }
    expect(checkPacketPullRequest(pullRequest({ validRevision: changed })).breaks).toEqual(["valid/request-packet.json changes."]);
    expect(checkPacketPullRequest(pullRequest({ validRevision: removed })).breaks).toEqual(["valid/extensions.json is removed."]);
  });

  it("passes a change with the label and the changelog entry, and a new one or a new layout without either", () => {
    const changed = { ...VALID, "valid/request-packet.json": VALID["valid/request-packet.json"]?.replace("dark mode", "night mode") ?? "" };
    expect(checkPacketPullRequest(pullRequest({ validRevision: changed, labels: ["api-breaking"], changelogRevision: changelogWith(NOTICE) })).passed).toBe(true);
    const added = { ...VALID, "valid/new.json": '{"schema_version":"1-beta","kind":"request","untrusted":{"need":"New."}}' };
    expect(checkPacketPullRequest(pullRequest({ validRevision: added })).passed).toBe(true);
    const reformatted = Object.fromEntries(Object.entries(VALID).map(([name, text]) => [name, JSON.stringify(JSON.parse(text))]));
    expect(checkPacketPullRequest(pullRequest({ validRevision: reformatted })).passed).toBe(true);
  });
});

describe("a release that contains a breaking packet change", () => {
  const changelog = parseChangelog(changelogWith(NOTICE));

  it("waits 14 days from the change's notice", () => {
    expect(PACKET_NOTICE_DAYS).toBe(14);
    expect(packetNoticeProblems(changelog.unreleased, "2026-11-15")).toEqual([
      "The breaking packet change announced on 2026-11-02 may be released from 2026-11-16 on, not on 2026-11-15.",
    ]);
    expect(packetNoticeProblems(changelog.unreleased, "2026-11-16")).toEqual([]);
  });

  it("is not held back by other entries", () => {
    expect(packetNoticeProblems(parseChangelog(changelogWith({ ...NOTICE, schemas: undefined, operationIds: ["requests.get"] })).unreleased, "2026-11-03")).toEqual([]);
    expect(packetNoticeProblems(parseChangelog(changelogWith({ ...NOTICE, kind: "note" })).unreleased, "2026-11-03")).toEqual([]);
  });
});

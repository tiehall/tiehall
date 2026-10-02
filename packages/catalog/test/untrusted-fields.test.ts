import { EVENT_FIELD_NAME, EVENT_STRING_VALUE, EVENT_TYPE_NAME, REQUEST_KEY, SEMANTIC_VERSION, TEAM_KEY } from "@tiehall/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog } from "../src/catalog.ts";
import { defineCommand } from "../src/command.ts";
import { CATALOG } from "../src/commands.ts";
import { API_NAME } from "../src/apis.ts";
import { PACKET_FIELD_NAME } from "../src/packets.ts";
import { proposalAnswer } from "../src/proposals.ts";
import { GITHUB_REPOSITORY, PULL_REQUEST_URL } from "../src/pull-requests.ts";
import { getRequest } from "../src/requests.ts";
import { GITHUB_LOGIN, INSTALL_URL } from "../src/schemas.ts";
import { REQUEST_URL } from "../src/updates.ts";
import { agentOutputSchemas, outputSchemaProblems, untrustedFieldProblems } from "../src/untrusted-fields.ts";

// User text in JSON sits under untrusted objects (agent-safety: User text in
// JSON sits under untrusted objects). The check walks the output schema of
// every operation an agent surface offers and fails when a field that could
// hold text people or other systems wrote sits outside an `untrusted` object,
// or when a request's key or state sits inside one. The identifiers that may
// sit outside are listed here, each a pattern that holds no space.

const IDENTIFIERS: readonly RegExp[] = [
  REQUEST_KEY,
  TEAM_KEY,
  GITHUB_LOGIN,
  INSTALL_URL,
  // A request's URL on the install, which the pull readers name each update's request by.
  REQUEST_URL,
  EVENT_TYPE_NAME,
  EVENT_FIELD_NAME,
  EVENT_STRING_VALUE,
  PACKET_FIELD_NAME,
  GITHUB_REPOSITORY,
  PULL_REQUEST_URL,
  // A version, such as the Tiehall skill's that whoami warns about, holds no space.
  SEMANTIC_VERSION,
  // A registered API's name, such as payments-api, which contract.report answers with: lower-case letters, digits, dots, hyphens and underscores.
  API_NAME,
];
const patterns = new Set(IDENTIFIERS.map(({ source }) => source));
const problemsOf = (schema: z.ZodType) => outputSchemaProblems(schema, patterns).map(({ path }) => path);

describe("the check", () => {
  it("finds free text outside untrusted, also where it may be null or is one variant of several", () => {
    expect(problemsOf(z.object({ name: z.string(), note: z.string().nullable(), untrusted: z.object({ title: z.string() }) }))).toEqual([
      "$.name",
      "$.note",
    ]);
    expect(problemsOf(z.object({ value: z.union([z.number(), z.string()]) }))).toEqual(["$.value"]);
    expect(problemsOf(z.object({ items: z.array(z.object({ text: z.string() })) }))).toEqual(["$.items[].text"]);
  });

  it("accepts fixed values, ids, dates and the listed identifiers outside untrusted", () => {
    expect(
      problemsOf(
        z.object({
          key: z.string().regex(REQUEST_KEY),
          team: z.string().regex(TEAM_KEY),
          state: z.enum(["open", "done"]),
          kind: z.literal("human"),
          id: z.uuid(),
          at: z.iso.datetime(),
          due: z.iso.date(),
          count: z.number(),
          flag: z.boolean(),
        }),
      ),
    ).toEqual([]);
    expect(problemsOf(z.object({ other: z.string().regex(/^[a-z ]+$/) }))).toEqual(["$.other"]);
  });

  it("finds a value or a map that could hold any text outside untrusted, and accepts both inside", () => {
    expect(problemsOf(z.object({ anything: z.unknown(), map: z.record(z.string(), z.number()) }))).toEqual(["$.anything", "$.map.*"]);
    expect(problemsOf(z.object({ map: z.record(z.string().regex(TEAM_KEY), z.number()) }))).toEqual([]);
    expect(problemsOf(z.object({ untrusted: z.object({ anything: z.unknown(), map: z.record(z.string(), z.string()) }) }))).toEqual([]);
  });

  it("finds a key or a state inside untrusted, at any depth", () => {
    expect(problemsOf(z.object({ untrusted: z.object({ key: z.string(), deeper: z.object({ state: z.string() }) }) }))).toEqual([
      "$.untrusted.key",
      "$.untrusted.deeper.state",
    ]);
  });
});

describe("the identifiers that may sit outside untrusted", () => {
  it("are anchored patterns that match no white space and use no wildcard or negated class", () => {
    for (const pattern of IDENTIFIERS) {
      expect(pattern.test(" "), pattern.source).toBe(false);
      expect(pattern.source.startsWith("^") && pattern.source.endsWith("$"), pattern.source).toBe(true);
      expect(/\\s|\\S|\.|\\W|\\D|\[\^/.test(pattern.source.replace(/\\\./g, "")), pattern.source).toBe(false);
    }
  });
});

describe("the operations agents read", () => {
  it("are many, so the check has something to walk", () => {
    expect(CATALOG.commands.filter(({ surfaces }) => surfaces.length > 0).length).toBeGreaterThanOrEqual(10);
  });

  it("keep every user-written field under an untrusted object, and the key and the state outside", () => {
    expect(untrustedFieldProblems(CATALOG, IDENTIFIERS)).toEqual([]);
  });

  it("include the proposal a commitment answers with, which agents read as well", () => {
    const commitment = defineCatalog([
      defineCommand({
        id: "requests.decline",
        summary: "Propose to decline a request.",
        input: z.object({ key: z.string() }),
        output: z.object({ key: z.string().regex(REQUEST_KEY) }),
        method: "POST",
        path: "/api/v1/requests/{key}/decline",
        scopes: ["requests:write"],
        commitment: true,
        confirm: false,
        surfaces: ["rest"],
        stability: "alpha",
      }),
    ]);
    const walked = agentOutputSchemas(commitment);
    expect(walked.map(({ operation }) => operation)).toEqual(["requests.decline", "requests.decline (202)"]);
    expect(walked[1]?.schema).toBe(proposalAnswer);
  });

  it("put each message body of a request under untrusted, and its key and state outside", () => {
    const schema = z.toJSONSchema(getRequest.output, { io: "output" }) as any;
    expect(schema.properties.messages.items.properties.untrusted.properties.body).toMatchObject({ type: "string" });
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["key", "state", "untrusted"]));
  });
});

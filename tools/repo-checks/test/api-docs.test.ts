import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REFUSAL_REASONS } from "@tiehall/core";
import { describe, expect, it } from "vitest";
import { headings, linkProblems, section } from "../src/markdown.ts";

// The API docs (task 28.7; public-api: Each operation carries a stability
// level; public-api: Notice before a breaking change is enforced in CI;
// public-api: Deprecated operations send Deprecation and Sunset headers;
// public-api: The changelog page and the release notes; public-api: POST
// operations take an Idempotency-Key; public-api: One error model for
// Tiehall's own refusals). docs/api.md has a section for each topic: the
// stability levels, the notice rules, the deprecation headers, the changelog,
// idempotency and the error model. The check finds each section and what it
// must say, every row of the error model in its table with its status, the
// levels it states matching the committed OpenAPI document, and every link
// resolving; the admin UI links the page as it links every docs page.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const PAGE = "docs/api.md";
const page = existsSync(join(root, PAGE)) ? readFileSync(join(root, PAGE), "utf8") : "";

/** A section of the page as one line of text, or the empty text when it has none. */
const flat = (heading: string) => (section(page, heading) ?? "").replace(/\s+/g, " ");

const TOPICS: Record<string, string[]> = {
  "Stability levels": ["`x-stability-level`", "`alpha`", "`beta`", "`stable`", "`contract.report`", "four weeks", "`_meta`"],
  "The notice rules": ["14 days", "180 days", "`deprecated: true`", "`x-sunset`", "`/api/v2`", "six months", "`info.version`", "`0.N.0`", "`api-breaking`", "MCP tools", "additionalProperties"],
  "Deprecation headers": ["`Deprecation`", "RFC 9745", "`Sunset`", "RFC 8594"],
  "The changelog": ["`/docs/api/changelog`", "release notes", "email"],
  Idempotency: ["`Idempotency-Key`", "24 hours", "422", "per caller", "draft-ietf-httpapi-idempotency-key-header"],
  "The error model": ["RFC 9457", "`application/problem+json`", "`https://tiehall.com/problems/`", "`isError`", "`Retry-After`"],
};

describe("the API docs", () => {
  it("have a section for each topic, with what it must say", () => {
    const level2 = headings(page)
      .filter(({ level }) => level === 2)
      .map(({ text }) => text);
    for (const [heading, phrases] of Object.entries(TOPICS)) {
      expect(level2, heading).toContain(heading);
      expect(
        phrases.filter((phrase) => !flat(heading).includes(phrase)),
        heading,
      ).toEqual([]);
    }
  });

  it("list every row of the error model with its problem type and status, and no other", () => {
    const rows = (section(page, "The error model") ?? "")
      .split("\n")
      .filter((line) => /^\|\s*`[a-z-]+`\s*\|/.test(line))
      .map((line) => line.split("|").map((cell) => cell.trim()));
    const listed = new Map(rows.map((cells) => [(cells[1] ?? "").replaceAll("`", ""), cells[2] ?? ""]));
    expect([...listed.keys()].sort()).toEqual(Object.keys(REFUSAL_REASONS).sort());
    for (const [type, { status }] of Object.entries(REFUSAL_REASONS)) expect(listed.get(type), type).toBe(String(status));
  });

  it("state the levels the committed document gives: contract.report stable, every other operation beta", () => {
    const document = JSON.parse(readFileSync(join(root, "openapi/v1.json"), "utf8")) as {
      paths: Record<string, Record<string, { operationId?: string; "x-stability-level"?: string }>>;
    };
    const levels = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods)
        .filter((operation) => typeof operation === "object" && operation.operationId !== undefined)
        .map((operation) => [operation.operationId, operation["x-stability-level"]]),
    );
    expect(levels.length).toBeGreaterThan(0);
    for (const [operationId, level] of levels) expect(level, operationId).toBe(operationId === "contract.report" ? "stable" : "beta");
    expect(flat("Stability levels")).toContain("Every other operation, and every MCP tool, is `beta`");
  });

  it("have links that all resolve", () => {
    expect(linkProblems(root, PAGE)).toEqual([]);
  });
});

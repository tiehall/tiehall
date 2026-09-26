import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, defineCatalog } from "../src/index.ts";
import { COMMITTED_DOCUMENT, documentDrift } from "../src/openapi-drift.ts";
import { openRequest } from "./support/drift-catalog.ts";

// Every API change is reviewed as a document diff (public-api: Every API
// change is reviewed as a document diff; design.md, Technical decisions:
// T10). CI regenerates openapi/v1.json from the catalog on every pull request
// and fails when it differs from the committed file, so no operation changes
// without the change showing in the reviewed document.

const fixtureDocument = readFileSync(new URL("fixtures/openapi/v1.json", import.meta.url), "utf8");

describe("the drift check", () => {
  it("passes a committed document that the catalog regenerates unchanged", () => {
    expect(documentDrift(defineCatalog([openRequest]), fixtureDocument)).toBeUndefined();
  });

  it("fails when an input schema changed and the document was not regenerated", () => {
    const changed = { ...openRequest, input: z.object({ team: z.string(), title: z.string(), dueDate: z.iso.date() }) };
    const drift = documentDrift(defineCatalog([changed]), fixtureDocument);
    expect(drift).toContain("openapi/v1.json differs from the document the catalog generates");
    expect(drift).toContain("pnpm openapi:generate");
    expect(drift).toContain("dueDate");
  });

  it("fails when an operation was added without regenerating", () => {
    const added = { ...openRequest, id: "requests.create_draft", path: "/api/v1/drafts", cliCommand: "draft" };
    expect(documentDrift(defineCatalog([openRequest, added]), fixtureDocument)).toContain("/api/v1/drafts");
  });

  it("fails on a hand edit of the committed document", () => {
    const edited = fixtureDocument.replace('"summary": "Open a request to a team."', '"summary": "Open a request."');
    expect(edited).not.toBe(fixtureDocument);
    expect(documentDrift(defineCatalog([openRequest]), edited)).toContain("Open a request to a team.");
  });
});

describe("openapi/v1.json", () => {
  it("is the document the catalog generates", () => {
    expect(documentDrift(CATALOG, readFileSync(COMMITTED_DOCUMENT, "utf8"))).toBeUndefined();
  });
});

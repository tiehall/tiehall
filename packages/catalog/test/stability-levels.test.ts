import { describe, expect, it } from "vitest";
import { apiMajorsOf, CATALOG, OPENAPI_DOCUMENTS } from "../src/index.ts";
import { openApiDocument } from "../src/openapi.ts";
import { STABILITY_META_KEY, toolListing, toolSnapshot } from "../src/tool-schemas.ts";

// The stability levels the first release offers (public-api: Each operation
// carries a stability level; agent-surfaces: Tool annotations and stability
// levels; design.md, Design rules: Public API). A published release offers no
// operation or tool at alpha, so every operation a company can call on a
// released install is held to the notice rules: contract.report and the CI
// OIDC path are stable from the start, and every other public operation is
// beta until it passes the graduation test. These tests read the documents
// the catalog generates, for every major version of the API it serves, and
// the tool list it gives, as `tools/list` and the committed snapshot give it;
// the release check (tools/repo-checks/src/release-stability.ts) refuses a
// release whose committed documents offer anything at alpha.

/** Every operation of the generated documents: its id and its stability level. */
function operations(): { id: string; level: unknown }[] {
  return apiMajorsOf(CATALOG).flatMap((major) =>
    Object.values((openApiDocument(CATALOG, { major }) as { paths: Record<string, Record<string, { operationId?: string; "x-stability-level"?: unknown }>> }).paths).flatMap((byMethod) =>
      Object.values(byMethod).map((operation) => ({ id: operation.operationId ?? "", level: operation["x-stability-level"] })),
    ),
  );
}

describe("the stability levels of the first release", () => {
  it("mark every operation of the generated documents beta or stable, contract.report stable and requests.create beta", () => {
    const listed = operations();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter(({ level }) => level !== "beta" && level !== "stable")).toEqual([]);
    expect(listed.find(({ id }) => id === "contract.report")?.level).toBe("stable");
    expect(listed.find(({ id }) => id === "requests.create")?.level).toBe("beta");
    expect(listed.filter(({ level }) => level === "stable").map(({ id }) => id)).toEqual(["contract.report"]);
  });

  it("mark every tool beta, in its _meta and in the snapshot, as the operation it runs", () => {
    expect(toolListing(CATALOG).length).toBeGreaterThan(0);
    for (const tool of toolListing(CATALOG)) expect([tool.name, tool._meta?.[STABILITY_META_KEY]]).toEqual([tool.name, "beta"]);
    for (const tool of toolSnapshot(CATALOG)) expect([tool.name, tool.stability]).toEqual([tool.name, "beta"]);
  });

  it("mark every public operation of the catalog beta or stable, on every surface it is offered on", () => {
    const offered = CATALOG.commands.filter((command) => command.surfaces.length > 0);
    expect(offered.filter((command) => command.stability === "alpha").map(({ id }) => id)).toEqual([]);
  });

  it("are the levels of the committed documents an install serves", () => {
    for (const [major, text] of Object.entries(OPENAPI_DOCUMENTS)) {
      const committed = JSON.parse(text) as { paths: Record<string, Record<string, { "x-stability-level"?: unknown }>> };
      const levels = Object.values(committed.paths).flatMap((byMethod) => Object.values(byMethod).map((operation) => operation["x-stability-level"]));
      expect([major, levels.filter((level) => level === "alpha")]).toEqual([major, []]);
    }
  });
});

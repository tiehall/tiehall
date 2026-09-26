import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, CatalogError, catalogProblems, defineCatalog, defineCommand, type CommandDefinition } from "../src/index.ts";

// The command catalog (public-api: One definition per operation, the same on
// every surface; agent-safety: The confirmation step runs only in the web UI;
// design.md, Technical decisions: T3). Each operation has one definition: an
// id, zod input and output schemas, its method and path on REST, its scopes,
// the `commitment` and `confirm` flags, the surfaces that offer it and its
// stability level. A catalog registers only definitions that keep the rules,
// and names every one they break.

const request = z.object({ key: z.string(), title: z.string() });

/** A small catalog of the kinds of definitions the real one holds. */
const fixture = {
  getRequest: defineCommand({
    id: "requests.get",
    summary: "Read a request.",
    input: z.object({ key: z.string() }),
    output: request,
    method: "GET",
    path: "/api/v1/requests/{key}",
    scopes: ["requests:read"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp", "cli"],
    tool: "get_request",
    cliCommand: "get",
    stability: "beta",
  }),
  declineRequest: defineCommand({
    id: "requests.decline",
    summary: "Propose to decline a request.",
    input: z.object({ key: z.string(), reason: z.string() }),
    output: z.object({ proposalId: z.string() }),
    method: "POST",
    path: "/api/v1/requests/{key}/decline",
    scopes: ["requests:write"],
    commitment: true,
    confirm: false,
    surfaces: ["rest"],
    stability: "alpha",
  }),
  changeRole: defineCommand({
    id: "members.change_role",
    summary: "Change a member's role.",
    input: z.object({ userId: z.string(), role: z.enum(["admin", "member"]) }),
    output: z.object({}),
    scopes: [],
    commitment: false,
    confirm: true,
    surfaces: [],
    stability: "beta",
  }),
  reportContract: defineCommand({
    id: "contract.report",
    summary: "Report the classified changes of a provider pull request.",
    input: z.object({ api: z.string() }),
    output: z.object({ changeSetId: z.string() }),
    method: "POST",
    path: "/api/v1/contract/reports",
    scopes: ["contracts:report"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "cli"],
    cliCommand: "contract report",
    stability: "stable",
    deprecated: { since: "2026-09-01", sunset: "2027-03-01" },
  }),
};
const fixtureCatalog = Object.values(fixture) as CommandDefinition[];

/** The fixture catalog with one definition changed as given. */
function withChanged(name: keyof typeof fixture, change: Record<string, unknown>): CommandDefinition[] {
  return fixtureCatalog.map((definition) => (definition === fixture[name] ? ({ ...definition, ...change } as CommandDefinition) : definition));
}

describe("a catalog", () => {
  it("registers definitions that keep the rules and finds each by id", () => {
    const catalog = defineCatalog(fixtureCatalog);
    expect(catalog.commands.map(({ id }) => id)).toEqual(["requests.get", "requests.decline", "members.change_role", "contract.report"]);
    expect(catalog.get("requests.get")).toBe(fixture.getRequest);
    expect(catalog.get("requests.missing")).toBeUndefined();
    expect(catalogProblems(fixtureCatalog)).toEqual([]);
  });

  it("refuses two definitions with the same id", () => {
    const definitions = [...fixtureCatalog, { ...fixture.declineRequest, path: "/api/v1/requests/{key}/decline-again" }];
    expect(catalogProblems(definitions)).toEqual(["requests.decline: two definitions have this id."]);
    expect(() => defineCatalog(definitions)).toThrow(CatalogError);
  });

  it("refuses a scope outside the three OAuth scopes", () => {
    const definitions = withChanged("getRequest", { scopes: ["requests:read", "admin"] });
    expect(catalogProblems(definitions)).toEqual([
      "requests.get: the scope admin is not one of requests:read, requests:write, contracts:report.",
    ]);
    expect(() => defineCatalog(definitions)).toThrow(CatalogError);
  });

  it("refuses a definition offered on REST without a method and a path", () => {
    const withoutPath = withChanged("getRequest", { path: undefined });
    expect(catalogProblems(withoutPath)).toEqual(["requests.get: it is offered on REST, so it names its method and its path."]);
    expect(() => defineCatalog(withoutPath)).toThrow(CatalogError);
    const withoutMethod = withChanged("declineRequest", { method: undefined });
    expect(catalogProblems(withoutMethod)).toEqual(["requests.decline: it is offered on REST, so it names its method and its path."]);
    expect(() => defineCatalog(withoutMethod)).toThrow(CatalogError);
  });

  it("refuses a confirm command offered on any agent surface", () => {
    for (const surface of ["rest", "mcp", "cli"] as const) {
      const definitions = withChanged("changeRole", {
        surfaces: [surface, ...(surface === "cli" ? ["rest"] : [])],
        method: "POST",
        path: "/api/v1/members/{userId}/role",
        scopes: ["requests:write"],
        tool: "change_role",
        cliCommand: "role",
      });
      expect(catalogProblems(definitions), surface).toEqual([
        "members.change_role: it needs the confirmation step, which runs only in the web UI, so no agent surface offers it.",
      ]);
      expect(() => defineCatalog(definitions), surface).toThrow(CatalogError);
    }
  });

  it("names every problem of a catalog at once", () => {
    const definitions = [...withChanged("getRequest", { scopes: ["admin"], path: undefined }), fixture.getRequest];
    expect(() => defineCatalog(definitions)).toThrow(
      new CatalogError(
        [
          "requests.get: the scope admin is not one of requests:read, requests:write, contracts:report.",
          "requests.get: it is offered on REST, so it names its method and its path.",
          "requests.get: two definitions have this id.",
        ].join("\n"),
      ),
    );
  });

  it("refuses the rest of what would make the surfaces disagree", () => {
    expect(catalogProblems(withChanged("getRequest", { id: "Requests.Get" }))).toEqual([
      'Requests.Get: the id is not a dotted lower-case name, such as "requests.create".',
    ]);
    expect(catalogProblems(withChanged("getRequest", { stability: "draft" }))).toEqual([
      "requests.get: the stability level draft is not one of alpha, beta, stable.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { surfaces: ["rest", "web"] }))).toEqual([
      "requests.get: the surface web is not one of rest, mcp, cli; a command that no surface offers is internal.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { tool: undefined }))).toEqual([
      "requests.get: it is offered on MCP, so it names its tool.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { cliCommand: undefined }))).toEqual([
      "requests.get: it is offered on the CLI, so it names its CLI command.",
    ]);
    expect(catalogProblems(withChanged("reportContract", { surfaces: ["cli"] }))).toEqual([
      "contract.report: it is offered on the CLI, which calls REST, so it is offered on REST too.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { scopes: [] }))).toEqual([
      "requests.get: it is offered on an agent surface, so it names the scopes a token needs to run it.",
    ]);
    expect(catalogProblems(withChanged("reportContract", { deprecated: { since: "1 September", sunset: "2027-03-01" } }))).toEqual([
      "contract.report: its deprecation dates are calendar dates, such as 2026-12-15.",
    ]);
    expect(catalogProblems([...fixtureCatalog, { ...fixture.getRequest, id: "requests.read", tool: "read_request", cliCommand: "read" }])).toEqual([
      "requests.read: GET /api/v1/requests/{key} is also the path of requests.get.",
    ]);
    // The same path with its parameter named differently matches the same URLs, and OpenAPI treats the two as one path.
    expect(
      catalogProblems([
        ...fixtureCatalog,
        { ...fixture.getRequest, id: "requests.read", input: z.object({ id: z.string() }), path: "/api/v1/requests/{id}", tool: "read_request", cliCommand: "read" },
      ]),
    ).toEqual(["requests.read: GET /api/v1/requests/{id} is also the path of requests.get."]);
    // A literal segment where another path has a parameter is not the same path: the literal one wins on REST.
    expect(
      catalogProblems([
        ...fixtureCatalog,
        { ...fixture.getRequest, id: "requests.search", input: z.object({}), path: "/api/v1/requests/search", tool: "search_requests", cliCommand: "search" },
      ]),
    ).toEqual([]);
    expect(catalogProblems([...fixtureCatalog, { ...fixture.getRequest, id: "requests.read", path: "/api/v1/read/{key}", cliCommand: "read" }])).toEqual([
      "requests.read: the tool get_request is also the tool of requests.get.",
    ]);
    expect(catalogProblems([...fixtureCatalog, { ...fixture.getRequest, id: "requests.read", path: "/api/v1/read/{key}", tool: "read_request" }])).toEqual([
      "requests.read: the CLI command get is also the CLI command of requests.get.",
    ]);
  });
});

describe("the catalog", () => {
  it("keeps the rules", () => {
    expect(catalogProblems(CATALOG.commands)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, CatalogError, catalogProblems, defineCatalog, defineCommand, role, type CommandDefinition } from "../src/index.ts";

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
    cli: [{ command: "get", arguments: ["key"] }],
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
    cli: [{ command: "contract report" }],
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
        ...(surface === "cli" ? { cli: [{ command: "role" }] } : {}),
      });
      expect(catalogProblems(definitions), surface).toEqual([
        "members.change_role: it needs the confirmation step, which runs only in the web UI, so no agent surface offers it.",
      ]);
      expect(() => defineCatalog(definitions), surface).toThrow(CatalogError);
    }
  });

  // github-app-reachability: design.md, Design rules: Moving to webhook mode. A value such as a secret is
  // entered on the review page of an action that needs the confirmation step, and is never part of its input,
  // which the review page's URL carries.
  it("refuses values entered on a review page for a command that needs no confirmation step, or that clash with the form or the input", () => {
    const secret = { name: "secret", label: "The secret", kind: "password", schema: z.string().min(1) } as const;
    expect(catalogProblems(withChanged("changeRole", { sealed: [secret] }))).toEqual([]);
    expect(catalogProblems(withChanged("changeRole", { sealed: [secret], confirm: false }))).toEqual([
      "members.change_role: it takes values entered on a review page, which only an action that needs the confirmation step has.",
    ]);
    expect(catalogProblems(withChanged("changeRole", { sealed: [secret, secret] }))).toEqual([
      "members.change_role: two of the values entered on its review page share a name.",
    ]);
    expect(catalogProblems(withChanged("changeRole", { sealed: [{ ...secret, name: "nonce" }] }))).toEqual([
      "members.change_role: the value nonce entered on its review page needs a camelCase name that the page's form does not use itself.",
    ]);
    expect(catalogProblems(withChanged("changeRole", { sealed: [{ ...secret, name: "role" }] }))).toEqual([
      "members.change_role: the value role entered on its review page is also a field of its input, which the review page's URL carries.",
    ]);
  });

  // teams-and-roles: What admins and members may do. Admin actions run only in the web UI, so an admin's agent
  // gets the same tools and commands as a member's (agent-surfaces: Admin actions and trust changes are on no
  // agent surface).
  it("refuses an admin action offered on any agent surface", () => {
    const createTeam = defineCommand({
      id: "teams.create",
      summary: "Create a team.",
      input: z.object({ key: z.string(), name: z.string() }),
      output: z.object({ teamId: z.string() }),
      scopes: [],
      commitment: false,
      confirm: false,
      admin: "teams",
      surfaces: [],
      stability: "alpha",
    });
    expect(catalogProblems([...fixtureCatalog, createTeam])).toEqual([]);
    for (const surface of ["rest", "mcp", "cli"] as const) {
      const offered = {
        ...createTeam,
        surfaces: [surface, ...(surface === "cli" ? (["rest"] as const) : [])],
        method: "POST",
        path: "/api/v1/teams",
        scopes: ["requests:write"],
        tool: "create_team",
        ...(surface === "cli" ? { cli: [{ command: "team create" }] } : {}),
      } as CommandDefinition;
      expect(catalogProblems([...fixtureCatalog, offered]), surface).toEqual([
        "teams.create: it is an admin action, which runs only in the web UI, so no agent surface offers it.",
      ]);
    }
    expect(catalogProblems([...fixtureCatalog, { ...createTeam, admin: "owners" } as unknown as CommandDefinition])).toEqual([
      "teams.create: the admin action owners is not one of members, teams, sign_in_policy, integrations, apis, agent_access, bot_flag, fan_out, activity_log.",
    ]);
  });

  // requests: Commitments become proposals; public-api: Commitments over the API answer 202 with a proposal. A
  // commitment answers a call that makes one with { proposal } instead of its output, so REST can tell the two apart.
  it("refuses a commitment whose output has a proposal field, that needs the confirmation step, or that is a GET", () => {
    expect(catalogProblems(withChanged("declineRequest", { output: z.object({ proposal: z.string() }) }))).toEqual([
      "requests.decline: it is a commitment, which answers a call that makes one with { proposal }, so its own output has no field named proposal.",
    ]);
    expect(catalogProblems(withChanged("changeRole", { commitment: true }))).toEqual([
      "members.change_role: it is a commitment, which becomes a proposal people confirm, so it does not need the confirmation step itself.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { commitment: true }))).toEqual([
      "requests.get: it is a commitment, which changes something, so it is not offered with GET.",
    ]);
  });

  // requests: System actions need no proposal or confirmation. A system action runs only in the worker.
  it("refuses a system action offered on a surface, needing a proposal or a confirmation, or taken as an admin", () => {
    const system = {
      id: "requests.close_on_merge",
      summary: "Close a request whose linked pull request merged.",
      input: z.object({ requestId: z.string() }),
      output: z.object({}),
      scopes: [],
      commitment: false,
      confirm: false,
      system: true,
      surfaces: [],
      stability: "alpha",
    } as CommandDefinition;
    expect(catalogProblems([...fixtureCatalog, system])).toEqual([]);
    expect(catalogProblems([...fixtureCatalog, { ...system, surfaces: ["mcp"], tool: "close", scopes: ["requests:write"] } as CommandDefinition])).toEqual([
      "requests.close_on_merge: it is a system action, which only Tiehall's jobs and verified integration events run, so no agent surface offers it.",
    ]);
    for (const flag of [{ commitment: true }, { confirm: true }]) {
      expect(catalogProblems([...fixtureCatalog, { ...system, ...flag } as CommandDefinition])).toContain(
        "requests.close_on_merge: it is a system action, which needs no proposal and no confirmation.",
      );
    }
    expect(catalogProblems([...fixtureCatalog, { ...system, admin: "teams" } as CommandDefinition])).toEqual([
      "requests.close_on_merge: it is a system action, which acts for no admin.",
    ]);
  });

  // activity-log: The activity log is append-only. No operation on any surface changes or deletes an event, the web
  // UI included, which runs its operations through this same catalog.
  it("refuses an operation that changes or deletes an event of the activity log, on any surface, the web UI included", () => {
    const internal = { input: z.object({ number: z.number() }), output: z.object({}), scopes: [], commitment: false, confirm: false, surfaces: [], stability: "alpha" } as const;
    const deleteEvent = defineCommand({
      ...internal,
      id: "events.delete",
      summary: "Delete an event.",
      method: "DELETE",
      path: "/api/v1/events/{number}",
      scopes: ["requests:write"],
      surfaces: ["rest"],
    });
    expect(catalogProblems([...fixtureCatalog, deleteEvent])).toEqual([
      "events.delete: it is an operation on the activity log, which is append-only, so it only reads, gets, lists, waits for, acknowledges or exports events; delete is none of these.",
      "events.delete: it is an operation on the activity log, which is append-only, so it is not offered with DELETE, PUT or PATCH.",
      "events.delete: its summary says it changes or deletes events, which the activity log, being append-only, lets no operation do.",
    ]);
    // An internal admin command, which only the web UI runs, is held to the same rule.
    const redact = defineCommand({ ...internal, id: "activity_log.redact", summary: "Redact one field of an event of the activity log.", admin: "activity_log" });
    expect(catalogProblems([...fixtureCatalog, redact])).toEqual([
      "activity_log.redact: it is an operation on the activity log, which is append-only, so it only reads, gets, lists, waits for, acknowledges or exports events; redact is none of these.",
      "activity_log.redact: its summary says it changes or deletes events, which the activity log, being append-only, lets no operation do.",
    ]);
    // So is an operation elsewhere whose path or summary reaches the events.
    const rewrite = defineCommand({ ...internal, id: "requests.rewrite_history", summary: "Rewrite the events of a request.", method: "PUT", path: "/api/v1/events/{number}", scopes: ["requests:write"], surfaces: ["rest"] });
    expect(catalogProblems([...fixtureCatalog, rewrite])).toEqual([
      "requests.rewrite_history: it is an operation on the activity log, which is append-only, so it only reads, gets, lists, waits for, acknowledges or exports events; rewrite_history is none of these.",
      "requests.rewrite_history: it is an operation on the activity log, which is append-only, so it is not offered with DELETE, PUT or PATCH.",
      "requests.rewrite_history: its summary says it changes or deletes events, which the activity log, being append-only, lets no operation do.",
    ]);
    const purge = defineCommand({ ...internal, id: "requests.purge", summary: "Purge a closed request and delete its events." });
    expect(catalogProblems([...fixtureCatalog, purge])).toEqual([
      "requests.purge: its summary says it changes or deletes events, which the activity log, being append-only, lets no operation do.",
    ]);
    // Reading, listing, acknowledging and exporting events keep the rule, and so does a summary that only mentions events.
    const read = defineCommand({ ...internal, id: "events.read", summary: "Read the events after your cursor.", method: "GET", path: "/api/v1/events", scopes: ["requests:read"], surfaces: ["rest"] });
    const acknowledge = defineCommand({ ...internal, id: "events.acknowledge", summary: "Acknowledge the events up to a number.", method: "POST", path: "/api/v1/events/acknowledge", scopes: ["requests:read"], surfaces: ["rest"] });
    const exportLog = defineCommand({ ...internal, id: "activity_log.export", summary: "Export the activity log as JSONL.", confirm: true, admin: "activity_log" });
    const propose = defineCommand({ ...internal, id: "requests.propose", summary: "Propose a change to a request; its events reach the requester." });
    expect(catalogProblems([...fixtureCatalog, read, acknowledge, exportLog, propose])).toEqual([]);
  });

  it("holds no operation that changes or deletes an event, in the real catalog", () => {
    expect(catalogProblems(CATALOG.commands)).toEqual([]);
    expect(CATALOG.commands.filter(({ id }) => /^(events|activity_log)\./.test(id)).map(({ id }) => id)).toEqual(
      expect.arrayContaining(["events.read", "events.acknowledge", "activity_log.list", "activity_log.export"]),
    );
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
    expect(catalogProblems(withChanged("getRequest", { surfaces: ["rest", "mcp", "cli", "web"] }))).toEqual([
      "requests.get: the surface web is not one of rest, mcp, cli; a command that no surface offers is internal.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { tool: undefined }))).toEqual([
      "requests.get: it is offered on MCP, so it names its tool.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { cli: undefined }))).toEqual([
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
    expect(catalogProblems([...fixtureCatalog, { ...fixture.getRequest, id: "requests.read", tool: "read_request", cli: [{ command: "read" }] }])).toEqual([
      "requests.read: GET /api/v1/requests/{key} is also the path of requests.get.",
    ]);
    // The same path with its parameter named differently matches the same URLs, and OpenAPI treats the two as one path.
    expect(
      catalogProblems([
        ...fixtureCatalog,
        { ...fixture.getRequest, id: "requests.read", input: z.object({ id: z.string() }), path: "/api/v1/requests/{id}", tool: "read_request", cli: [{ command: "read" }] },
      ]),
    ).toEqual(["requests.read: GET /api/v1/requests/{id} is also the path of requests.get."]);
    // A literal segment where another path has a parameter is not the same path: the literal one wins on REST.
    expect(
      catalogProblems([
        ...fixtureCatalog,
        { ...fixture.getRequest, id: "requests.search", input: z.object({}), path: "/api/v1/requests/search", tool: "search_requests", cli: [{ command: "search" }] },
      ]),
    ).toEqual([]);
    expect(catalogProblems([...fixtureCatalog, { ...fixture.getRequest, id: "requests.read", path: "/api/v1/read/{key}", cli: [{ command: "read" }] }])).toEqual([
      "requests.read: the tool get_request is also the tool of requests.get.",
    ]);
    expect(catalogProblems([...fixtureCatalog, { ...fixture.getRequest, id: "requests.read", path: "/api/v1/read/{key}", tool: "read_request" }])).toEqual([
      "requests.read: the CLI command get is also the CLI command of requests.get.",
    ]);
  });

  // agent-surfaces: CLI request commands; design.md, Self-hosting decisions: S16. The CLI builds each of its request
  // commands from the operation's x-tiehall-cli extension, since it may not import the catalog: a command's
  // arguments and the input it sets are fields of the operation's input, and each command is named once.
  it("refuses CLI commands that the CLI could not build from the document", () => {
    expect(catalogProblems(withChanged("declineRequest", { cli: [{ command: "decline" }] }))).toEqual([
      "requests.decline: it names CLI commands, so it is offered on the CLI.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { cli: [] }))).toEqual(["requests.get: it is offered on the CLI, so it names its CLI command."]);
    expect(catalogProblems(withChanged("getRequest", { cli: [{ command: "Get" }] }))).toEqual([
      'requests.get: its CLI command Get is not lower-case words, such as get or "contract report".',
    ]);
    expect(catalogProblems(withChanged("getRequest", { cli: [{ command: "get", arguments: ["id"] }] }))).toEqual([
      "requests.get: its CLI command get takes id as an argument, which is not a field of its input.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { cli: [{ command: "get", arguments: ["key", "key"] }] }))).toEqual([
      "requests.get: its CLI command get takes key as an argument twice.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { cli: [{ command: "get", input: { page: 2 } }] }))).toEqual([
      "requests.get: its CLI command get sets page, which is not a field of its input.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { cli: [{ command: "get", arguments: ["key"], defaults: { key: "FE-1" } }] }))).toEqual([
      "requests.get: its CLI command get both takes key as an argument and sets it.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { cli: [{ command: "get", input: { key: "FE-1" }, defaults: { key: "FE-2" } }] }))).toEqual([
      "requests.get: its CLI command get sets key twice.",
    ]);
    expect(catalogProblems(withChanged("getRequest", { cli: [{ command: "get" }, { command: "get" }] }))).toEqual([
      "requests.get: the CLI command get is also the CLI command of requests.get.",
    ]);
  });

  it("lets two CLI commands run one operation whose input has variants, each naming fields of any variant", () => {
    const post = defineCommand({
      id: "messages.post",
      summary: "Post a message.",
      input: z.discriminatedUnion("kind", [
        z.object({ key: z.string(), kind: z.literal("question"), body: z.string() }),
        z.object({ key: z.string(), kind: z.literal("answer"), body: z.string(), questionId: z.string() }),
      ]),
      output: z.object({}),
      method: "POST",
      path: "/api/v1/requests/{key}/messages",
      scopes: ["requests:write"],
      commitment: false,
      confirm: false,
      surfaces: ["rest", "cli"],
      cli: [
        { command: "ask", arguments: ["key", "body"], defaults: { kind: "question" } },
        { command: "reply", arguments: ["key", "body", "questionId"], input: { kind: "answer" } },
      ],
      stability: "alpha",
    });
    expect(catalogProblems([...fixtureCatalog, post])).toEqual([]);
    expect(catalogProblems([...fixtureCatalog, { ...post, cli: [{ command: "reply", arguments: ["key", "text"] }] }])).toEqual([
      "messages.post: its CLI command reply takes text as an argument, which is not a field of its input.",
    ]);
  });
});

// teams-and-roles: One org per install. The install holds one org, the company that runs it, so no surface offers
// an operation that creates, lists, picks or switches orgs: no operation, tool or CLI command names one.
describe("the real catalog", () => {
  const ORG = /(^|[^a-z])(org|orgs|organi[sz]ations?)([^a-z]|$)/i;

  it("has no operation, tool or CLI command that creates, lists, picks or switches an org", () => {
    const names = CATALOG.commands.flatMap(({ id, summary, path, tool, cli = [] }) =>
      [id, summary, path, tool, ...cli.map(({ command }) => command)].filter((name): name is string => name !== undefined),
    );
    expect(names.filter((name) => ORG.test(name))).toEqual([]);
  });

  // teams-and-roles: Bot users. The web UI marks a user as a bot wherever it lists or names them, so every
  // operation's output that names a user by their login also says their kind and whether they are a bot.
  it("names a user nowhere without their kind and their bot flag", () => {
    const unmarked: string[] = [];
    const visit = (schema: unknown, where: string): void => {
      if (Array.isArray(schema)) return schema.forEach((item, index) => visit(item, `${where}[${index}]`));
      if (typeof schema !== "object" || schema === null) return;
      const properties = (schema as { properties?: Record<string, unknown> }).properties;
      if (properties !== undefined && "login" in properties && !("kind" in properties && "bot" in properties)) unmarked.push(where);
      for (const [key, value] of Object.entries(schema)) visit(value, `${where}.${key}`);
    };
    for (const { id, output } of CATALOG.commands) visit(z.toJSONSchema(output, { io: "output" }), id);
    expect(unmarked).toEqual([]);
    expect(CATALOG.get("members.list")).toBeDefined();
  });

  it("would be caught naming an org", () => {
    for (const name of ["orgs.create", "orgs.list", "/api/v1/orgs/{orgId}", "switch_org", "org switch", "organizations.select"]) {
      expect(ORG.test(name), name).toBe(true);
    }
    for (const name of ["teams.create", "sign_in.set_policy", "/api/v1/requests/{key}", "whats_new"]) expect(ORG.test(name), name).toBe(false);
  });
});

// requests: Requests only, with questions in the request's thread. v1 ships tracked requests and no free-form
// rooms, so no surface offers an operation that creates, lists or reads a room: no operation, tool or CLI
// command names one, and a thread is always a request's own, reached through the request.
describe("the real catalog, which offers requests and no rooms", () => {
  const ROOM = /(^|[^a-z])(rooms?|channels?|chats?|conversations?|dms?|direct_messages?)([^a-z]|$)/i;

  it("has no operation, tool or CLI command that creates, lists or reads a free-form room", () => {
    const names = CATALOG.commands.flatMap(({ id, summary, path, tool, cli = [] }) =>
      [id, summary, path, tool, ...cli.map(({ command }) => command)].filter((name): name is string => name !== undefined),
    );
    expect(names.filter((name) => ROOM.test(name))).toEqual([]);
    expect(CATALOG.get("requests.get")).toBeDefined();
    expect(CATALOG.get("requests.list")).toBeDefined();
  });

  it("would be caught naming a room", () => {
    for (const name of ["rooms.create", "rooms.list", "/api/v1/rooms/{roomId}/messages", "read_room", "room join", "channels.post", "start_conversation"]) {
      expect(ROOM.test(name), name).toBe(true);
    }
    for (const name of ["requests.create", "requests.list", "/api/v1/requests/{key}", "get_request", "whats_new", "teams.add_member"]) {
      expect(ROOM.test(name), name).toBe(false);
    }
  });
});

// teams-and-roles: Two roles, admin and member. An invite or a role change names one of the two roles, and input
// that names any other, such as owner, fails its schema, which the error model answers with 400.
describe("the role an input names", () => {
  it("is admin or member, and never owner", () => {
    expect(role.safeParse("admin").success).toBe(true);
    expect(role.safeParse("member").success).toBe(true);
    for (const other of ["owner", "Admin", "", null]) expect(role.safeParse(other).success, String(other)).toBe(false);
  });
});

// agent-surfaces: Tool schemas that current clients accept. A tool whose input has variants has its /api/v1
// operation too, which takes the variants as its JSON body; the path's parameters are fields of every variant.
describe("an operation whose input has variants", () => {
  const message = defineCommand({
    id: "requests.post_message",
    summary: "Post a comment, a question or an answer on a request.",
    input: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("comment"), key: z.string(), body: z.string() }),
      z.strictObject({ kind: z.literal("answer"), key: z.string(), body: z.string(), questionId: z.string() }),
    ]),
    output: z.object({ messageId: z.string() }),
    method: "POST",
    path: "/api/v1/requests/{key}/messages",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp"],
    tool: "post_message",
    stability: "alpha",
  });

  const withoutTool = ({ tool: _tool, ...definition }: CommandDefinition): CommandDefinition => definition;

  it("is offered on REST with a method that carries a body, as on MCP", () => {
    expect(catalogProblems([message])).toEqual([]);
    expect(catalogProblems([{ ...message, method: "PATCH" }])).toEqual([]);
  });

  it("is refused on REST with a method whose input the path and the query carry", () => {
    expect(catalogProblems([{ ...message, method: "GET" }])).toEqual([
      "requests.post_message: its input has variants, which only a JSON body carries, so it is offered on REST with POST, PUT or PATCH.",
    ]);
  });

  it("is refused when its path names a parameter that a variant lacks", () => {
    expect(catalogProblems([{ ...message, path: "/api/v1/questions/{questionId}/answers" }])).toEqual([
      "requests.post_message: its path names {questionId}, which is not a field of its input.",
    ]);
  });

  it("is refused on REST when a variant is not an object", () => {
    expect(
      catalogProblems([{ ...withoutTool(message), surfaces: ["rest"], input: z.union([z.object({ key: z.string() }), z.string()]) }]),
    ).toEqual(["requests.post_message: it is offered on REST, so its input is an object, or variants of objects, whose fields the path, query or body carry."]);
  });
});

// public-api: Packet revisions use ETag and If-Match. An operation that adds a
// packet revision names the input field REST fills from If-Match, and a read
// names the output field its ETag comes from; both are fields of the schemas.
describe("an operation with If-Match or an ETag", () => {
  const addRevision = defineCommand({
    id: "packets.add_revision",
    summary: "Add a revision of a request's packet.",
    input: z.object({ key: z.string(), expectedRevision: z.number().int().min(1).optional(), packet: z.object({ need: z.string() }) }),
    output: z.object({ revision: z.number().int() }),
    method: "POST",
    path: "/api/v1/requests/{key}/packet/revisions",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest"],
    stability: "alpha",
    ifMatch: "expectedRevision",
    etag: "revision",
  });

  it("is registered when both name fields of its schemas", () => {
    expect(catalogProblems([addRevision])).toEqual([]);
  });

  it("is refused when If-Match names no field of its input, or the ETag no field of its output", () => {
    expect(catalogProblems([{ ...addRevision, ifMatch: "revision" }])).toEqual([
      "packets.add_revision: its If-Match fills revision, which is not an optional field of its input.",
    ]);
    expect(catalogProblems([{ ...addRevision, ifMatch: "packet" }])).toEqual([
      "packets.add_revision: its If-Match fills packet, which is not an optional field of its input.",
    ]);
    expect(catalogProblems([{ ...addRevision, etag: "number" }])).toEqual([
      "packets.add_revision: its ETag comes from number, which is not a field of its output.",
    ]);
  });

  // design.md, Where the specs leave room: the expected revision off REST. An operation whose input has variants,
  // such as propose, takes If-Match in the variants that change the packet, where the field is optional.
  it("is registered with an input that has variants when the variants that have the field have it optional", () => {
    const propose = defineCommand({
      id: "proposals.propose",
      summary: "Propose a commitment.",
      input: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("due_date"), key: z.string(), dueDate: z.string().nullable(), expectedRevision: z.number().int().min(1).optional() }),
        z.strictObject({ kind: z.literal("withdraw"), key: z.string() }),
      ]),
      output: z.object({ revision: z.number().int() }),
      method: "POST",
      path: "/api/v1/proposals",
      scopes: ["requests:write"],
      commitment: true,
      confirm: false,
      surfaces: ["rest"],
      stability: "alpha",
      ifMatch: "expectedRevision",
    });
    expect(catalogProblems([propose])).toEqual([]);
    expect(catalogProblems([{ ...propose, ifMatch: "key" }])).toEqual([
      "proposals.propose: its If-Match fills key, which is not an optional field of its input.",
    ]);
    expect(catalogProblems([{ ...propose, ifMatch: "revision" }])).toEqual([
      "proposals.propose: its If-Match fills revision, which is not an optional field of its input.",
    ]);
  });

  it("is refused with If-Match or an ETag when REST does not offer it", () => {
    const { method: _method, path: _path, ...internal } = addRevision;
    expect(catalogProblems([{ ...internal, surfaces: [] }])).toEqual([
      "packets.add_revision: If-Match and ETag are REST headers, so only an operation offered on REST names them.",
    ]);
  });
});

describe("the catalog", () => {
  it("keeps the rules", () => {
    expect(catalogProblems(CATALOG.commands)).toEqual([]);
  });
});

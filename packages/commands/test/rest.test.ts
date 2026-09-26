import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, catalogProblems, defineCatalog, defineCommand } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { createLogger, createRestHandler, type Caller, type Execute, type LogEntry } from "../src/index.ts";

// The REST catch-all route under /api/v1 (public-api: Operations not offered on
// REST answer 404; public-api: Errors are RFC 9457 problem details; public-api:
// The major version is in the path; design.md, Technical decisions: T3). One
// route handler serves every REST operation: it finds the operation by method
// and path in the catalog, builds its input from the path, the query or the
// JSON body, and runs it through execute(). A path that serves no operation on
// REST answers 404 without running anything, and every error is an RFC 9457
// problem with the media type application/problem+json.

const INSTALL = "https://tiehall.example.com";
const BOB = randomUUID();

const catalog = defineCatalog([
  defineCommand({
    id: "probes.get",
    summary: "Read a probe request.",
    input: z.object({ key: z.string(), page: z.coerce.number().int().optional() }),
    output: z.object({ key: z.string() }),
    method: "GET",
    path: "/api/v1/probes/{key}",
    scopes: ["requests:read"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp"],
    tool: "get_probe",
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.post",
    summary: "Post a message on a probe request.",
    input: z.object({ key: z.string(), body: z.string() }),
    output: z.object({ messageId: z.string() }),
    method: "POST",
    path: "/api/v1/probes/{key}/messages",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest"],
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.mcp_only",
    summary: "An operation offered on MCP only, although it names a path.",
    input: z.object({ key: z.string() }),
    output: z.object({}),
    method: "POST",
    path: "/api/v1/probes/{key}/mcp-only",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["mcp"],
    tool: "mcp_only",
    stability: "alpha",
  }),
  defineCommand({
    id: "probes.internal",
    summary: "An internal command, which the web UI runs.",
    input: z.object({}),
    output: z.object({}),
    scopes: [],
    commitment: false,
    confirm: false,
    surfaces: [],
    stability: "alpha",
  }),
]);

const agent: Caller = { kind: "personal_access_token", userId: BOB, tokenId: randomUUID(), scopes: ["requests:read"], surface: "api" };

/** The calls that reached execute(), and what the next one answers. */
let calls: { commandId: string; caller: Caller; input: unknown; origin: unknown }[];
let answer: (commandId: string) => Promise<unknown>;
let logged: LogEntry[];

const execute: Execute = async (commandId, caller, input, options) => {
  calls.push({ commandId, caller, input, origin: options?.origin });
  return answer(commandId);
};

/** The route, for calls made by this caller, or by nobody for null. */
function handler(authenticated: Caller | null = agent) {
  return createRestHandler({
    catalog,
    execute,
    authenticate: async () => authenticated ?? undefined,
    logger: createLogger({ write: (line) => logged.push(JSON.parse(line) as LogEntry) }),
  });
}

function call(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(`${INSTALL}${path}`, { method, ...init });
}

async function expectProblem(response: Response, status: number): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  const problem = (await response.json()) as Record<string, unknown>;
  expect(problem).toMatchObject({ status, title: expect.any(String), type: expect.any(String) });
  return problem;
}

beforeEach(() => {
  calls = [];
  logged = [];
  answer = async (commandId) => (commandId === "probes.get" ? { key: "FE-142" } : { messageId: "m1" });
});

describe("the REST route", () => {
  it("finds a GET operation by its path and builds its input from the path and the query", async () => {
    const response = await handler()(
      call("GET", "/api/v1/probes/FE-142?page=2", { headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "tiehall/0.1.0" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ key: "FE-142" });
    expect(calls).toEqual([
      {
        commandId: "probes.get",
        caller: agent,
        input: { key: "FE-142", page: "2" },
        origin: { ipAddress: "203.0.113.9", userAgent: "tiehall/0.1.0" },
      },
    ]);
  });

  it("builds a POST operation's input from its JSON body and its path, where the path wins", async () => {
    const response = await handler()(
      call("POST", "/api/v1/probes/FE%2D142/messages?ignored=1", {
        body: JSON.stringify({ body: "Which endpoint?", key: "OTHER-1" }),
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messageId: "m1" });
    expect(calls.map(({ commandId, input }) => ({ commandId, input }))).toEqual([
      { commandId: "probes.post", input: { body: "Which endpoint?", key: "FE-142" } },
    ]);
  });

  it("answers 404 for a path that serves no operation, without running anything", async () => {
    const paths: [string, string][] = [
      ["GET", "/api/v1/nothing-here"],
      ["GET", "/api/v1/probes"],
      ["GET", "/api/v1/probes/FE-142/"],
      ["GET", "/api/v1/probes/FE-142/messages"],
      ["DELETE", "/api/v1/probes/FE-142"],
      ["GET", "/api/v2/probes/FE-142"],
      ["GET", "/api/v1/probes/%E0%A4%A"],
    ];
    for (const [method, path] of paths) {
      const problem = await expectProblem(await handler()(call(method, path)), 404);
      expect(problem, `${method} ${path}`).toMatchObject({ status: 404 });
    }
    expect(calls).toEqual([]);
  });

  it("answers 404 for an operation not offered on REST, whoever calls it, without running it", async () => {
    for (const caller of [agent, null]) {
      await expectProblem(
        await handler(caller)(call("POST", "/api/v1/probes/FE-142/mcp-only", { body: "{}", headers: { "content-type": "application/json" } })),
        404,
      );
    }
    expect(calls).toEqual([]);
  });

  it("answers a call without credentials with 401 as a problem, once the path serves an operation", async () => {
    const response = await handler(null)(call("GET", "/api/v1/probes/FE-142"));
    await expectProblem(response, 401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(calls).toEqual([]);
  });

  it("returns a body that is not a JSON object as a 400 problem, without running anything", async () => {
    const bodies: [string, string][] = [
      ["{not json", "application/json"],
      ["[1, 2]", "application/json"],
      ["null", "application/json"],
      ["body=Which+endpoint", "application/x-www-form-urlencoded"],
    ];
    for (const [body, contentType] of bodies) {
      const response = await handler()(call("POST", "/api/v1/probes/FE-142/messages", { body, headers: { "content-type": contentType } }));
      const problem = await expectProblem(response, 400);
      expect(JSON.stringify(problem)).not.toContain("Which");
    }
    expect(calls).toEqual([]);
  });

  it("returns every refusal of execute() as a problem with its status", async () => {
    answer = async () => {
      throw new Refusal("invalid-input", "The input of probes.post does not match its schema.", {
        issues: [{ path: ["body"], message: "Invalid input: expected string, received number" }],
      });
    };
    const invalid = await expectProblem(
      await handler()(call("POST", "/api/v1/probes/FE-142/messages", { body: '{"body": 5}', headers: { "content-type": "application/json" } })),
      400,
    );
    expect(invalid).toMatchObject({
      detail: "The input of probes.post does not match its schema.",
      errors: [{ path: ["body"], message: "Invalid input: expected string, received number" }],
    });
    answer = async () => {
      throw new Refusal("forbidden", "Your part in this request does not allow this.");
    };
    await expectProblem(await handler()(call("GET", "/api/v1/probes/FE-142")), 403);
    answer = async () => {
      throw new Refusal("route-not-found", "There is no such operation here.");
    };
    await expectProblem(await handler()(call("GET", "/api/v1/probes/FE-142")), 404);
  });

  it("returns an unexpected failure as a 500 problem that says nothing about it, and logs it without its message", async () => {
    answer = async () => {
      throw new Error("connection to postgres://tiehall_app:hunter2@db failed while posting 'Which endpoint?'");
    };
    const problem = await expectProblem(await handler()(call("GET", "/api/v1/probes/FE-142")), 500);
    expect(JSON.stringify(problem)).not.toMatch(/postgres|hunter2|endpoint/);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "error", operationId: "probes.get", error: { name: "Error" } });
    expect(JSON.stringify(logged)).not.toMatch(/hunter2|Which endpoint/);
  });
});

describe("the catalog's REST paths", () => {
  it("start with /api/v1/, which a definition that breaks the rule fails", () => {
    for (const definition of CATALOG.commands.filter(({ surfaces }) => surfaces.includes("rest"))) {
      expect(definition.path, definition.id).toMatch(/^\/api\/v1\//);
    }
    const [first] = catalog.commands;
    expect(catalogProblems([{ ...first!, path: "/api/v2/probes/{key}" }])).toEqual([
      "probes.get: its path /api/v2/probes/{key} does not start with /api/v1/, where the API's major version 1 lives.",
    ]);
    expect(catalogProblems([{ ...first!, path: "/probes/{key}" }])).toEqual([
      "probes.get: its path /probes/{key} does not start with /api/v1/, where the API's major version 1 lives.",
    ]);
  });

  it("name each path parameter in the operation's input", () => {
    const [first] = catalog.commands;
    expect(catalogProblems([{ ...first!, path: "/api/v1/probes/{id}" }])).toEqual([
      "probes.get: its path names {id}, which is not a field of its input.",
    ]);
  });
});

import { API_PREFIX, type Catalog, type CommandDefinition } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import type { Caller } from "./caller.ts";
import type { Execute } from "./execute.ts";
import { createLogger, type Logger } from "./log.ts";

// The REST catch-all route under /api/v1 (public-api: Operations not offered on
// REST answer 404; public-api: Errors are RFC 9457 problem details; public-api:
// The major version is in the path; design.md, Technical decisions: T3). One
// route handler serves every operation the catalog offers on REST, so REST
// cannot drift from the other surfaces:
// - it finds the operation by method and path among the catalog's REST
//   operations; any other path, including one whose operation is not offered
//   on REST, answers 404 and runs nothing, whoever calls it;
// - it asks who is calling, and answers a call without credentials with 401;
// - it builds the input from the path's parameters and, for GET and DELETE,
//   the query string, or, for the other methods, the JSON object in the body,
//   where a path parameter wins over a body field of the same name;
// - it runs the operation through execute() and answers with its output as
//   JSON, or 202 for a commitment, which becomes a proposal;
// - it answers every error as an RFC 9457 problem, with the media type
//   application/problem+json. A failure that is not one of Tiehall's own
//   refusals answers 500 and says nothing about itself; the log records it by
//   its name and stack, never its message.

export interface RestOptions {
  catalog: Catalog;
  execute: Execute;
  /** Who is calling, from the call's credentials; undefined when it carries none that are valid. */
  authenticate(request: Request): Promise<Caller | undefined>;
  logger?: Logger;
}

export type RestHandler = (request: Request) => Promise<Response>;

interface Route {
  definition: CommandDefinition;
  pattern: RegExp;
  parameters: string[];
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** The reason phrase of each status Tiehall answers with, for a problem's title. */
const TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
};

export function createRestHandler(options: RestOptions): RestHandler {
  const logger = options.logger ?? createLogger();
  const routes = options.catalog.commands.filter(({ surfaces }) => surfaces.includes("rest")).map(routeOf);

  return async function handle(request) {
    const url = new URL(request.url);
    const found = resolve(routes, request.method, url.pathname);
    if (found === undefined) return problem(404, "There is no such operation here.");
    const { definition, parameters } = found;
    try {
      const caller = await options.authenticate(request);
      if (caller === undefined) {
        return problem(401, "This operation needs a token in the Authorization header.", {}, { "www-authenticate": "Bearer" });
      }
      const input = await inputOf(request, url, parameters);
      if (input === undefined) return problem(400, "The body of this operation is a JSON object, sent as application/json.");
      const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
      const userAgent = request.headers.get("user-agent") ?? undefined;
      const output = await options.execute(definition.id, caller, input, {
        origin: { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) },
      });
      return new Response(JSON.stringify(output), {
        status: definition.commitment ? 202 : 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (error) {
      if (error instanceof Refusal) {
        return problem(error.status, error.message, error.issues.length > 0 ? { errors: error.issues } : {});
      }
      logger.error("rest: the operation failed", { operationId: definition.id, error });
      return problem(500, "Tiehall could not complete this call.");
    }
  };
}

function routeOf(definition: CommandDefinition): Route {
  const parameters: string[] = [];
  const source = (definition.path ?? "")
    .split("/")
    .map((segment) => {
      const parameter = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment)?.[1];
      if (parameter === undefined) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      parameters.push(parameter);
      return "([^/]+)";
    })
    .join("/");
  return { definition, pattern: new RegExp(`^${source}$`), parameters };
}

/** The operation at this method and path, with the path's parameters, decoded; none when no REST operation is there. */
function resolve(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { definition: CommandDefinition; parameters: Record<string, string> } | undefined {
  if (!pathname.startsWith(API_PREFIX)) return undefined;
  for (const route of routes) {
    if (route.definition.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match === null) continue;
    const parameters: Record<string, string> = {};
    try {
      route.parameters.forEach((name, index) => {
        parameters[name] = decodeURIComponent(match[index + 1] ?? "");
      });
    } catch {
      // A path segment that is not valid percent-encoding names nothing.
      return undefined;
    }
    return { definition: route.definition, parameters };
  }
  return undefined;
}

/** The operation's input: the query or the JSON body, with the path's parameters; undefined for a body that is not a JSON object. */
async function inputOf(request: Request, url: URL, parameters: Record<string, string>): Promise<Record<string, unknown> | undefined> {
  if (!BODY_METHODS.has(request.method)) {
    const query: Record<string, string | string[]> = {};
    for (const name of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(name);
      query[name] = values.length === 1 ? (values[0] ?? "") : values;
    }
    return { ...query, ...parameters };
  }
  const text = await request.text();
  if (text.trim() === "") return { ...parameters };
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(mediaType)) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return { ...(body as Record<string, unknown>), ...parameters };
}

/** An RFC 9457 problem details response. Task 6.4 gives each of the error model's rows its problem type. */
function problem(status: number, detail: string, extensions: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  const body = { type: "about:blank", title: TITLES[status] ?? "Error", status, detail, ...extensions };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json", "cache-control": "no-store", ...headers },
  });
}
